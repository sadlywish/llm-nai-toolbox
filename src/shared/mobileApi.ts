import type { FieldSpec } from './fields'
import type { GenImageEvent, RunProgress } from './gen'
import type { LlmLogLine, LlmRunResult } from './llm'
import type { StylePreset } from './styles'

/**
 * 手机端与桌面端服务共用的请求/响应类型、错误形状、SSE 事件类型（计划 §Task 1）。
 *
 * 这个文件不 import electron、不 import 任何主进程模块：手机前端与主进程服务都要引用它，
 * 服务端测试也要能在 Node 里单独跑（Task 4 起）。
 */

/** 手机端与服务端的接口版本；改动不兼容的接口形状时才递增，前端据此提示「请升级」 */
export const MOBILE_API_VERSION = 1

export type ApiErrorKind = 'unauthorized' | 'busy' | 'bad-request' | 'not-found' | 'server'

export interface ApiError {
  kind: ApiErrorKind
  /** 可直接显示的中文一句话（Global Constraints：错误形状统一） */
  message: string
}

export interface ApiErrorBody {
  error: ApiError
}

/** 构造统一形状的错误体，路由层直接 JSON 化返回 */
export function apiError(kind: ApiErrorKind, message: string): ApiErrorBody {
  return { error: { kind, message } }
}

export interface PairInput {
  code: string
  deviceName: string
}

export interface PairResult {
  token: string
  deviceName: string
}

/**
 * `GET /api/meta`：手机端渲染所需的静态信息，一次性给全，避免手机端另起接口猜字段集与上限。
 * 不含任何密钥——`saveDirName` 只给目录名用于展示，不给完整路径（Global Constraints）。
 */
export interface MobileMeta {
  apiVersion: number
  appVersion: number | string
  /** 已按 promptOrder 排好 */
  mainFields: FieldSpec[]
  /** 已按 naiCharPromptOrder 排好 */
  charFields: FieldSpec[]
  models: string[]
  samplers: readonly string[]
  noiseSchedules: readonly string[]
  maxCharacters: number
  maxPixels: number
  /** 每张消耗的额度百分比（配置 naiUsagePercentPerImage），供手机端把 V5 用量换算成「约还能出几张」；0 = 不估算 */
  usagePercentPerImage: number
  /** 只给目录名用于展示，不给完整路径 */
  saveDirName: string
  busy: { llm: boolean; gen: boolean }
}

/** `POST /api/gen/start` 的回话：开跑就回，进度与每张图走 SSE，roundId 用来对上历史里的那一轮 */
export interface GenRunStarted {
  roundId: string
}

export interface MobileStylesResult {
  styles: StylePreset[]
  presetId: string
}

/** `POST /api/llm/run` 的回话：开跑就回，这一轮的进度与结果走 SSE，靠 runId 对号 */
export interface LlmRunStarted {
  runId: string
}

/**
 * 最近一次跑完的那一轮。手机锁屏、切后台、走出路由器范围都会把 SSE 断掉，断线期间跑完的话
 * `llm-finished` 就永远收不到了——`GET /api/llm/last` 把它兜回来，手机对上 runId 就能补应用回填。
 */
export interface MobileLastLlmRun {
  runId: string
  /** ISO 时间串 */
  finishedAt: string
  result: LlmRunResult
}

/** `GET /api/llm/last`：服务端起来之后还没跑过任何一轮时 last 为 null */
export interface MobileLastLlmResult {
  last: MobileLastLlmRun | null
}

/**
 * SSE 推给手机端的事件。与主进程内部的 `AppEvent`/`LlmEvent`（Task 2）不是同一套类型——
 * 这里只挑手机端用得上的字段，密钥与桌面专属信息不经过这条通道。
 */
export type MobileEvent =
  | { kind: 'llm-log'; line: LlmLogLine }
  | { kind: 'llm-round'; round: number; maxRounds: number }
  /** runId 与 `POST /api/llm/run` 的回话对得上：手机据此分辨这是不是自己发的那一轮，也用来判断有没有应用过 */
  | { kind: 'llm-finished'; runId: string; result: LlmRunResult }
  | { kind: 'gen-progress'; progress: RunProgress }
  | { kind: 'gen-image'; image: GenImageEvent }
  | { kind: 'busy'; busy: { llm: boolean; gen: boolean } }

/**
 * 请求来源是否环回或私有网段（Global Constraints：只服务局域网）。
 *
 * IPv4-mapped 地址（Node 的 `req.socket.remoteAddress` 在双栈监听时常见地给出 `::ffff:127.0.0.1`
 * 这种形式）先剥掉 `::ffff:` 前缀再按 IPv4 规则判断。
 */
export function isPrivateAddress(addr: string | undefined): boolean {
  if (!addr) return false
  const a = addr.replace(/^::ffff:/i, '')
  if (a === '::1' || a === 'localhost') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a)
  if (!m) return false
  const [x, y] = [Number(m[1]), Number(m[2])]
  if (x === 127 || x === 10) return true
  if (x === 192 && y === 168) return true
  return x === 172 && y >= 16 && y <= 31
}
