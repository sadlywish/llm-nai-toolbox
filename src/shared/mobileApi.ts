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
  tokenLimit: number
  /** 只给目录名用于展示，不给完整路径 */
  saveDirName: string
  busy: { llm: boolean; gen: boolean }
}

export interface MobileStylesResult {
  styles: StylePreset[]
  presetId: string
}

/**
 * SSE 推给手机端的事件。与主进程内部的 `AppEvent`/`LlmEvent`（Task 2）不是同一套类型——
 * 这里只挑手机端用得上的字段，密钥与桌面专属信息不经过这条通道。
 */
export type MobileEvent =
  | { kind: 'llm-log'; line: LlmLogLine }
  | { kind: 'llm-round'; round: number; maxRounds: number }
  | { kind: 'llm-finished'; result: LlmRunResult }
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
