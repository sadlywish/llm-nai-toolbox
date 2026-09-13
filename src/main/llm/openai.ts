import { parseExtraParams, type AppConfig } from '@shared/config'
import { isJsonObject, parseJsonLoose, repairLlmArgs, sanitizeLlmArgs } from './args'
import { LlmHttpError, postJson, type PostJsonOptions } from './http'
import type { RunLog } from './log'
import { withTailInjection } from './messages'
import { openaiReasoningParams } from './thinking'
import type { ChatFn, ChatMessage, ChatResult, FetchLike, JsonObject, PendingCall, ToolDefinition } from './types'

/**
 * OpenAI 兼容端点的一次调用（不执行工具）。从插件 ai-openai.ts 搬运，补上三件插件没有的事：
 * - 思维链参数按设置里的「参数写法」生成（thinking.ts）——各家写法互不相同；
 * - 附加请求参数原样合并进请求体，同名字段以它为准；
 * - 被端点以 400 拒绝时的三种自动退让，见 nextFallback。
 *
 * 每一轮 LLM 交互新建一个：退让过的形状在本轮后续请求里保持，免得每次请求都先吃一个 400 再重发。
 */

/** 被拒后可以自动退让的三件事。每件事一轮里最多退让一次 */
export interface OpenAIFallbacks {
  /** 端点不认思维链参数：不再发送 */
  dropReasoning: boolean
  /** 端点要求 max_completion_tokens（OpenAI 官方的推理模型不收 max_tokens）：改发它 */
  useMaxCompletionTokens: boolean
  /** 端点不收带回去的推理字段：从历史里剥掉 */
  stripEchoedReasoning: boolean
}

const FALLBACK_NOTES: Record<keyof OpenAIFallbacks, string> = {
  dropReasoning: '[thinking] 端点不认思维链参数，本轮起不再发送',
  useMaxCompletionTokens: '端点要求用 max_completion_tokens 代替 max_tokens，本轮起改发它',
  stripEchoedReasoning: '端点不收带回去的推理内容，本轮起不再带回',
}

export function createOpenAIChat(fetchFn: FetchLike, retryDelayMs = 3000): ChatFn {
  const fallbacks: OpenAIFallbacks = { dropReasoning: false, useMaxCompletionTokens: false, stripEchoedReasoning: false }

  return async ({ config, apiKey, system, messages, tools, signal, log }) => {
    let working: ChatMessage[] = system.trim() ? [{ role: 'system', content: system }, ...messages] : [...messages]
    if (config.tailInjectionEnabled) {
      const tail = config.tailInjection.trim()
      if (tail) {
        working = withTailInjection(working, tail, 'openai')
        log.info(`[尾部注入] 已注入 ${tail.length} 字符到上下文末尾`)
      }
    }

    const reasoning = fallbacks.dropReasoning ? {} : openaiReasoningParams(config, log)
    const extra = parseExtraParams(config.openaiExtraParams)
    const url = `${config.apiBaseUrl.trim().replace(/\/+$/, '')}/v1/chat/completions`
    const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    const opts: PostJsonOptions = {
      signal,
      timeoutMs: config.requestTimeoutSec * 1000,
      log,
      label: 'OpenAI API',
      model: config.model,
      retryDelayMs,
    }

    for (;;) {
      const body = buildOpenAIBody({
        config,
        messages: fallbacks.stripEchoedReasoning ? stripEchoedReasoning(working) : working,
        tools,
        reasoning: fallbacks.dropReasoning ? {} : reasoning,
        extra,
        useMaxCompletionTokens: fallbacks.useMaxCompletionTokens,
      })
      try {
        const data = await postJson(fetchFn, url, headers, body, opts)
        return parseOpenAIResponse(data, config, log)
      } catch (e) {
        if (!(e instanceof LlmHttpError) || e.status !== 400) throw e
        const next = nextFallback(e.body, fallbacks, Object.keys(reasoning).length > 0, working)
        if (next === null) throw e
        fallbacks[next] = true
        log.warn(`${FALLBACK_NOTES[next]}（${e.message}），重新请求`)
      }
    }
  }
}

export interface OpenAIBodyParts {
  config: AppConfig
  messages: readonly ChatMessage[]
  tools: readonly ToolDefinition[]
  reasoning: JsonObject
  extra: Record<string, unknown>
  useMaxCompletionTokens: boolean
}

/** 请求体 = 基本字段 + 思维链参数 + 附加请求参数（同名字段以附加参数为准） */
export function buildOpenAIBody(p: OpenAIBodyParts): JsonObject {
  const limitKey = p.useMaxCompletionTokens || 'max_completion_tokens' in p.extra ? 'max_completion_tokens' : 'max_tokens'
  return {
    model: p.config.model,
    messages: p.messages,
    tools: p.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
    [limitKey]: p.config.maxTokens,
    ...p.reasoning,
    ...p.extra,
  }
}

function hasEchoedReasoning(history: readonly ChatMessage[]): boolean {
  return history.some(
    (m) =>
      m.role === 'assistant' &&
      (m.reasoning_content !== undefined ||
        m.reasoning_details !== undefined ||
        (Array.isArray(m.tool_calls) && (m.tool_calls as unknown[]).some((tc) => isJsonObject(tc) && tc.extra_content !== undefined))),
  )
}

/** 去掉历史 assistant 消息里带回去的推理字段。返回新数组，不改动调用方持有的消息 */
export function stripEchoedReasoning(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== 'assistant') return m
    const copy: ChatMessage = { ...m }
    delete copy.reasoning_content
    delete copy.reasoning_details
    if (Array.isArray(copy.tool_calls)) {
      copy.tool_calls = (copy.tool_calls as unknown[]).map((tc) => {
        if (!isJsonObject(tc)) return tc
        const call: JsonObject = { ...tc }
        delete call.extra_content
        return call
      })
    }
    return copy
  })
}

/**
 * 400 的报错里点名了哪个参数，就退让哪一件；认不出返回 null（照常抛错）。
 * 判断顺序有讲究：`reasoning_content` / `reasoning_details` 的名字里也含 reasoning，必须先于思维链参数判断。
 */
export function nextFallback(
  body: string,
  done: OpenAIFallbacks,
  sentReasoning: boolean,
  history: readonly ChatMessage[],
): keyof OpenAIFallbacks | null {
  if (!done.useMaxCompletionTokens && /max_tokens/.test(body) && /max_completion_tokens/.test(body)) {
    return 'useMaxCompletionTokens'
  }
  if (!done.stripEchoedReasoning && /reasoning_content|reasoning_details|extra_content/.test(body) && hasEchoedReasoning(history)) {
    return 'stripEchoedReasoning'
  }
  if (!done.dropReasoning && sentReasoning && /reasoning|thinking/i.test(body)) return 'dropReasoning'
  return null
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * 工具参数通常是 JSON 字符串；有的兼容端点直接给对象、或给空串。
 * 插件直接 JSON.parse，坏一个字符整轮就失败；这里先尽力抢救，救不回来返回 null。
 */
export function parseToolArguments(raw: unknown): JsonObject | null {
  if (isJsonObject(raw)) return raw
  if (typeof raw !== 'string') return null
  if (raw.trim() === '') return {}
  try {
    const v: unknown = JSON.parse(raw)
    return isJsonObject(v) ? v : null
  } catch {
    const v = parseJsonLoose(raw)
    return isJsonObject(v) ? v : null
  }
}

export function parseOpenAIResponse(data: unknown, config: AppConfig, log: RunLog): ChatResult {
  const choices = isJsonObject(data) && Array.isArray(data.choices) ? (data.choices as unknown[]) : []
  const choice = choices[0]
  if (!isJsonObject(choice) || !isJsonObject(choice.message)) {
    throw new Error(`OpenAI 接口返回的格式不对：${JSON.stringify(data).slice(0, 300)}`)
  }
  const msg = choice.message
  const text = typeof msg.content === 'string' ? msg.content : ''
  const pendingCalls: PendingCall[] = []
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls as unknown[]) {
      if (!isJsonObject(tc) || !isJsonObject(tc.function)) continue
      const name = String(tc.function.name ?? '')
      const parsed = parseToolArguments(tc.function.arguments)
      if (parsed === null) {
        throw new Error(`模型给 ${name} 的参数不是合法 JSON：${String(tc.function.arguments).slice(0, 200)}`)
      }
      const fixed = repairLlmArgs(sanitizeLlmArgs(parsed))
      for (const n of fixed.notes) log.warn(`[参数修复] ${name}: ${n}`)
      pendingCalls.push({ id: String(tc.id ?? ''), name, args: fixed.args })
    }
  }
  const usage = isJsonObject(data) && isJsonObject(data.usage) ? data.usage : {}
  const result: ChatResult = {
    text,
    pendingCalls,
    stopReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : 'unknown',
    usage: { inputTokens: num(usage.prompt_tokens), outputTokens: num(usage.completion_tokens) },
    rawMessage: msg,
  }
  if (config.thinkingEnabled) {
    // 各家推理文本的字段名不同：DeepSeek / 通义 / 智谱 / Kimi 用 reasoning_content，vLLM 与 OpenRouter 用 reasoning；
    // OpenAI 官方的 Chat Completions 不返回推理文本，这里就是 0 字
    const thought =
      typeof msg.reasoning_content === 'string' ? msg.reasoning_content : typeof msg.reasoning === 'string' ? msg.reasoning : ''
    log.info(`[thinking] 本轮推理内容 ${thought.length} 字`)
  }
  log.info(
    `OpenAI 响应: finish_reason=${result.stopReason}, text=${text.length}字, tool_calls=${pendingCalls.length}个, ` +
      `tokens=${result.usage.inputTokens}in/${result.usage.outputTokens}out`,
  )
  return result
}
