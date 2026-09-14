import type { AppConfig } from '@shared/config'
import { isJsonObject, repairLlmArgs, sanitizeLlmArgs } from './args'
import { postJson } from './http'
import type { RunLog } from './log'
import { withTailInjection } from './messages'
import { claudeThinkingParams } from './thinking'
import type { ChatFn, ChatMessage, ChatResult, FetchLike, JsonObject, PendingCall } from './types'

/**
 * Claude Messages API 的一次调用（不执行工具）。从插件 ai-claude.ts 搬运并裁剪：
 * 本工程没有 web_search 服务端工具，所以没有 pause_turn 续跑。
 */
export function createClaudeChat(fetchFn: FetchLike, retryDelayMs = 3000): ChatFn {
  return async ({ config, apiKey, system, messages, tools, signal, log }) => {
    let working: ChatMessage[] = [...messages]
    // 尾部注入：放到上下文最末尾，比 system 字段更靠近模型的下一次输出（插件 docs/decisions.md「尾部注入」）
    if (config.tailInjectionEnabled) {
      const tail = config.tailInjection.trim()
      if (tail) {
        working = withTailInjection(working, tail, 'claude')
        log.info(`[尾部注入] 已注入 ${tail.length} 字符到上下文末尾`)
      }
    }

    const body: JsonObject = {
      model: config.model,
      max_tokens: config.maxTokens,
      // 空的系统提示词不发：默认文案目前是空的（规格 §14.1），发一个空串没有意义
      ...(system.trim() ? { system } : {}),
      messages: working,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
      ...claudeThinkingParams(config, log),
    }

    const data = await postJson(
      fetchFn,
      `${config.apiBaseUrl.trim().replace(/\/+$/, '')}/v1/messages`,
      { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body,
      { signal, timeoutMs: config.requestTimeoutSec * 1000, log, label: 'Claude API', model: config.model, retryDelayMs },
    )
    return parseClaudeResponse(data, config, log)
  }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function parseClaudeResponse(data: unknown, config: AppConfig, log: RunLog): ChatResult {
  if (!isJsonObject(data) || !Array.isArray(data.content)) {
    throw new Error(`Claude 接口返回的格式不对：${JSON.stringify(data).slice(0, 300)}`)
  }
  // 原样留存所有块（含 thinking / redacted_thinking），供下一轮原样回传
  const rawContent = (data.content as unknown[]).filter(isJsonObject)
  let text = ''
  const pendingCalls: PendingCall[] = []
  let thinkingBlocks = 0
  const tally: Record<string, number> = {}

  for (const block of rawContent) {
    const type = String(block.type)
    tally[type] = (tally[type] ?? 0) + 1
    if (type === 'thinking' || type === 'redacted_thinking') thinkingBlocks++
    if (type === 'text' && typeof block.text === 'string') {
      text += block.text
    } else if (type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      // repairLlmArgs 处理「参数标记 / JSON 文本混进某个字符串字段」——靠提示词压不住，一律在响应入口修
      const fixed = repairLlmArgs(sanitizeLlmArgs(isJsonObject(block.input) ? block.input : {}))
      for (const n of fixed.notes) log.warn(`[参数修复] ${block.name}: ${n}`)
      pendingCalls.push({ id: block.id, name: block.name, args: fixed.args })
    }
  }

  const usage = isJsonObject(data.usage) ? data.usage : {}
  const result: ChatResult = {
    text,
    pendingCalls,
    stopReason: typeof data.stop_reason === 'string' ? data.stop_reason : 'unknown',
    usage: { inputTokens: num(usage.input_tokens), outputTokens: num(usage.output_tokens) },
    rawContent,
  }

  if (config.thinkingEnabled) {
    // display 默认为 omitted，thinking 文本为空是正常的——块数 >0 就说明思考确实发生了
    log.info(`[thinking] 本轮 thinking 块 ${thinkingBlocks} 个`)
    if (thinkingBlocks === 0) log.warn('[thinking] 已启用但响应中没有 thinking 块——可能是模型不支持，或中转端点未透传')
  }
  log.info(
    `Claude 响应: stop_reason=${result.stopReason}, blocks=${JSON.stringify(tally)}, text=${text.length}字, ` +
      `tool_use=${pendingCalls.length}个, tokens=${result.usage.inputTokens}in/${result.usage.outputTokens}out`,
  )
  return result
}
