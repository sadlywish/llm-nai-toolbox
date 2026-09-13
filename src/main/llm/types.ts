import type { AppConfig } from '@shared/config'
import type { RunLog } from './log'

/** LLM 返回的 JSON 一律按这个收，逐项收窄。项目里不用 any */
export type JsonObject = Record<string, unknown>

/** 工具定义（内部通用格式；两个端点各自转成自己的 schema 形状） */
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: JsonObject
}

export interface PendingCall {
  id: string
  name: string
  /** 已经过 sanitizeLlmArgs + repairLlmArgs */
  args: JsonObject
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

export interface ChatResult {
  text: string
  pendingCalls: PendingCall[]
  /** end_turn / tool_use / max_tokens（Claude）或 stop / tool_calls / length（OpenAI） */
  stopReason: string
  usage: TokenUsage
  /** Claude：API 返回的原始 content 块，原样回传（thinking 块带 signature） */
  rawContent?: JsonObject[]
  /** OpenAI 兼容：API 返回的原始 assistant message（可能带 reasoning_content） */
  rawMessage?: JsonObject
}

/** 发给端点的一条消息。两个端点形状不同，内部统一按松散对象处理 */
export type ChatMessage = JsonObject

export interface ChatRequest {
  config: AppConfig
  apiKey: string
  system: string
  messages: readonly ChatMessage[]
  tools: readonly ToolDefinition[]
  signal: AbortSignal
  log: RunLog
}

/** 调一次端点。每一轮 LLM 交互新建一个（OpenAI 端点在一轮内记住「不认思维链参数」） */
export type ChatFn = (req: ChatRequest) => Promise<ChatResult>

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>
