// 手机端访问桌面端 HTTP 服务的唯一出口（计划 Task 11）。
//
// 只 import @shared/* 的纯类型与纯函数：手机端与桌面端渲染进程不共用组件、store 与 electron，
// 这个文件里出现任何一个 electron/zustand 的名字都说明抄错了地方。
import type { GenStartInput, RoundRecord } from '@shared/gen'
import type { LlmRunInput } from '@shared/llm'
import type {
  ApiError,
  ApiErrorKind,
  GenRunStarted,
  LlmRunStarted,
  MobileEvent,
  MobileLastLlmResult,
  MobileMeta,
  MobileStylesResult,
  PairResult,
} from '@shared/mobileApi'
import type { NaiSubscriptionResult } from '@shared/naiUser'
import type { StylePreset } from '@shared/styles'

/**
 * 连不上电脑时自己造的那句话。服务端给的 message 都是能直接显示的中文（Global Constraints），
 * 网络层失败没有服务端可问，只能由客户端补一句同样能直接显示的。
 */
export const NETWORK_FAILURE_MESSAGE = '连不上电脑，检查是不是还在同一个 WiFi'

/**
 * 所有请求失败都是这一种异常，界面上 `catch (e)` 后直接 `String(e)` 就有中文可显示。
 * `error.kind` 留给需要分流的地方用（401 要清连接信息、409 要提示稍后再试）。
 */
export class ApiFailure extends Error {
  constructor(readonly error: ApiError) {
    super(error.message)
    this.name = 'ApiFailure'
  }
}

/**
 * 任何失败翻成一句能直接显示的中文。ApiFailure 里的是服务端原话（Global Constraints：
 * 错误形状统一，message 可直接显示），原样用——被 409 挡回来时显示的就是电脑那头那句话。
 */
export function messageOf(err: unknown): string {
  if (err instanceof ApiFailure) return err.error.message
  return err instanceof Error && err.message !== '' ? err.message : '出了点问题，稍后再试'
}

export interface ApiClient {
  pair(code: string, deviceName: string): Promise<PairResult>
  meta(): Promise<MobileMeta>
  styles(): Promise<MobileStylesResult>
  /**
   * 画风增删改排序（计划 Task 17）：与桌面端共用同一份 styles.json，写操作成功后
   * 由调用方（Styles 页）自己重新拉一次 `styles()` 刷新列表，这里不维护本地缓存。
   */
  createStyle(name: string, tags: string): Promise<StylePreset>
  patchStyle(id: string, patch: { name?: string; tags?: string }): Promise<StylePreset>
  deleteStyle(id: string): Promise<void>
  /** 按给定顺序整体重排；服务端会校验 ids 与现有集合一一对应 */
  reorderStyles(ids: string[]): Promise<StylePreset[]>
  /** 选为预设：这是唯一一条会同时改桌面端工作区的手机接口（Global Constraints） */
  setPresetStyle(id: string): Promise<void>
  history(days?: number): Promise<RoundRecord[]>
  usage(): Promise<NaiSubscriptionResult>
  /** 开跑就回，日志与结果走 SSE；runId 用来认领 `llm-finished` 与 `GET /api/llm/last` */
  llmRun(input: LlmRunInput): Promise<LlmRunStarted>
  llmAbort(): Promise<void>
  /** 断线期间跑完的那一轮：重连后查一次，runId 对得上就把回填补上 */
  llmLast(): Promise<MobileLastLlmResult>
  /** 开跑就回，进度与每张图走 SSE；roundId 用来对上历史里的那一轮 */
  genStart(input: GenStartInput): Promise<GenRunStarted>
  genCancel(): Promise<void>
  genResume(): Promise<void>
  imageUrl(round: string, file: string, size: 'thumb' | 'full'): string
  /** EventSource，返回关闭函数；onStatus 报连上/断开，给顶部那个状态点用 */
  events(onEvent: (e: MobileEvent) => void, onStatus?: (connected: boolean) => void): () => void
}

/**
 * 用户在连接页里手打的地址补成一个能拼路径的 base：
 * 只写 `192.168.1.8:7321` 是最常见的写法，末尾的斜杠也得去掉，否则拼出来是 `//api/meta`。
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  return withScheme.replace(/\/+$/, '')
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const ERROR_KINDS: readonly ApiErrorKind[] = ['unauthorized', 'busy', 'bad-request', 'not-found', 'server']

/** 状态码到 kind 的兜底映射：服务端给了 `{ error }` 就用它的，没给（代理、别的软件占了端口）才落到这里 */
function kindOfStatus(status: number): ApiErrorKind {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 409) return 'busy'
  if (status === 400) return 'bad-request'
  if (status === 404) return 'not-found'
  return 'server'
}

/**
 * 把一个非 2xx 的响应翻成 ApiFailure。
 *
 * 响应体不一定是 JSON：局域网里这个端口上可能蹲着路由器管理页、别的应用，甚至一个返回 HTML 的
 * 反代。那时 `res.json()` 抛的是 SyntaxError，漏出去界面上只会显示一句英文，所以一律接住。
 */
async function failureOf(res: Response): Promise<ApiFailure> {
  const fallback = kindOfStatus(res.status)
  try {
    const body: unknown = await res.json()
    const err = isRecord(body) && isRecord(body.error) ? body.error : null
    if (err !== null && typeof err.message === 'string') {
      return new ApiFailure({ kind: ERROR_KINDS.find((k) => k === err.kind) ?? fallback, message: err.message })
    }
  } catch {
    /* 不是 JSON：按状态码给一句能显示的中文 */
  }
  return new ApiFailure({ kind: fallback, message: `电脑那头返回了 ${res.status}，稍后再试` })
}

/**
 * @param baseUrl 已经过 `normalizeBaseUrl` 的地址
 * @param token   配对换来的长期令牌；配对本身还没有令牌，传空串
 * @param onUnauthorized 令牌失效（任何请求回 401）时通知调用方去清本地连接信息。
 *   做成回调而不是让每个调用点自己判断：401 可能从任何一条请求上回来，漏掉一处就会卡在一个
 *   永远刷不出内容的页面上。配对用的那个客户端不传它——配对码打错也是 401，那不是令牌失效。
 */
export function createApiClient(baseUrl: string, token: string, onUnauthorized?: () => void): ApiClient {
  const base = normalizeBaseUrl(baseUrl)

  async function request<T>(path: string, init: RequestInit = {}, withAuth = true): Promise<T> {
    const headers = new Headers(init.headers)
    if (withAuth && token !== '') headers.set('Authorization', `Bearer ${token}`)
    if (init.body !== undefined) headers.set('Content-Type', 'application/json; charset=utf-8')
    let res: Response
    try {
      res = await fetch(`${base}${path}`, { ...init, headers })
    } catch {
      // fetch 只在网络层失败时 reject（没连上、WiFi 换了、电脑睡了）；HTTP 层的错都走下面
      throw new ApiFailure({ kind: 'server', message: NETWORK_FAILURE_MESSAGE })
    }
    if (!res.ok) {
      const failure = await failureOf(res)
      if (failure.error.kind === 'unauthorized') onUnauthorized?.()
      throw failure
    }
    // 204 与空体在这些接口上不会出现（服务端一律回 JSON），真出现了当 undefined 给回去
    return (await res.json().catch(() => undefined)) as T
  }

  function post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>(path, { method: 'POST', body: body === undefined ? '{}' : JSON.stringify(body) })
  }

  return {
    pair(code, deviceName) {
      // 配对是拿令牌的唯一入口，它本身不带令牌（服务端也只对这条路径放行）
      return request<PairResult>('/api/pair', { method: 'POST', body: JSON.stringify({ code, deviceName }) }, false)
    },
    meta: () => request<MobileMeta>('/api/meta'),
    styles: () => request<MobileStylesResult>('/api/styles'),

    createStyle: (name, tags) => post<StylePreset>('/api/styles', { name, tags }),
    patchStyle: (id, patch) =>
      request<StylePreset>(`/api/styles/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    // 204/void 接口一样过 request()：204 与空体在这些接口上不会出现（见上面 request 里的注释），
    // 服务端一律回 JSON（{ ok: true } / { presetId }），这里只是不把那个值透出去
    deleteStyle: (id) => request<{ ok: true }>(`/api/styles/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => undefined),
    reorderStyles: (ids) => post<{ styles: StylePreset[] }>('/api/styles/order', { ids }).then((r) => r.styles),
    setPresetStyle: (id) => post<{ presetId: string }>(`/api/styles/${encodeURIComponent(id)}/preset`).then(() => undefined),

    history: (days) => request<RoundRecord[]>(`/api/history${days === undefined ? '' : `?days=${days}`}`),
    usage: () => request<NaiSubscriptionResult>('/api/usage'),
    llmRun: (input) => post<LlmRunStarted>('/api/llm/run', input),
    llmAbort: () => post<void>('/api/llm/abort'),
    llmLast: () => request<MobileLastLlmResult>('/api/llm/last'),
    genStart: (input) => post<GenRunStarted>('/api/gen/start', input),
    genCancel: () => post<void>('/api/gen/cancel'),
    genResume: () => post<void>('/api/gen/resume'),

    imageUrl(round, file, size) {
      // token 必须进查询串：这个地址是塞进 <img src> 用的，带不了 Authorization 头
      // （服务端 http.ts 的 TOKEN_QUERY_PATHS 对 /api/image 与 /api/events 这两条放行）
      const q = new URLSearchParams({ round, file, size, token })
      // URLSearchParams 把空格编成 '+'，而服务端拿 searchParams 解回来是一样的；
      // 这里仍统一成 %20，免得 URL 贴进日志或反馈时看起来像两个参数
      return `${base}/api/image?${q.toString().replace(/\+/g, '%20')}`
    },

    events(onEvent, onStatus) {
      // EventSource 带不了自定义请求头，令牌只能走查询串（服务端 http.ts 只对这一条路径放行）
      const source = new EventSource(`${base}/api/events?token=${encodeURIComponent(token)}`)
      source.onopen = () => onStatus?.(true)
      // 浏览器自己会重连，不用在这里重建；断开期间先把状态点变红
      source.onerror = () => onStatus?.(false)
      source.onmessage = (e) => {
        try {
          onEvent(JSON.parse(e.data) as MobileEvent)
        } catch {
          // 心跳是注释行，到不了这里；真解析不了的只能是版本对不上的事件，丢掉比崩掉强
        }
      }
      return () => source.close()
    },
  }
}
