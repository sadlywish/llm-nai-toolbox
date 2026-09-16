import { describe, expect, it } from 'vitest'
import { fetchSubscription, type NaiUserOptions } from '../../../src/main/nai/user'

const body = {
  tier: 3,
  active: true,
  trainingStepsLeft: { fixedTrainingStepsLeft: 8000, purchasedTrainingSteps: 4345 },
  usage: { percent: 87, timeUntilNextPercent: 312, isNegative: false },
}

function opts(fetchImpl: typeof fetch, over: Partial<NaiUserOptions> = {}): NaiUserOptions {
  return { baseUrl: 'https://image.novelai.net', token: 'pst-token', timeoutMs: 5000, fetchImpl, ...over }
}

const fakeFetch = (status: number, text: string): typeof fetch =>
  (async () => new Response(text, { status })) as unknown as typeof fetch

describe('fetchSubscription', () => {
  it('打的是 {baseUrl}/user/subscription，带 Bearer Token', async () => {
    let seen: { url: string; init: RequestInit } | null = null
    const spy = (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return new Response(JSON.stringify(body), { status: 200 })
    }) as unknown as typeof fetch
    const r = await fetchSubscription(opts(spy, { baseUrl: 'https://image.novelai.net/' }))
    expect(r.ok).toBe(true)
    expect(seen!.url).toBe('https://image.novelai.net/user/subscription')
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe('Bearer pst-token')
  })

  it('成功：解析出点数与用量', async () => {
    const r = await fetchSubscription(opts(fakeFetch(200, JSON.stringify(body))))
    expect(r.ok && r.subscription.anlas.total).toBe(12345)
    expect(r.ok && r.subscription.usage?.percent).toBe(87)
  })

  it('没填 Token：不发请求，返回 no-token', async () => {
    let called = false
    const spy = (async () => {
      called = true
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const r = await fetchSubscription(opts(spy, { token: '' }))
    expect(called).toBe(false)
    expect(r.ok === false && r.error.kind).toBe('no-token')
  })

  it('401 单独报 Token 失效', async () => {
    const r = await fetchSubscription(opts(fakeFetch(401, 'unauthorized')))
    expect(r.ok === false && r.error.kind).toBe('unauthorized')
    expect(r.ok === false && r.error.message).toContain('Token')
  })

  it('其他 HTTP 错误带上正文（400 会说明账号端点已停用）', async () => {
    const r = await fetchSubscription(opts(fakeFetch(400, 'Please refresh NovelAI.net.')))
    expect(r.ok === false && r.error.kind).toBe('http')
    expect(r.ok === false && r.error.message).toContain('Please refresh')
  })

  it('返回不是 JSON / 结构不认识 → invalid', async () => {
    const bad = await fetchSubscription(opts(fakeFetch(200, '<html>502</html>')))
    expect(bad.ok === false && bad.error.kind).toBe('invalid')
    const wrong = await fetchSubscription(opts(fakeFetch(200, JSON.stringify({ hello: 1 }))))
    expect(wrong.ok === false && wrong.error.kind).toBe('invalid')
  })

  it('网络异常不 reject，返回 network', async () => {
    const boom = (async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch
    const r = await fetchSubscription(opts(boom))
    expect(r.ok === false && r.error.kind).toBe('network')
    expect(r.ok === false && r.error.message).toContain('ECONNRESET')
  })

  it('超时：fetch 迟迟不回 → timeout', async () => {
    const hang = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch
    const r = await fetchSubscription(opts(hang, { timeoutMs: 30 }))
    expect(r.ok === false && r.error.kind).toBe('timeout')
  })
})
