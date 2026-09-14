import { deflateRawSync } from 'zlib'
import { describe, expect, it } from 'vitest'
import { generateImage, type NaiClientOptions } from '../../../src/main/nai/client'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function opts(fetchImpl: typeof fetch, over: Partial<NaiClientOptions> = {}): NaiClientOptions {
  return {
    baseUrl: 'https://api.novelai.net',
    token: 'pst-token',
    timeoutMs: 5000,
    imageFormat: 'png',
    fetchImpl,
    ...over,
  }
}

const WEBP_MAGIC = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
])

/** 造一个返回指定状态与字节的假 fetch */
function fakeFetch(status: number, body: Buffer): typeof fetch {
  return (async () =>
    // Buffer 与 DOM lib 的 BodyInit 在当前 TS/@types/node 组合下判定不兼容
    // （TS 5.7+ 把 TypedArray 泛型化后的已知问题），运行时构造完全没问题，
    // 只是类型层面需要这层 cast
    new Response(body as unknown as BodyInit, { status })) as unknown as typeof fetch
}

/** 手工拼一个 zip 条目（local file header + deflate 数据），CRC 留 0——解包器不校验 */
function zipEntry(name: string, content: Buffer): Buffer {
  const data = deflateRawSync(content)
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(0, 6)
  header.writeUInt16LE(8, 8)
  header.writeUInt16LE(0, 10)
  header.writeUInt16LE(0, 12)
  header.writeUInt32LE(0, 14)
  header.writeUInt32LE(data.length, 18)
  header.writeUInt32LE(content.length, 22)
  header.writeUInt16LE(name.length, 26)
  header.writeUInt16LE(0, 28)
  return Buffer.concat([header, Buffer.from(name, 'ascii'), data])
}

describe('generateImage — 成功路径', () => {
  it('解析 JSON 响应里的图片与 seed', async () => {
    const payload = Buffer.from(
      JSON.stringify({ images: [{ image: 'QUJD', seed: 4242 }] }),
      'utf-8',
    )
    const r = await generateImage(opts(fakeFetch(200, payload)), {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.images).toHaveLength(1)
    expect(r.images[0].data).toBe('QUJD')
    expect(r.images[0].seed).toBe(4242)
  })

  it('JSON 响应缺 seed 时置为 null', async () => {
    const payload = Buffer.from(JSON.stringify({ images: [{ image: 'QUJD' }] }), 'utf-8')
    const r = await generateImage(opts(fakeFetch(200, payload)), {})
    expect(r.ok && r.images[0].seed).toBeNull()
  })

  it('中转端点返回 zip 时解出图片，seed 置 null 交给上层读 PNG 元数据', async () => {
    const png = Buffer.concat([PNG_MAGIC, Buffer.from('IMG', 'ascii')])
    const r = await generateImage(opts(fakeFetch(200, zipEntry('image_0.png', png))), {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.images).toHaveLength(1)
    expect(Buffer.from(r.images[0].data, 'base64').subarray(8).toString('ascii')).toBe('IMG')
    // zip 路径拿不到接口回报的 seed，必须是 null 而不是 0 或 undefined，
    // 上层才知道要回退去读 PNG 自带的元数据
    expect(r.images[0].seed).toBeNull()
  })

  it('imageFormat: webp 时 JSON 路径回报的 mimeType 为 image/webp', async () => {
    const payload = Buffer.from(JSON.stringify({ images: [{ image: 'QUJD', seed: 1 }] }), 'utf-8')
    const r = await generateImage(
      opts(fakeFetch(200, payload), { imageFormat: 'webp' }),
      {},
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.images[0].mimeType).toBe('image/webp')
  })

  it('zip 路径能从含 WebP 条目的包里取出图片', async () => {
    const webp = Buffer.concat([WEBP_MAGIC, Buffer.from('IMG', 'ascii')])
    const r = await generateImage(
      opts(fakeFetch(200, zipEntry('image_0.webp', webp)), { imageFormat: 'webp' }),
      {},
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.images).toHaveLength(1)
    expect(r.images[0].mimeType).toBe('image/webp')
    expect(Buffer.from(r.images[0].data, 'base64').subarray(12).toString('ascii')).toBe('IMG')
  })
})

describe('generateImage — 响应解析失败', () => {
  it('响应不是 JSON 且解不出图片时归为 empty', async () => {
    // 用一个不以 '{' 开头、解不出条目的 buffer 走 zip 分支，
    // 再单独验证解不出图片时的报错
    const zipLike = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26)])
    const r = await generateImage(opts(fakeFetch(200, zipLike)), {})
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('empty')
  })
})

describe('generateImage — 错误分类', () => {
  it('未配置 token 时直接返回 no-token，不发请求', async () => {
    let called = false
    const spy = (async () => {
      called = true
      return new Response(Buffer.alloc(0) as unknown as BodyInit, { status: 200 })
    }) as unknown as typeof fetch
    const r = await generateImage(opts(spy, { token: '' }), {})
    expect(called).toBe(false)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('no-token')
  })

  it('401 归为 unauthorized', async () => {
    const r = await generateImage(opts(fakeFetch(401, Buffer.from('nope'))), {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('unauthorized')
  })

  it('402 归为 payment', async () => {
    const r = await generateImage(opts(fakeFetch(402, Buffer.from('nope'))), {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('payment')
  })

  it('429 归为 concurrent，文案说明是并发冲突', async () => {
    const r = await generateImage(opts(fakeFetch(429, Buffer.from('busy'))), {})
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe('concurrent')
      expect(r.error.message).toContain('并发')
    }
  })

  it('其它 4xx/5xx 归为 http，带上响应体前缀', async () => {
    const r = await generateImage(opts(fakeFetch(500, Buffer.from('server exploded'))), {})
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe('http')
      expect(r.error.message).toContain('server exploded')
    }
  })

  it('200 但 JSON 里没有 images 数组时归为 http', async () => {
    const payload = Buffer.from(JSON.stringify({ message: '出错了' }), 'utf-8')
    const r = await generateImage(opts(fakeFetch(200, payload)), {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('http')
  })

  it('images 数组含非对象元素时返回分类错误，而不是抛异常', async () => {
    // 中转端点不守规矩，这不是假想输入
    const payload = Buffer.from(JSON.stringify({ images: [null] }), 'utf-8')
    const r = await generateImage(opts(fakeFetch(200, payload)), {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('empty')
  })

  it('seed 不是数字时置为 null，交给上层读 PNG 元数据', async () => {
    const payload = Buffer.from(
      JSON.stringify({ images: [{ image: 'QUJD', seed: '不是数字' }] }),
      'utf-8',
    )
    const r = await generateImage(opts(fakeFetch(200, payload)), {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 写 NaN 进文件名和 _index.json 比没有 seed 更糟
    expect(r.images[0].seed).toBeNull()
  })

  it('网络异常归为 network', async () => {
    const boom = (async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch
    const r = await generateImage(opts(boom), {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('network')
  })

  it('超时归为 timeout', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const slow = (async () => {
      throw abortErr
    }) as unknown as typeof fetch
    const r = await generateImage(opts(slow), {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('timeout')
  })

  it('响应头已到但 body 流中途断开时归为 network，而不是让 promise reject', async () => {
    // 造一个假 Response：状态正常，但读取 body 时才炸——这是「连接建立后
    // 数据传输中断」的真实形态，不能靠 fakeFetch 直接 throw 来模拟
    const brokenResponse = {
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.reject(new Error('stream aborted')),
    } as unknown as Response
    const brokenStream = (async () => brokenResponse) as unknown as typeof fetch
    const r = await generateImage(opts(brokenStream), {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('network')
  })
})

describe('generateImage — 请求契约', () => {
  it('请求的 URL、方法与请求头符合 NovelAI 的约定', async () => {
    const seen: { url?: string; init?: RequestInit } = {}
    const spy = (async (url: string, init: RequestInit) => {
      seen.url = String(url)
      seen.init = init
      const payload = Buffer.from(JSON.stringify({ images: [] }), 'utf-8')
      return new Response(payload as unknown as BodyInit, { status: 200 })
    }) as unknown as typeof fetch

    await generateImage(opts(spy, { baseUrl: 'https://api.novelai.net/' }), { a: 1 })

    // 顺带钉住 baseUrl 末尾斜杠会被裁剪
    expect(seen.url).toBe('https://api.novelai.net/ai/generate-image')
    expect(seen.init?.method).toBe('POST')
    expect(seen.init?.headers).toEqual({
      Authorization: 'Bearer pst-token',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    })
    expect(JSON.parse(String(seen.init?.body))).toEqual({ a: 1 })
  })
})

describe('generateImage — 超时不依赖 fetch 认 signal', () => {
  it('fetch 忽略 signal、永不返回时，到点仍返回 timeout', async () => {
    const hanging = (() => new Promise<Response>(() => {})) as unknown as typeof fetch
    const started = Date.now()
    const r = await generateImage(opts(hanging, { timeoutMs: 30 }), {})
    expect(r).toEqual({ ok: false, error: { kind: 'timeout', message: '请求超时（0 秒）。' } })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('响应头到了但 body 一直不来，到点同样返回 timeout', async () => {
    const stalled = (async () => ({ ok: true, status: 200, arrayBuffer: () => new Promise<ArrayBuffer>(() => {}) })) as unknown as typeof fetch
    const r = await generateImage(opts(stalled, { timeoutMs: 30 }), {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('timeout')
  })
})
