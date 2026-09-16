import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isPrivateAddress, type MobileEvent } from '../../../src/shared/mobileApi'
import { AppEvents } from '../../../src/main/appEvents'
import type { MainServices } from '../../../src/main/ipc'
import { createDeviceStore, type DeviceStore } from '../../../src/main/server/devices'
import { createMobileServer, createRequestHandler, type MobileServer, type ServerDeps } from '../../../src/main/server/http'
import { createSseHub } from '../../../src/main/server/sse'

/**
 * 服务骨架的测试：起真实服务（端口 0）用 node 的 fetch 打自己。
 * 来源校验那条走 createRequestHandler 直调——远端地址是真实 socket 给的，
 * 从外面没法伪造成公网地址，而这正是整个服务最要紧的一道闸，必须测到。
 */

let dir: string
let staticDir: string
let devices: DeviceStore
let server: MobileServer
let port: number
let urls: string[]
let base: string

/**
 * 骨架这几条路径用不到业务服务：真造一份会把 electron 拖进 node 测试进程。
 * events 是例外——服务一启动就要往总线上挂出图事件的转推（Task 9），
 * 它必须是真的；AppEvents 本来也不碰 electron。
 */
function makeDeps(): ServerDeps {
  return {
    services: { events: new AppEvents() } as unknown as MainServices,
    devices,
    staticDir,
    makeThumbnail: (png) => png,
    fetchUsage: () => Promise.reject(new Error('额度路由是 Task 5 的事')),
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mobile-http-'))
  staticDir = join(dir, 'static')
  mkdirSync(staticDir)
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>手机端</title>')
  writeFileSync(join(staticDir, 'app.js'), 'console.log(1)')
  devices = createDeviceStore(join(dir, 'devices.json'))
  server = createMobileServer(makeDeps())
  const started = await server.start(0)
  port = started.port
  urls = started.urls
  base = `http://127.0.0.1:${port}`
})

afterEach(async () => {
  await server.stop()
  rmSync(dir, { recursive: true, force: true })
})

/** 配对拿一个可用令牌 */
async function pairToken(name = '小米 14'): Promise<string> {
  const { code } = devices.newPairingCode()
  const r = await fetch(`${base}/api/pair`, { method: 'POST', body: JSON.stringify({ code, deviceName: name }) })
  const body = (await r.json()) as { token: string }
  return body.token
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

/** 原样发送路径的裸请求：fetch 会先把 `..` 规范化掉，穿越测试得绕过它 */
function raw(path: string): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', agent: false }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => (body += c))
      res.on('end', () => done({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', fail)
    req.end()
  })
}

interface Captured {
  status: number
  headers: Record<string, string>
  body: string
  ended: boolean
}

/** 假的 ServerResponse：只记下状态码、响应头与写出去的内容 */
function fakeResponse(): { res: ServerResponse; captured: Captured; emit: (event: string) => void } {
  const captured: Captured = { status: 0, headers: {}, body: '', ended: false }
  const listeners = new Map<string, (() => void)[]>()
  const res = {
    headersSent: false,
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status
      for (const [k, v] of Object.entries(headers ?? {})) captured.headers[k.toLowerCase()] = v
      res.headersSent = true
      return res
    },
    setHeader(k: string, v: string) {
      captured.headers[k.toLowerCase()] = v
    },
    write(chunk: string) {
      captured.body += chunk
      return true
    },
    end(chunk?: string) {
      if (chunk !== undefined) captured.body += chunk
      captured.ended = true
    },
    on(event: string, fn: () => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn])
      return res
    },
  }
  return {
    res: res as unknown as ServerResponse,
    captured,
    emit: (event) => {
      for (const fn of listeners.get(event) ?? []) fn()
    },
  }
}

function fakeRequest(remoteAddress: string | undefined, url: string): IncomingMessage {
  return { socket: { remoteAddress }, method: 'GET', url, headers: {} } as unknown as IncomingMessage
}

describe('来源校验', () => {
  it('公网来源一律 403，连鉴权都不走', async () => {
    const handler = createRequestHandler(makeDeps(), createSseHub())
    const { res, captured } = fakeResponse()
    await handler(fakeRequest('8.8.8.8', '/api/meta'), res)
    expect(captured.status).toBe(403)
    expect(JSON.parse(captured.body).error.kind).toBe('unauthorized')
  })

  it('取不到远端地址时也挡掉', async () => {
    const handler = createRequestHandler(makeDeps(), createSseHub())
    const { res, captured } = fakeResponse()
    await handler(fakeRequest(undefined, '/'), res)
    expect(captured.status).toBe(403)
  })

  it('私网来源放行到鉴权那一步（401 而不是 403）', async () => {
    const handler = createRequestHandler(makeDeps(), createSseHub())
    const { res, captured } = fakeResponse()
    await handler(fakeRequest('192.168.1.8', '/api/meta'), res)
    expect(captured.status).toBe(401)
  })

  it('静态资源同样要过来源校验', async () => {
    const handler = createRequestHandler(makeDeps(), createSseHub())
    const { res, captured } = fakeResponse()
    await handler(fakeRequest('203.0.113.9', '/index.html'), res)
    expect(captured.status).toBe(403)
    expect(captured.body).not.toContain('<!doctype')
  })
})

describe('鉴权', () => {
  it('没带令牌访问 /api/meta → 401 + { error: { kind: unauthorized } }', async () => {
    const r = await fetch(`${base}/api/meta`)
    expect(r.status).toBe(401)
    const body = (await r.json()) as { error: { kind: string; message: string } }
    expect(body.error.kind).toBe('unauthorized')
    expect(body.error.message.length).toBeGreaterThan(0)
  })

  it('令牌不对 → 401', async () => {
    // 请求头只能是 ByteString，假令牌得用 ASCII
    const r = await fetch(`${base}/api/meta`, { headers: auth('not-a-real-token') })
    expect(r.status).toBe(401)
  })

  it('配对后带令牌能过鉴权：认不出的 /api 路径落到 handleApi 的统一 404', async () => {
    // 用一个不会被任何任务实现的路径，不依赖 Task 5 起陆续接上的具体接口——
    // 这条测的是「过了鉴权之后落到路由层的 404」这件事本身
    const token = await pairToken()
    const r = await fetch(`${base}/api/not-a-real-route`, { headers: auth(token) })
    expect(r.status).toBe(404)
    expect(((await r.json()) as { error: { kind: string } }).error.kind).toBe('not-found')
  })

  it('设备被吊销后立刻 401', async () => {
    const token = await pairToken()
    devices.revokeAll()
    expect((await fetch(`${base}/api/meta`, { headers: auth(token) })).status).toBe(401)
  })

  it('不发任何 CORS 放行头', async () => {
    const token = await pairToken()
    for (const r of [await fetch(`${base}/api/meta`), await fetch(`${base}/api/meta`, { headers: auth(token) }), await fetch(base)]) {
      expect(r.headers.get('access-control-allow-origin')).toBeNull()
      expect(r.headers.get('access-control-allow-credentials')).toBeNull()
    }
  })
})

describe('配对', () => {
  it('配对码换令牌，且不需要带令牌就能调', async () => {
    const { code } = devices.newPairingCode()
    const r = await fetch(`${base}/api/pair`, {
      method: 'POST',
      body: JSON.stringify({ code, deviceName: '小米 14' }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { token: string; deviceName: string }
    expect(body.deviceName).toBe('小米 14')
    expect(devices.verify(body.token)?.name).toBe('小米 14')
  })

  it('配对码不对 → 401，且没有设备被记下来', async () => {
    devices.newPairingCode()
    const r = await fetch(`${base}/api/pair`, {
      method: 'POST',
      body: JSON.stringify({ code: '9999', deviceName: 'x' }),
    })
    expect(r.status).toBe(401)
    expect(devices.list()).toEqual([])
  })

  it('请求体不是配对入参 → 400 bad-request', async () => {
    devices.newPairingCode()
    for (const body of ['', '不是 JSON', JSON.stringify({ code: 1234 }), JSON.stringify([])]) {
      const r = await fetch(`${base}/api/pair`, { method: 'POST', body })
      expect(r.status).toBe(400)
      expect(((await r.json()) as { error: { kind: string } }).error.kind).toBe('bad-request')
    }
  })

  it('设备名为空时给个默认名，过长时截断', async () => {
    const { code } = devices.newPairingCode()
    await fetch(`${base}/api/pair`, { method: 'POST', body: JSON.stringify({ code, deviceName: '   ' }) })
    expect(devices.list()[0].name).toBe('手机')

    const second = devices.newPairingCode()
    await fetch(`${base}/api/pair`, { method: 'POST', body: JSON.stringify({ code: second.code, deviceName: '名'.repeat(200) }) })
    expect(devices.list()[1].name.length).toBeLessThanOrEqual(40)
  })

  it('GET /api/pair 不算配对入口，照样要令牌', async () => {
    expect((await fetch(`${base}/api/pair`)).status).toBe(401)
  })
})

describe('静态托管', () => {
  it('/ 返回 index.html', async () => {
    const r = await fetch(base)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/html')
    expect(await r.text()).toContain('手机端')
  })

  it('静态资源不需要令牌，并给出对应的 Content-Type', async () => {
    const r = await fetch(`${base}/app.js`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('javascript')
    expect(await r.text()).toContain('console.log')
  })

  it('未知路径回落 index.html（手机端用前端路由）', async () => {
    const r = await fetch(`${base}/history/2026-09-16`)
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('手机端')
  })

  it('找不到的资源文件 404，不会把 index.html 当成脚本喂回去', async () => {
    const r = await fetch(`${base}/没有这个.js`)
    expect(r.status).toBe(404)
    expect(await r.text()).not.toContain('手机端')
  })

  it('静态文件不能穿目录', async () => {
    writeFileSync(join(dir, 'secret.txt'), '不该被读到')
    for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt', '/static/../../secret.txt']) {
      const r = await raw(path)
      expect(r.status).toBe(404)
      expect(r.body).not.toContain('不该被读到')
    }
  })

  it('绝对路径一律读不到', async () => {
    const r = await raw(`/${join(dir, 'devices.json').replace(/\\/g, '/')}`)
    expect(r.status).toBe(404)
  })
})

describe('生命周期', () => {
  it('start 返回实际端口与局域网地址，地址都是私网的', () => {
    // 端口 0 起的，实际端口必须是系统分配的那个，不能原样把 0 返回来
    expect(port).toBeGreaterThan(0)
    expect(server.port).toBe(port)
    for (const url of urls) {
      const u = new URL(url)
      expect(isPrivateAddress(u.hostname)).toBe(true)
      expect(u.port).toBe(String(port))
    }
  })

  it('stop 之后端口释放，再 start 能起来', async () => {
    await server.stop()
    expect(server.running).toBe(false)
    expect(server.port).toBeNull()

    const again = await server.start(port)
    expect(again.port).toBe(port)
    expect(server.running).toBe(true)
    expect((await fetch(base)).status).toBe(200)
  })

  it('端口被占用时 start 给出中文说明，不把进程带走', async () => {
    const other = createMobileServer(makeDeps())
    await expect(other.start(port)).rejects.toThrow(/端口 \d+ 已被占用/)
    expect(other.running).toBe(false)
    // 原来那个还好好的
    expect((await fetch(base)).status).toBe(200)
  })

  it('没在跑的时候 stop 是空操作', async () => {
    await server.stop()
    await expect(server.stop()).resolves.toBeUndefined()
  })
})

describe('SSE', () => {
  it('GET /api/events 要令牌', async () => {
    expect((await fetch(`${base}/api/events`)).status).toBe(401)
  })

  it('带令牌时是 text/event-stream 的长连接', async () => {
    const token = await pairToken()
    const r = await fetch(`${base}/api/events`, { headers: auth(token) })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/event-stream')
    expect(r.headers.get('cache-control')).toContain('no-cache')

    const reader = r.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain(':')
    await reader.cancel()
  })

  // 浏览器的 EventSource 带不了自定义请求头，SSE 这一条只能把令牌放查询串里（Task 11）
  it('/api/events 认 ?token=，不带请求头也能连上', async () => {
    const token = await pairToken()
    const r = await fetch(`${base}/api/events?token=${encodeURIComponent(token)}`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/event-stream')
    await r.body!.cancel()
  })

  // <img src> 同样带不了请求头，图片是第二条、也是最后一条走查询串的路径
  it('/api/image 认 ?token=：没有这条，手机上的缩略图全是 401', async () => {
    const token = await pairToken()
    const r = await fetch(`${base}/api/image?token=${encodeURIComponent(token)}&round=2026-09-16T00:00:00.000Z&file=nope.png`)
    // 这里只测「令牌被认下来、放进了业务层」：本套件的 services 夹具没接 configStore，
    // 业务层读配置会自己炸成 500。图片本身的 404/缩图行为在 image.test.ts 里测
    expect(r.status).not.toBe(401)
  })

  it('?token= 只对 events 与 image 放行，别的接口照旧只认请求头', async () => {
    const token = await pairToken()
    expect((await fetch(`${base}/api/meta?token=${encodeURIComponent(token)}`)).status).toBe(401)
    expect((await fetch(`${base}/api/history?token=${encodeURIComponent(token)}`)).status).toBe(401)
  })

  it('?token= 不对时照样 401', async () => {
    await pairToken()
    expect((await fetch(`${base}/api/events?token=乱填的`)).status).toBe(401)
  })
})

describe('createSseHub', () => {
  const event: MobileEvent = { kind: 'busy', busy: { llm: false, gen: true } }

  it('push 按 SSE 格式发给每个连接', () => {
    const hub = createSseHub()
    const a = fakeResponse()
    const b = fakeResponse()
    hub.attach(a.res)
    hub.attach(b.res)
    expect(hub.count).toBe(2)

    hub.push(event)
    expect(a.captured.body).toContain(`data: ${JSON.stringify(event)}\n\n`)
    expect(b.captured.body).toContain(`data: ${JSON.stringify(event)}\n\n`)
    expect(a.captured.headers['content-type']).toContain('text/event-stream')
  })

  it('退订后不再收到，也不再计数', () => {
    const hub = createSseHub()
    const a = fakeResponse()
    const detach = hub.attach(a.res)
    detach()
    expect(hub.count).toBe(0)
    const before = a.captured.body
    hub.push(event)
    expect(a.captured.body).toBe(before)
    // 重复退订是空操作
    expect(() => detach()).not.toThrow()
  })

  it('连接断开自动退订，不会越积越多', () => {
    const hub = createSseHub()
    const a = fakeResponse()
    hub.attach(a.res)
    a.emit('close')
    expect(hub.count).toBe(0)
  })

  it('心跳按间隔发注释行，最后一个连接走了就停', async () => {
    const hub = createSseHub({ heartbeatMs: 10 })
    const a = fakeResponse()
    const detach = hub.attach(a.res)
    await new Promise((r) => setTimeout(r, 35))
    expect(a.captured.body).toContain(': ping\n\n')

    detach()
    const after = a.captured.body
    await new Promise((r) => setTimeout(r, 35))
    expect(a.captured.body).toBe(after)
  })
})
