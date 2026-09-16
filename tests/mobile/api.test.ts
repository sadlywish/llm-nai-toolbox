import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  ApiFailure,
  createApiClient,
  NETWORK_FAILURE_MESSAGE,
  normalizeBaseUrl,
} from '../../src/mobile/src/api'
import type { MobileEvent } from '../../src/shared/mobileApi'

/**
 * 手机端 API 客户端的测试：假 fetch + 假 EventSource。
 * 不起真服务——服务端那头由 tests/main/server/* 管，这里只管客户端怎么发、怎么把失败翻成 ApiFailure。
 */

/** 记下每次 fetch 的入参，断言用 */
let calls: { url: string; init: RequestInit }[]
let fetchMock: Mock<[url: string, init: RequestInit], Promise<Response>>

/** EventSource 不能带自定义请求头，令牌只能走查询串——假实现把 URL 留下来给测试看 */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  onmessage: ((e: { data: string }) => void) | null = null
  onopen: (() => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  closed = false
  readonly headers: undefined
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }
  close(): void {
    this.closed = true
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function replyOnce(res: Response | Promise<Response>): void {
  fetchMock.mockImplementationOnce((url: string, init: RequestInit) => {
    calls.push({ url, init })
    return Promise.resolve(res)
  })
}

beforeEach(() => {
  calls = []
  FakeEventSource.instances = []
  fetchMock = vi.fn((url: string, init: RequestInit) => {
    calls.push({ url, init })
    return Promise.resolve(json(200, {}))
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('EventSource', FakeEventSource)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('normalizeBaseUrl', () => {
  it('补上 http://、去掉末尾斜杠', () => {
    expect(normalizeBaseUrl('192.168.1.8:7321')).toBe('http://192.168.1.8:7321')
    expect(normalizeBaseUrl(' http://192.168.1.8:7321/ ')).toBe('http://192.168.1.8:7321')
    expect(normalizeBaseUrl('https://pc.lan:7321//')).toBe('https://pc.lan:7321')
  })

  it('空串仍是空串（连接页据此禁用「连接」按钮）', () => {
    expect(normalizeBaseUrl('   ')).toBe('')
  })
})

describe('请求', () => {
  it('每条请求都带 Bearer 令牌', async () => {
    replyOnce(json(200, { apiVersion: 1 }))
    await createApiClient('http://pc:7321', 'tok-1').meta()
    expect(calls[0].url).toBe('http://pc:7321/api/meta')
    expect(new Headers(calls[0].init.headers).get('Authorization')).toBe('Bearer tok-1')
  })

  it('配对不带令牌：那时候还没有令牌可带', async () => {
    replyOnce(json(200, { token: 't', deviceName: '小米 14' }))
    const r = await createApiClient('http://pc:7321', '').pair('4821', '小米 14')
    expect(r).toEqual({ token: 't', deviceName: '小米 14' })
    expect(new Headers(calls[0].init.headers).has('Authorization')).toBe(false)
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ code: '4821', deviceName: '小米 14' })
  })

  it('POST 带 JSON 请求体与 Content-Type', async () => {
    replyOnce(json(200, { runId: 'run-1' }))
    const input = { instruction: '画个初音' } as never
    const r = await createApiClient('http://pc:7321', 'tok').llmRun(input)
    expect(r).toEqual({ runId: 'run-1' })
    expect(calls[0].url).toBe('http://pc:7321/api/llm/run')
    expect(new Headers(calls[0].init.headers).get('Content-Type')).toContain('application/json')
  })

  it('history 带上 days，不给时不拼查询串', async () => {
    replyOnce(json(200, []))
    await createApiClient('http://pc:7321', 'tok').history(3)
    expect(calls[0].url).toBe('http://pc:7321/api/history?days=3')
    replyOnce(json(200, []))
    await createApiClient('http://pc:7321', 'tok').history()
    expect(calls[1].url).toBe('http://pc:7321/api/history')
  })
})

describe('画风写接口', () => {
  it('新建：POST /api/styles 带 name/tags', async () => {
    replyOnce(json(200, { id: 'st-1', name: '厚涂光影', tags: 'artist:wlop' }))
    const r = await createApiClient('http://pc:7321', 'tok').createStyle('厚涂光影', 'artist:wlop')
    expect(r).toEqual({ id: 'st-1', name: '厚涂光影', tags: 'artist:wlop' })
    expect(calls[0].url).toBe('http://pc:7321/api/styles')
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ name: '厚涂光影', tags: 'artist:wlop' })
  })

  it('改名/改标签：PATCH /api/styles/:id 只带传入的字段', async () => {
    replyOnce(json(200, { id: 'st-1', name: '新名字', tags: 'artist:wlop' }))
    await createApiClient('http://pc:7321', 'tok').patchStyle('st-1', { name: '新名字' })
    expect(calls[0].url).toBe('http://pc:7321/api/styles/st-1')
    expect(calls[0].init.method).toBe('PATCH')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ name: '新名字' })
  })

  it('删除：DELETE /api/styles/:id，id 转义进路径', async () => {
    replyOnce(json(200, { ok: true }))
    await createApiClient('http://pc:7321', 'tok').deleteStyle('st/1')
    expect(calls[0].url).toBe('http://pc:7321/api/styles/st%2F1')
    expect(calls[0].init.method).toBe('DELETE')
  })

  it('排序：POST /api/styles/order，返回排好序的列表', async () => {
    replyOnce(json(200, { styles: [{ id: 'b', name: 'B', tags: '' }, { id: 'a', name: 'A', tags: '' }] }))
    const r = await createApiClient('http://pc:7321', 'tok').reorderStyles(['b', 'a'])
    expect(calls[0].url).toBe('http://pc:7321/api/styles/order')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ ids: ['b', 'a'] })
    expect(r.map((s) => s.id)).toEqual(['b', 'a'])
  })

  it('选为预设：POST /api/styles/:id/preset', async () => {
    replyOnce(json(200, { presetId: 'st-1' }))
    await createApiClient('http://pc:7321', 'tok').setPresetStyle('st-1')
    expect(calls[0].url).toBe('http://pc:7321/api/styles/st-1/preset')
    expect(calls[0].init.method).toBe('POST')
  })
})

describe('失败', () => {
  it('服务端返回 { error } 时抛 ApiFailure，中文说明原样带出来', async () => {
    replyOnce(json(409, { error: { kind: 'busy', message: '电脑正在出图，等这一轮结束再试' } }))
    const client = createApiClient('http://pc:7321', 'tok')
    await expect(client.genStart({} as never)).rejects.toBeInstanceOf(ApiFailure)

    replyOnce(json(401, { error: { kind: 'unauthorized', message: '这台手机还没配对或已被吊销，请重新配对' } }))
    const err = await client.meta().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiFailure)
    expect((err as ApiFailure).error).toEqual({
      kind: 'unauthorized',
      message: '这台手机还没配对或已被吊销，请重新配对',
    })
    // message 要能直接 String(err) 显示出来，界面上不必再翻一层 .error
    expect((err as ApiFailure).message).toBe('这台手机还没配对或已被吊销，请重新配对')
  })

  it('连不上电脑时自己造一条 server 失败，而不是把 TypeError 漏出去', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const err = await createApiClient('http://pc:7321', 'tok').meta().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiFailure)
    expect((err as ApiFailure).error).toEqual({ kind: 'server', message: NETWORK_FAILURE_MESSAGE })
  })

  it('回来的不是 JSON（被别的东西占了端口）也是 ApiFailure，不是 SyntaxError', async () => {
    replyOnce(new Response('<html>404</html>', { status: 502 }))
    const err = await createApiClient('http://pc:7321', 'tok').meta().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiFailure)
    expect((err as ApiFailure).error.kind).toBe('server')
    expect((err as ApiFailure).error.message).toContain('502')
  })

  it('401 时通知调用方（App 据此清掉本地连接信息回到连接页）', async () => {
    const onUnauthorized = vi.fn()
    const client = createApiClient('http://pc:7321', 'tok', onUnauthorized)
    replyOnce(json(401, { error: { kind: 'unauthorized', message: '已吊销' } }))
    await client.meta().catch(() => undefined)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)

    replyOnce(json(409, { error: { kind: 'busy', message: '忙' } }))
    await client.genStart({} as never).catch(() => undefined)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })
})

describe('imageUrl', () => {
  it('把轮次与文件名转义进查询串，并带上令牌', () => {
    const url = createApiClient('http://pc:7321', 'tok').imageUrl('2026-09-16T12:31:02.000Z', 'a b.png', 'thumb')
    // 令牌必须在里面：这个地址进的是 <img src>，带不了 Authorization 头，漏了就是一片 401（实机踩过）
    expect(url).toBe('http://pc:7321/api/image?round=2026-09-16T12%3A31%3A02.000Z&file=a%20b.png&size=thumb&token=tok')
  })

  it('令牌里的特殊字符要转义', () => {
    const url = createApiClient('http://pc:7321', 'tok/1+2').imageUrl('2026-09-16T12:31:02.000Z', 'a.png', 'full')
    expect(url).toContain('token=tok%2F1%2B2')
  })
})

describe('events', () => {
  it('令牌走查询串：EventSource 带不了自定义请求头', () => {
    createApiClient('http://pc:7321', 'tok/1').events(() => undefined)
    const es = FakeEventSource.instances[0]
    expect(es.url).toBe('http://pc:7321/api/events?token=tok%2F1')
  })

  it('推来的事件解析后回调；坏行忽略掉不影响后面的事件', () => {
    const seen: MobileEvent[] = []
    createApiClient('http://pc:7321', 'tok').events((e) => seen.push(e))
    const es = FakeEventSource.instances[0]
    es.onmessage?.({ data: 'not json' })
    es.onmessage?.({ data: JSON.stringify({ kind: 'busy', busy: { llm: false, gen: true } }) })
    expect(seen).toEqual([{ kind: 'busy', busy: { llm: false, gen: true } }])
  })

  it('返回的函数关掉连接', () => {
    const stop = createApiClient('http://pc:7321', 'tok').events(() => undefined)
    stop()
    expect(FakeEventSource.instances[0].closed).toBe(true)
  })

  it('连上与断开都报给调用方（顶部那个状态点）', () => {
    const status: boolean[] = []
    createApiClient('http://pc:7321', 'tok').events(
      () => undefined,
      (connected) => status.push(connected),
    )
    const es = FakeEventSource.instances[0]
    es.onopen?.()
    es.onerror?.(new Error('断了'))
    expect(status).toEqual([true, false])
  })
})
