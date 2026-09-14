import { describe, expect, it } from 'vitest'
import type { LlmLogLine } from '../../src/shared/llm'
import { LlmHttpError, LlmTimeoutError, postJson, summarizeErrorBody } from '../../src/main/llm/http'
import { RunLog } from '../../src/main/llm/log'
import type { FetchLike } from '../../src/main/llm/types'

type Step = Response | Error | ((init: RequestInit) => Promise<Response>)

function fakeFetch(steps: Step[]) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const step = steps[calls.length - 1]
    if (step === undefined) throw new Error('脚本用完了')
    if (step instanceof Error) throw step
    if (typeof step === 'function') return step(init)
    return step
  }
  return { fetchFn, calls }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

function setup(signal: AbortSignal = new AbortController().signal, timeoutMs = 5000, retryDelayMs = 1) {
  const lines: LlmLogLine[] = []
  const log = new RunLog((l) => lines.push(l))
  return { lines, opts: { signal, timeoutMs, log, label: 'Claude API', model: 'm', retryDelayMs } }
}

/** 等 signal 中止才 reject 的请求——模拟一个卡住的连接 */
const hang = (init: RequestInit): Promise<Response> =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  })

/** 完全不理 signal 的请求——模拟 net.fetch 不支持中止 */
const deaf = (): Promise<Response> => new Promise(() => undefined)

describe('summarizeErrorBody', () => {
  it('认得 {error:{type,message}}；认不出时截前 300 字', () => {
    expect(summarizeErrorBody('{"error":{"type":"authentication_error","message":"invalid x-api-key"}}')).toBe(
      'authentication_error: invalid x-api-key',
    )
    expect(summarizeErrorBody('{"error":{"message":"m"}}')).toBe('m')
    expect(summarizeErrorBody('x'.repeat(400))).toHaveLength(300)
  })
})

describe('postJson', () => {
  it('POST JSON，带上调用方给的头；每次尝试打一行 Calling', async () => {
    const { fetchFn, calls } = fakeFetch([json(200, { ok: 1 })])
    const { opts, lines } = setup()
    await expect(postJson(fetchFn, 'https://x/v1/messages', { 'x-api-key': 'k' }, { a: 1 }, opts)).resolves.toEqual({ ok: 1 })
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.body).toBe('{"a":1}')
    expect((calls[0].init.headers as Record<string, string>)['x-api-key']).toBe('k')
    expect(lines[0].text).toBe('Calling Claude API: model=m, attempt=1/3')
  })

  it('5xx 重试，成功即返回；重试写一行 W', async () => {
    const { fetchFn, calls } = fakeFetch([json(500, { error: { type: 'overloaded_error', message: 'x' } }), json(200, { ok: 1 })])
    const { opts, lines } = setup()
    await expect(postJson(fetchFn, 'u', {}, {}, opts)).resolves.toEqual({ ok: 1 })
    expect(calls).toHaveLength(2)
    expect(lines.find((l) => l.level === 'W')?.text).toContain('attempt 1 failed, retrying in 1ms: 500 overloaded_error: x')
  })

  it('4xx 不重试，抛 LlmHttpError', async () => {
    const { fetchFn, calls } = fakeFetch([json(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } })])
    const { opts } = setup()
    const err = await postJson(fetchFn, 'u', {}, {}, opts).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmHttpError)
    expect((err as LlmHttpError).status).toBe(401)
    expect((err as LlmHttpError).message).toBe('401 authentication_error: invalid x-api-key')
    expect(calls).toHaveLength(1)
  })

  it('网络错误重试到第 3 次仍失败就抛出原错误', async () => {
    const { fetchFn, calls } = fakeFetch([new Error('fetch failed'), new Error('fetch failed'), new Error('fetch failed')])
    const { opts } = setup()
    await expect(postJson(fetchFn, 'u', {}, {}, opts)).rejects.toThrow('fetch failed')
    expect(calls).toHaveLength(3)
  })

  it('超时抛 LlmTimeoutError，不重试', async () => {
    const { fetchFn, calls } = fakeFetch([hang, hang])
    const { opts } = setup(new AbortController().signal, 20)
    await expect(postJson(fetchFn, 'u', {}, {}, opts)).rejects.toBeInstanceOf(LlmTimeoutError)
    expect(calls).toHaveLength(1)
  })

  it('用户中止：即使请求本身不理 signal，也立刻返回，且不是超时', async () => {
    const ac = new AbortController()
    const { fetchFn } = fakeFetch([deaf])
    const { opts } = setup(ac.signal)
    const started = Date.now()
    setTimeout(() => ac.abort(), 20)
    const err = await postJson(fetchFn, 'u', {}, {}, opts).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(LlmTimeoutError)
    expect(ac.signal.aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('中止发生在重试等待期间：立刻返回', async () => {
    const ac = new AbortController()
    const { fetchFn, calls } = fakeFetch([json(503, {}), json(200, {})])
    const { opts } = setup(ac.signal, 5000, 10000)
    const started = Date.now()
    setTimeout(() => ac.abort(), 20)
    await expect(postJson(fetchFn, 'u', {}, {}, opts)).rejects.toBeDefined()
    expect(calls).toHaveLength(1)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('200 但不是 JSON：说清楚', async () => {
    const { fetchFn } = fakeFetch([new Response('<html>', { status: 200 })])
    const { opts } = setup()
    await expect(postJson(fetchFn, 'u', {}, {}, opts)).rejects.toThrow('Claude API 返回的不是 JSON：<html>')
  })
})
