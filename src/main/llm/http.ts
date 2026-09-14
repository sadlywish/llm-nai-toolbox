import type { RunLog } from './log'
import type { FetchLike } from './types'

/** 接口回了非 2xx。message 形如 `401 authentication_error: invalid x-api-key` */
export class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`${status} ${summarizeErrorBody(body)}`)
    this.name = 'LlmHttpError'
  }
}

export class LlmTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`)
    this.name = 'LlmTimeoutError'
  }
}

/** Anthropic 与 OpenAI 的错误体都是 `{error:{type?, message}}`；认不出就截前 300 字原样给 */
export function summarizeErrorBody(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed === 'object' && parsed !== null) {
      const err = (parsed as Record<string, unknown>).error
      if (typeof err === 'object' && err !== null) {
        const e = err as Record<string, unknown>
        const type = typeof e.type === 'string' ? e.type : ''
        const message = typeof e.message === 'string' ? e.message : ''
        if (type && message) return `${type}: ${message}`
        if (type || message) return type || message
      }
    }
  } catch {
    // 不是 JSON，按原文截断
  }
  return body.slice(0, 300)
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 让 promise 在 signal 中止时立刻 reject。
 *
 * 不全靠把 signal 交给 fetch：Electron 的 net.fetch 对 signal 的支持没有在本工程实测过，
 * 万一它不理会，「中止」也必须当场生效，而不是等请求自己超时。
 */
export function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

/** 可被中止的等待（重试间隔用）。中止时连计时器一起清掉，不留一个几秒后才触发的空转定时器 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export interface PostJsonOptions {
  /** 用户的「中止」 */
  signal: AbortSignal
  /** 单次尝试的超时 */
  timeoutMs: number
  log: RunLog
  /** 日志里的接口名，如 "Claude API" */
  label: string
  model: string
  /** 默认 3 */
  retries?: number
  /** 默认 3000 */
  retryDelayMs?: number
}

/**
 * POST 一个 JSON 并解析响应。照插件 ai-claude.ts / ai-openai.ts 的重试规则：
 * 网络错误与 5xx 重试（共 3 次，间隔 3 秒），其余 HTTP 错误直接抛。
 *
 * 与插件的差别：超时**不重试**。插件把超时也当网络错误重试，默认 120 秒超时就要白等 6 分钟；
 * 超时多半是代理或网络本身的问题，重试解决不了，用户要改的是设置。
 */
export async function postJson(
  fetchFn: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: PostJsonOptions,
): Promise<unknown> {
  const retries = opts.retries ?? 3
  const delay = opts.retryDelayMs ?? 3000
  const payload = JSON.stringify(body)

  for (let attempt = 1; ; attempt++) {
    opts.log.info(`Calling ${opts.label}: model=${opts.model}, attempt=${attempt}/${retries}`)
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), opts.timeoutMs)
    const signal = AbortSignal.any([opts.signal, timeout.signal])
    let status: number
    let ok: boolean
    let text: string
    try {
      const res = await raceAbort(fetchFn(url, { method: 'POST', headers, body: payload, signal }), signal)
      status = res.status
      ok = res.ok
      text = await raceAbort(res.text(), signal)
    } catch (e) {
      if (opts.signal.aborted) throw e
      if (timeout.signal.aborted) throw new LlmTimeoutError(opts.timeoutMs)
      if (attempt >= retries) throw e
      opts.log.warn(`${opts.label} attempt ${attempt} failed, retrying in ${delay}ms: ${errorMessage(e)}`)
      await sleep(delay, opts.signal)
      continue
    } finally {
      clearTimeout(timer)
    }

    if (!ok) {
      if (status >= 500 && attempt < retries) {
        opts.log.warn(`${opts.label} attempt ${attempt} failed, retrying in ${delay}ms: ${status} ${summarizeErrorBody(text)}`)
        await sleep(delay, opts.signal)
        continue
      }
      throw new LlmHttpError(status, text)
    }
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error(`${opts.label} 返回的不是 JSON：${text.slice(0, 300)}`)
    }
  }
}
