import type { ApiType } from '@shared/config'
import { isJsonObject } from './args'
import type { ChatMessage, ChatResult, JsonObject } from './types'

/** 首条用户消息。形状照插件 index.ts 第 2160–2182 行（本工程不附图） */
export function userMessage(apiType: ApiType, text: string): ChatMessage {
  return apiType === 'claude' ? { role: 'user', content: [{ type: 'text', text }] } : { role: 'user', content: text }
}

/**
 * 在上下文末尾注入「尾部提示词」。插件 utils.ts 第 239–282 行。
 *
 * 为什么放 messages 末尾而不是 system 字段：
 * 尾部注入的价值就在于「离模型下一次输出最近」。系统提示词在上下文头部，
 * 经过多轮 tool_result 之后权重会被稀释；放在最末尾的指令则不会。
 *
 * 两种后端的表达方式不同：
 * - openai：直接追加一条 { role: 'system' } 消息
 * - claude：Messages API 没有 system 角色。此时把注入文本作为独立的 text block
 *   追加到最后一条 user 消息的 content 末尾（Anthropic 要求 tool_result block
 *   排在前面，其后追加 text 是合法的）；若最后一条不是 user 消息则新起一条。
 *
 * 始终返回新数组，被改动的那条消息也做浅层重建——调用方持有的 messages
 * 会在多轮 tool 循环中反复复用，就地修改会导致注入逐轮叠加。
 */
export function withTailInjection(messages: readonly ChatMessage[], text: string, mode: ApiType): ChatMessage[] {
  const injected = String(text || '').trim()
  if (!injected) return messages as ChatMessage[]

  if (mode === 'openai') return [...messages, { role: 'system', content: injected }]

  const last = messages[messages.length - 1]
  if (last === undefined || last.role !== 'user') {
    return [...messages, { role: 'user', content: [{ type: 'text', text: injected }] }]
  }
  const blocks: unknown[] = []
  const content = last.content
  if (Array.isArray(content)) {
    blocks.push(...(content as unknown[]))
  } else {
    // 字符串 content 展开为块数组；空串不产生空 text 块（Anthropic 会拒绝）
    const t = String(content ?? '').trim()
    if (t) blocks.push({ type: 'text', text: t })
  }
  blocks.push({ type: 'text', text: injected })
  return [...messages.slice(0, -1), { ...last, content: blocks }]
}

/**
 * Claude 的 assistant 轮次 content。插件 utils.ts 第 284–318 行。
 *
 * 优先**原样回传** API 返回的 content 块：thinking 块带 signature，Anthropic 校验它在下一轮
 * 原封不动，从 text + tool_use 重建会丢掉它，第二轮直接 400。
 * 唯一的改写是 tool_use 的 input 换成清洗过的版本——signature 只覆盖 thinking 块本身；
 * 保留转义版本会让模型在后续轮次照抄自己的错误格式。
 */
export function buildAssistantContent(result: ChatResult): JsonObject[] {
  if (Array.isArray(result.rawContent) && result.rawContent.length > 0) {
    const sanitized = new Map(result.pendingCalls.map((pc) => [pc.id, pc.args]))
    return result.rawContent.map((block) =>
      block.type === 'tool_use' && typeof block.id === 'string' && sanitized.has(block.id)
        ? { ...block, input: sanitized.get(block.id) }
        : block,
    )
  }
  const content: JsonObject[] = []
  if (result.text) content.push({ type: 'text', text: result.text })
  for (const pc of result.pendingCalls) content.push({ type: 'tool_use', id: pc.id, name: pc.name, input: pc.args })
  return content
}

/**
 * OpenAI 兼容端点的 assistant 轮次。
 *
 * 插件重建成 `{ role, content: null, tool_calls }`。这里多带回续接推理所需的原始内容——
 * 与 Claude 路径「原样回传」是同一个原则，各家要求在工具往返里带回的东西不同（2026-09 核对各家文档）：
 * - `reasoning_content`：DeepSeek（请求带工具时必须回传，否则 400）、智谱、Kimi、通义
 * - `reasoning_details`：OpenRouter（要求原样、按原顺序带回）
 * - `tool_calls[].extra_content`：Gemini 的 thought_signature，缺了下一轮 400
 *
 * 只带这三样，不整条照搬：明文 `reasoning`、`annotations`、`refusal` 这类字段没有续接作用，
 * 带回去反而可能被较严格的端点当成不认识的字段拒掉。端点不收这三样时，openai.ts 会剥掉重发。
 */
export function buildOpenAIAssistant(result: ChatResult): ChatMessage {
  const raw = result.rawMessage
  const rawCalls = new Map<string, JsonObject>()
  if (raw !== undefined && Array.isArray(raw.tool_calls)) {
    for (const tc of raw.tool_calls as unknown[]) {
      if (isJsonObject(tc) && typeof tc.id === 'string') rawCalls.set(tc.id, tc)
    }
  }
  const msg: ChatMessage = {
    role: 'assistant',
    content: typeof raw?.content === 'string' ? raw.content : null,
    tool_calls: result.pendingCalls.map((pc) => {
      const call: JsonObject = { id: pc.id, type: 'function', function: { name: pc.name, arguments: JSON.stringify(pc.args) } }
      const extraContent = rawCalls.get(pc.id)?.extra_content
      if (extraContent !== undefined) call.extra_content = extraContent
      return call
    }),
  }
  if (typeof raw?.reasoning_content === 'string') msg.reasoning_content = raw.reasoning_content
  if (Array.isArray(raw?.reasoning_details)) msg.reasoning_details = raw.reasoning_details
  return msg
}

export interface ToolOutput {
  id: string
  content: string
}

/** 把一轮工具调用与本地执行结果追加进上下文。插件 index.ts 第 2420–2470 行 */
export function appendToolRound(
  messages: ChatMessage[],
  apiType: ApiType,
  result: ChatResult,
  outputs: readonly ToolOutput[],
): void {
  if (apiType === 'claude') {
    messages.push({ role: 'assistant', content: buildAssistantContent(result) })
    messages.push({
      role: 'user',
      content: outputs.map((o) => ({ type: 'tool_result', tool_use_id: o.id, content: o.content })),
    })
    return
  }
  messages.push(buildOpenAIAssistant(result))
  for (const o of outputs) messages.push({ role: 'tool', tool_call_id: o.id, content: o.content })
}

export const TRUNCATION_RETRY_TEXT = '你的回复被截断了，请直接调用工具，不要输出多余文本。'

/** 响应被 max_tokens 截断且没有工具调用：回放文本并要求直接调用工具。插件 index.ts 第 2252–2262 行 */
export function appendTruncationRetry(messages: ChatMessage[], result: ChatResult): void {
  if (result.text) messages.push({ role: 'assistant', content: result.text })
  messages.push({ role: 'user', content: TRUNCATION_RETRY_TEXT })
}
