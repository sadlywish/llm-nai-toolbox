// 手机端 HTTP 服务的骨架：生命周期、来源校验、鉴权、静态托管、路由分发。
//
// 不 import electron（`import type` 会被编译期擦掉，不算）：服务层要能在 node 下跑测试，
// 凡是 electron 才有的东西——静态目录、缩图、额度查询——一律由 index.ts 通过 ServerDeps 注入。
import { readFile, stat } from 'fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { Socket } from 'net'
import { networkInterfaces } from 'os'
import { extname, resolve, sep } from 'path'
import { apiError, isPrivateAddress, type ApiErrorKind, type PairResult } from '../../shared/mobileApi'
import type { NaiSubscriptionResult } from '../../shared/naiUser'
import type { MainServices } from '../ipc'
import type { DeviceStore } from './devices'
import { handleApi } from './routes'
import { createSseHub, type SseHub } from './sse'

export interface ServerDeps {
  services: MainServices
  devices: DeviceStore
  /** 手机端页面所在目录：开发态 out/mobile，打包后 resources 里的那份（由 index.ts 算好） */
  staticDir: string
  /** 缩图实现（Task 6 用）。放在这里注入是因为真实现要 electron 的 nativeImage */
  makeThumbnail: (png: Buffer, maxEdge: number) => Buffer
  /** 额度查询（Task 5 用）。同样注入：Token 与代理都在主进程里，服务层不该碰 */
  fetchUsage: () => Promise<NaiSubscriptionResult>
}

export interface MobileServer {
  /** 启动并监听；端口给 0 时由系统分配，返回值里的 port 是实际端口 */
  start(port: number): Promise<{ port: number; urls: string[] }>
  stop(): Promise<void>
  readonly running: boolean
  readonly port: number | null
}

/** 请求体上限。手机发来的最大一包是提示词工作区快照（Task 8），1MB 绰绰有余 */
const MAX_BODY_BYTES = 1024 * 1024

/** 设备名只用于设置页的列表展示，截断是为了不让设备表被一个超长名字撑大 */
const MAX_DEVICE_NAME = 40

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

// 导出给 routes.ts：业务路由的响应形状（no-store、不发 CORS 放行头）必须与配对、
// 404 这些骨架自带的响应一致，两边各写一遍迟早会走样。
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  // 接口响应一律 no-store：额度、历史、在途状态都是会变的，手机上缓存住只会看到旧数据。
  // 这里也是全服务唯一写响应头的地方之一——始终不发 CORS 放行头（Global Constraints）
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

export function sendError(res: ServerResponse, status: number, kind: ApiErrorKind, message: string): void {
  sendJson(res, status, apiError(kind, message))
}

/**
 * 读请求体并解析成 JSON。解析不了、超大、空的一律返回 undefined，由调用方回 400——
 * 这是外部输入的入口，不能假定手机端（或局域网里任何人）发来的东西是对的。
 */
export async function readJsonBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  let tooLarge = false
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    // 超限后继续把流读完（不 destroy socket），这样 400 还能原路发回去给手机看
    if (size > maxBytes) tooLarge = true
    else chunks.push(buf)
  }
  if (tooLarge || size === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown
  } catch {
    return undefined
  }
}

function bearerToken(req: IncomingMessage): string | null {
  const raw = req.headers.authorization
  if (typeof raw !== 'string') return null
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim())
  return m === null ? null : m[1].trim()
}

/**
 * 把请求路径解析成 staticDir 下的真实路径；逃出 staticDir 的一律返回 null。
 *
 * 一律当作「staticDir 下的相对路径」来解，`/../../x` 与 `/C:/x` 因此都会落到
 * resolve 之后的前缀检查上。只靠字符串里有没有 `..` 来判断是不够的：`%2e%2e`
 * 解码之后才是 `..`，而浏览器与代理都可能原样把编码形式发过来。
 */
function resolveStaticPath(staticDir: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null // %ZZ 这种解不开的百分号转义
  }
  if (decoded.includes('\0')) return null
  const root = resolve(staticDir)
  const target = resolve(root, `.${decoded.startsWith('/') ? '' : '/'}${decoded}`)
  if (target !== root && !target.startsWith(root + sep)) return null
  return target
}

async function readFileIfExists(path: string): Promise<Buffer | null> {
  try {
    // 先 stat：目录也能 resolve 成功，readFile 一个目录在不同平台上报的错不一样
    const info = await stat(path)
    if (!info.isFile()) return null
    return await readFile(path)
  } catch {
    return null
  }
}

async function serveStatic(res: ServerResponse, staticDir: string, pathname: string): Promise<void> {
  const target = resolveStaticPath(staticDir, pathname)
  if (target === null) {
    sendError(res, 404, 'not-found', '没有这个页面')
    return
  }
  const file = await readFileIfExists(target)
  if (file !== null) {
    const type = CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream'
    // 页面与资源都不缓存：改完手机端重新构建后要立刻生效，省下的那点流量在局域网里不值一提
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' })
    res.end(file)
    return
  }
  // 带扩展名的当资源看：找不到就 404。回落成 index.html 的话，浏览器会拿着一份
  // HTML 当 JS 执行并报一句不知所云的语法错，排查起来比 404 难得多
  if (extname(target) !== '') {
    sendError(res, 404, 'not-found', '没有这个文件')
    return
  }
  // 其余路径回落 index.html：手机端用前端路由，刷新 /history 这种地址也得出页面
  const index = await readFileIfExists(resolve(staticDir, 'index.html'))
  if (index === null) {
    sendError(res, 404, 'not-found', '手机端页面还没构建出来，先在电脑上执行一次构建')
    return
  }
  res.writeHead(200, { 'Content-Type': CONTENT_TYPES['.html'], 'Cache-Control': 'no-cache' })
  res.end(index)
}

async function handlePair(req: IncomingMessage, res: ServerResponse, devices: DeviceStore): Promise<void> {
  const body = await readJsonBody(req)
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    sendError(res, 400, 'bad-request', '配对请求的内容不对')
    return
  }
  const { code, deviceName } = body as Record<string, unknown>
  if (typeof code !== 'string' || typeof deviceName !== 'string') {
    sendError(res, 400, 'bad-request', '配对请求的内容不对')
    return
  }
  const name = deviceName.trim().slice(0, MAX_DEVICE_NAME) || '手机'
  const paired = devices.pair(code.trim(), name)
  if (paired === null) {
    sendError(res, 401, 'unauthorized', '配对码不对或已过期，请在电脑上重新生成一个')
    return
  }
  const result: PairResult = { token: paired.token, deviceName: paired.device.name }
  sendJson(res, 200, result)
}

/**
 * 请求处理函数。单独导出是为了能直接喂一个远端地址是公网的假请求进来——
 * 来源校验是这个服务最要紧的一道闸，从真实 socket 那头没法伪造出公网来源。
 */
export function createRequestHandler(
  deps: ServerDeps,
  hub: SseHub,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      // 第一道闸：只服务局域网。绑定 0.0.0.0 是为了手机能连进来，放行与否只看来源地址
      if (!isPrivateAddress(req.socket.remoteAddress)) {
        sendError(res, 403, 'unauthorized', '手机端服务只对局域网开放')
        return
      }
      // 只取路径：req.url 可能带查询串，也可能是代理形式的绝对 URL
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      if (!pathname.startsWith('/api/')) {
        await serveStatic(res, deps.staticDir, pathname)
        return
      }
      // 配对是拿令牌的唯一入口，只有它不需要令牌；限定 POST，免得配对码出现在
      // 浏览器历史、日志与 Referer 里
      if (pathname === '/api/pair' && req.method === 'POST') {
        await handlePair(req, res, deps.devices)
        return
      }
      const device = deps.devices.verify(bearerToken(req))
      if (device === null) {
        sendError(res, 401, 'unauthorized', '这台手机还没配对或已被吊销，请重新配对')
        return
      }
      if (pathname === '/api/events' && req.method === 'GET') {
        hub.attach(res)
        return
      }
      // hub 一并交给路由层：LLM（Task 8）与出图（Task 9）开跑后立刻回话，进度与结果都从这里推出去。
      // handleApi 认不出的路径（或方法）统一落到下面这条 404
      if (await handleApi(req, res, { ...deps, device, hub })) return
      sendError(res, 404, 'not-found', '这个接口还没有实现')
    } catch (err) {
      // 服务跑在主进程里：任何一条路径上漏出来的异常都会变成未捕获异常，绝不能让它带走整个应用
      console.warn('[mobile] 处理请求时抛错：', err)
      if (res.headersSent) res.end()
      else sendError(res, 500, 'server', '电脑端处理这个请求时出错了')
    }
  }
}

/** 各网卡上手机能用的地址。只挑 IPv4、非 internal 且是私网的，公网地址给出去等于教人从外面连 */
function lanUrls(port: number): string[] {
  const urls: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal || !isPrivateAddress(ni.address)) continue
      const url = `http://${ni.address}:${port}`
      if (!urls.includes(url)) urls.push(url)
    }
  }
  return urls
}

class MobileServerImpl implements MobileServer {
  private server: Server | null = null
  private currentPort: number | null = null
  private readonly hub = createSseHub()
  /** 记下所有连接：SSE 是长连接，close() 会一直等它们自己结束，不掐掉就停不下来 */
  private readonly sockets = new Set<Socket>()

  constructor(private readonly deps: ServerDeps) {}

  get running(): boolean {
    return this.server !== null
  }

  get port(): number | null {
    return this.currentPort
  }

  start(port: number): Promise<{ port: number; urls: string[] }> {
    if (this.server !== null) {
      return Promise.reject(new Error('手机端服务已经在运行了，要换端口请先停掉再启动'))
    }
    const handler = createRequestHandler(this.deps, this.hub)
    const server = createServer((req, res) => {
      void handler(req, res)
    })
    server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })
    this.server = server

    return new Promise((done, fail) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening)
        this.server = null
        this.currentPort = null
        // 端口占用是最常见的那种失败（另一个实例开着、或者被别的软件占了）：
        // 消息要能直接显示给用户看，而不是让设置页上出现一句 EADDRINUSE
        fail(
          new Error(
            err.code === 'EADDRINUSE'
              ? `端口 ${port} 已被占用，换一个端口再开手机端服务`
              : `手机端服务在端口 ${port} 上启动失败：${err.message}`,
            { cause: err },
          ),
        )
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        // 监听之后才出的错（网卡掉线之类）没有人 await 了，不接住就是未捕获异常
        server.on('error', (e) => console.warn('[mobile] 服务出错：', e))
        const addr = server.address()
        this.currentPort = typeof addr === 'object' && addr !== null ? addr.port : port
        done({ port: this.currentPort, urls: lanUrls(this.currentPort) })
      }
      server.once('error', onError)
      server.once('listening', onListening)
      // 0.0.0.0：手机是从别的网卡连进来的，只绑 127.0.0.1 它就连不上。
      // 安全靠 handler 里的来源校验与令牌，不靠绑定地址
      server.listen(port, '0.0.0.0')
    })
  }

  stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.currentPort = null
    if (server === null) return Promise.resolve()
    return new Promise((done) => {
      server.close(() => done())
      // close 只是不再收新连接，已有的 SSE 与 keep-alive 连接会让它一直等下去
      for (const socket of this.sockets) socket.destroy()
      this.sockets.clear()
    })
  }
}

export function createMobileServer(deps: ServerDeps): MobileServer {
  return new MobileServerImpl(deps)
}
