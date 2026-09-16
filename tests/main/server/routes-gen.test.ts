import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppEvents } from '../../../src/main/appEvents'
import { ConfigStore } from '../../../src/main/config-store'
import { GenRunner } from '../../../src/main/gen/runner'
import { LlmSession } from '../../../src/main/llm/session'
import type { NaiRequestBody } from '../../../src/main/nai/payload'
import type { SecretStore } from '../../../src/main/secret-store'
import { createDeviceStore, type DeviceStore } from '../../../src/main/server/devices'
import { createMobileServer, type MobileServer, type ServerDeps } from '../../../src/main/server/http'
import { forwardGenEvents } from '../../../src/main/server/routes'
import type { SseHub } from '../../../src/main/server/sse'
import type { MainServices } from '../../../src/main/ipc'
import { JsonStore } from '../../../src/main/store'
import { defaultAppConfig } from '../../../src/shared/config'
import type { GenerateResult, RoundRecord, RunProgress } from '../../../src/shared/gen'
import type { MobileEvent } from '../../../src/shared/mobileApi'
import type { NaiSubscriptionResult } from '../../../src/shared/naiUser'
import { normalizeWorkspace, type Workspace } from '../../../src/shared/workspace'

/**
 * Task 9 的出图接口与 SSE：同 routes-llm.test.ts，起真实服务用 fetch 打自己，
 * SSE 用 fetch 的可读流一块块解析。
 *
 * 这里跑的是**真的** GenRunner + RunQueue，只把「发请求」「等一会儿」两样换成测试掐得住的：
 * 在途保护、429 暂停、取消这三样正是要验的东西，假一个 GenRunner 出来就全被假掉了。
 * 图真的会落盘，落在临时目录里，afterEach 一并删掉。
 */

let dir: string
/** 出图保存目录，与 userData 目录分开——历史接口扫的是它 */
let saveDir: string
let devices: DeviceStore
let configStore: ConfigStore
let stylesStore: JsonStore<unknown>
let workspaceStore: JsonStore<unknown>
let wsPath: string
let events: AppEvents
let genRunner: GenRunner
let server: MobileServer
let base: string

/** secrets 只被出图这条路径用到一处：开跑那一刻读 naiToken */
let naiToken: string
/** 每次 generate 的入参，长度就是「第几次调用」 */
let bodies: NaiRequestBody[]
/** 第 n 次调用（从 1 数）返回什么 */
let respond: (nth: number) => Promise<GenerateResult>
/** hang() 挂起的那次 generate 的放行钩子 */
let release: ((r: GenerateResult) => void) | null

function okResult(seed = 777): GenerateResult {
  return { ok: true, images: [{ data: Buffer.from('PNG').toString('base64'), mimeType: 'image/png', seed }] }
}

/** 让这一次 generate 停在半空，直到测试调 release —— 用来造「一轮正在跑」的局面 */
function hang(): Promise<GenerateResult> {
  return new Promise<GenerateResult>((resolve) => {
    release = resolve
  })
}

function makeServices(): MainServices {
  return {
    configStore,
    secrets: { read: (name: string) => (name === 'naiToken' ? naiToken : '') } as unknown as SecretStore,
    stylesStore,
    workspaceStore,
    genRunner,
    llmSession: new LlmSession(() => {
      throw new Error('routes-gen 测试不会真的跑一轮 LLM')
    }),
    events,
  }
}

function makeDeps(): ServerDeps {
  return {
    services: makeServices(),
    devices,
    staticDir: dir,
    makeThumbnail: (png) => png,
    fetchUsage: () =>
      Promise.resolve({ ok: false, error: { kind: 'no-token', message: '未配置 Token' } } as NaiSubscriptionResult),
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mobile-routes-gen-'))
  saveDir = join(dir, 'images')
  writeFileSync(join(dir, 'index.html'), '<!doctype html>')
  devices = createDeviceStore(join(dir, 'devices.json'))
  configStore = new ConfigStore(dir)
  configStore.write({ ...defaultAppConfig(), saveDir, retryCount: 0 })
  wsPath = join(dir, 'workspace.json')
  stylesStore = new JsonStore<unknown>(join(dir, 'styles.json'), () => [])
  workspaceStore = new JsonStore<unknown>(wsPath, () => null)
  events = new AppEvents()

  naiToken = 'pst-test'
  bodies = []
  respond = () => Promise.resolve(okResult())
  release = null
  genRunner = new GenRunner({
    generate: (body) => {
      bodies.push(body)
      return respond(bodies.length)
    },
    // 间隔与重试等待都不真等：这些测试验的是接口与事件，不是节流
    sleep: () => Promise.resolve(),
    // 与 ipc.ts 里的接法一致：出图事件先进总线，服务再从总线转推给 SSE
    onProgress: (p) => events.emit({ kind: 'gen-progress', progress: p }),
    onImage: (e) => events.emit({ kind: 'gen-image', image: e }),
    onSeedResolved: (seed) => events.emit({ kind: 'gen-seed', seed }),
    now: () => new Date(),
    randomSeed: () => 4242,
  })

  server = createMobileServer(makeDeps())
  base = `http://127.0.0.1:${(await server.start(0)).port}`
})

afterEach(async () => {
  // 可能还有一轮挂在 generate 上：先取消，再把在途那一次放掉，让它有机会收场。
  // 不收场的话临时目录删不掉，afterEach 之后那一轮还会往总线上发事件
  genRunner.cancel()
  for (let i = 0; i < 300 && genRunner.busy; i += 1) {
    release?.(okResult())
    release = null
    await new Promise((r) => setTimeout(r, 10))
  }
  await server.stop()
  rmSync(dir, { recursive: true, force: true })
})

/** 轮询等一个条件成真。出图那一轮的收场只能这么盯——它没有可 await 的句柄 */
async function waitUntil(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(label)
}

async function pairToken(): Promise<string> {
  const { code } = devices.newPairingCode()
  const r = await fetch(`${base}/api/pair`, { method: 'POST', body: JSON.stringify({ code, deviceName: '测试机' }) })
  return ((await r.json()) as { token: string }).token
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

async function get<T>(path: string, token: string): Promise<T> {
  const r = await fetch(`${base}${path}`, { headers: auth(token) })
  return (await r.json()) as T
}

async function post(path: string, token: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: auth(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, body: await r.json() }
}

/** 手机发来的那份工作区：与桌面端那份长得不一样，落盘时才分得清用的是哪一份 */
function phoneWorkspace(): Workspace {
  const ws = normalizeWorkspace(null)
  ws.main.count = '1girl'
  ws.negative = '手机那一份'
  return ws
}

interface EventStream {
  received: MobileEvent[]
  waitFor(match: (e: MobileEvent) => boolean, label: string): Promise<MobileEvent>
  close(): void
}

/** 开一条 SSE 连接并在后台解析。心跳与 `: connected` 是注释行，直接跳过 */
async function openEvents(token: string): Promise<EventStream> {
  const ac = new AbortController()
  const r = await fetch(`${base}/api/events`, { headers: auth(token), signal: ac.signal })
  expect(r.status).toBe(200)
  const reader = r.body!.getReader()
  const received: MobileEvent[] = []
  const waiters: { match: (e: MobileEvent) => boolean; resolve: (e: MobileEvent) => void }[] = []
  const decoder = new TextDecoder()
  let buffer = ''

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        let idx = buffer.indexOf('\n\n')
        while (idx !== -1) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          if (block.startsWith('data: ')) {
            const e = JSON.parse(block.slice('data: '.length)) as MobileEvent
            received.push(e)
            for (const w of waiters.splice(0).reverse()) {
              if (w.match(e)) w.resolve(e)
              else waiters.push(w)
            }
          }
          idx = buffer.indexOf('\n\n')
        }
      }
    } catch {
      /* 连接被 close() 或 server.stop() 掐掉，正常收场 */
    }
  })()

  return {
    received,
    waitFor(match, label) {
      const already = received.find(match)
      if (already !== undefined) return Promise.resolve(already)
      return new Promise<MobileEvent>((resolve, reject) => {
        // 不等到天荒地老：超时了要让测试报「没等到这条事件」，而不是挂到 vitest 的总超时
        const timer = setTimeout(() => reject(new Error(`没等到${label}，收到的是 ${JSON.stringify(received)}`)), 3000)
        waiters.push({
          match,
          resolve: (e) => {
            clearTimeout(timer)
            resolve(e)
          },
        })
      })
    },
    close() {
      ac.abort()
    },
  }
}

type ProgressEvent = Extract<MobileEvent, { kind: 'gen-progress' }>
type ImageEvent = Extract<MobileEvent, { kind: 'gen-image' }>

function progresses(stream: EventStream): RunProgress[] {
  return stream.received.filter((e): e is ProgressEvent => e.kind === 'gen-progress').map((e) => e.progress)
}

function images(stream: EventStream): ImageEvent['image'][] {
  return stream.received.filter((e): e is ImageEvent => e.kind === 'gen-image').map((e) => e.image)
}

function isProgress(status: RunProgress['status']): (e: MobileEvent) => boolean {
  return (e) => e.kind === 'gen-progress' && e.progress.status === status
}

describe('POST /api/gen/start', () => {
  it('入参不合法 → 400，一次都不开跑', async () => {
    const token = await pairToken()
    const { status, body } = await post('/api/gen/start', token, { workspace: phoneWorkspace(), count: 0 })
    expect(status).toBe(400)
    expect((body as { error: { kind: string } }).error.kind).toBe('bad-request')
    expect(bodies).toEqual([])
    expect(genRunner.busy).toBe(false)
  })

  it('请求体不是 JSON → 400', async () => {
    const token = await pairToken()
    const r = await fetch(`${base}/api/gen/start`, { method: 'POST', headers: auth(token), body: '这不是 JSON' })
    expect(r.status).toBe(400)
    expect(bodies).toEqual([])
  })

  it('没带令牌 → 401，不开跑', async () => {
    const r = await fetch(`${base}/api/gen/start`, {
      method: 'POST',
      body: JSON.stringify({ workspace: phoneWorkspace(), count: 1 }),
    })
    expect(r.status).toBe(401)
    expect(bodies).toEqual([])
  })

  it('开跑就回 roundId，不等整轮跑完', async () => {
    respond = () => hang()
    const token = await pairToken()
    const stream = await openEvents(token)
    const { status, body } = await post('/api/gen/start', token, { workspace: phoneWorkspace(), count: 3 })
    expect(status).toBe(200)
    const { roundId } = body as { roundId: string }
    expect(roundId).toBeTruthy()
    // 第一张还挂在 generate 上，响应却已经回来了
    expect(genRunner.busy).toBe(true)
    expect(bodies).toHaveLength(1)

    // 回话里的 roundId 与 SSE 上那一轮的对得上，手机才分得清哪一轮是自己的
    const first = (await stream.waitFor((e) => e.kind === 'gen-progress', 'gen-progress')) as ProgressEvent
    expect(first.progress.roundId).toBe(roundId)
    stream.close()
  })

  it('没设图片保存目录 → 500，把电脑那头的原话转给手机', async () => {
    configStore.write({ ...defaultAppConfig(), saveDir: '' })
    const token = await pairToken()
    const { status, body } = await post('/api/gen/start', token, { workspace: phoneWorkspace(), count: 1 })
    expect(status).toBe(500)
    const { error } = body as { error: { kind: string; message: string } }
    expect(error.kind).toBe('server')
    expect(error.message).toContain('保存目录')
    expect(bodies).toEqual([])
  })

  it('没填 Token → 500，不留一条空跑的轮次', async () => {
    naiToken = ''
    const token = await pairToken()
    const { status, body } = await post('/api/gen/start', token, { workspace: phoneWorkspace(), count: 1 })
    expect(status).toBe(500)
    expect((body as { error: { message: string } }).error.message).toContain('Token')
    expect(await get<RoundRecord[]>('/api/history', token)).toEqual([])
  })
})

describe('与桌面端共用同一个 GenRunner', () => {
  it('桌面端已有一轮在跑 → 手机拿 409 busy，message 是能直接显示的中文一句话', async () => {
    respond = () => hang()
    // 桌面端那条路径：ipc.ts 里就是这么直接调 genRunner.start 的
    const desktop = genRunner.start({ workspace: normalizeWorkspace(null), count: 1 }, configStore.read(), naiToken)
    expect(genRunner.busy).toBe(true)

    const token = await pairToken()
    const { status, body } = await post('/api/gen/start', token, { workspace: phoneWorkspace(), count: 1 })
    expect(status).toBe(409)
    const { error } = body as { error: { kind: string; message: string } }
    expect(error.kind).toBe('busy')
    expect(error.message).toContain('正在')
    // 没有开出第二轮来：还是桌面端那一张请求
    expect(bodies).toHaveLength(1)

    release?.(okResult())
    await desktop
  })

  it('手机已有一轮在跑 → 桌面端的 gen:start 被同一道闸拦下', async () => {
    respond = () => hang()
    const token = await pairToken()
    expect((await post('/api/gen/start', token, { workspace: phoneWorkspace(), count: 1 })).status).toBe(200)

    await expect(
      genRunner.start({ workspace: normalizeWorkspace(null), count: 1 }, configStore.read(), naiToken),
    ).rejects.toThrow('已有一轮正在进行中')
    expect(bodies).toHaveLength(1)
  })

  it('在途时 GET /api/meta 的 busy.gen 为真（手机靠它知道电脑在忙）', async () => {
    respond = () => hang()
    const token = await pairToken()
    await post('/api/gen/start', token, { workspace: phoneWorkspace(), count: 1 })
    const meta = await get<{ busy: { gen: boolean } }>('/api/meta', token)
    expect(meta.busy.gen).toBe(true)
  })
})

describe('SSE 上的出图事件', () => {
  it('进度与每张图都推给手机，最后一条是 done', async () => {
    const token = await pairToken()
    const stream = await openEvents(token)
    const { body } = await post('/api/gen/start', token, { workspace: phoneWorkspace(), count: 2 })
    const { roundId } = body as { roundId: string }

    await stream.waitFor(isProgress('done'), '整轮结束的进度')
    const shots = images(stream)
    expect(shots.map((i) => i.index)).toEqual([0, 1])
    expect(shots.every((i) => i.status === 'ok' && i.roundId === roundId && i.file !== '')).toBe(true)

    const ps = progresses(stream)
    expect(ps.every((p) => p.roundId === roundId)).toBe(true)
    expect(ps[ps.length - 1]).toMatchObject({ status: 'done', total: 2, done: 2, failed: 0 })
    stream.close()
  })

  it('两台手机都收到同一轮的事件', async () => {
    const token = await pairToken()
    const a = await openEvents(token)
    const b = await openEvents(token)
    await post('/api/gen/start', token, { workspace: phoneWorkspace(), count: 1 })
    await Promise.all([a.waitFor(isProgress('done'), '整轮结束'), b.waitFor(isProgress('done'), '整轮结束')])
    expect(a.received).toEqual(b.received)
    a.close()
    b.close()
  })

  it('转推只挂一次：多打几个请求之后，一条进度还是只推一遍', async () => {
    const token = await pairToken()
    const stream = await openEvents(token)
    await post('/api/gen/start', token, { workspace: phoneWorkspace(), count: 1 })
    await stream.waitFor(isProgress('done'), '整轮结束')
    await get('/api/meta', token)
    await get('/api/meta', token)
    const before = progresses(stream).length

    // 直接往总线上放一条：要是每个请求都挂一次订阅，这一条会被推好几遍
    const probe: RunProgress = {
      roundId: 'probe',
      status: 'running',
      total: 1,
      done: 0,
      failed: 0,
      pauseReason: null,
      abortReason: null,
      current: 0,
    }
    events.emit({ kind: 'gen-progress', progress: probe })
    await stream.waitFor((e) => e.kind === 'gen-progress' && e.progress.roundId === 'probe', '探针进度')
    expect(progresses(stream).filter((p) => p.roundId === 'probe')).toHaveLength(1)
    expect(progresses(stream).length).toBe(before + 1)
    stream.close()
  })

  it('gen-seed 不转推：那是回填桌面端参数区用的', async () => {
    const token = await pairToken()
    const stream = await openEvents(token)
    await post('/api/gen/start', token, { workspace: phoneWorkspace(), count: 1 })
    await stream.waitFor(isProgress('done'), '整轮结束')
    // 每张随机模式跑完会发一次 onSeedResolved，SSE 上不该出现它
    expect(stream.received.map((e) => e.kind as string)).not.toContain('gen-seed')
    stream.close()
  })
})

describe('POST /api/gen/cancel 与 /api/gen/resume', () => {
  it('取消在途那一轮，手机从 SSE 看到 cancelled', async () => {
    respond = () => hang()
    const token = await pairToken()
    const stream = await openEvents(token)
    await post('/api/gen/start', token, { workspace: phoneWorkspace(), count: 5 })
    await stream.waitFor(isProgress('running'), '开跑的进度')

    const { status } = await post('/api/gen/cancel', token)
    expect(status).toBe(200)
    await stream.waitFor(isProgress('cancelled'), '取消的进度')
    // 挂着的那张放行后整轮收场，剩下的 4 张一张都没发出去
    release?.(okResult())
    await waitUntil(() => !genRunner.busy, '取消后那一轮没有收场')
    expect(bodies).toHaveLength(1)
    stream.close()
  })

  it('429 暂停后 resume 从队首那张重发', async () => {
    // 第一次撞上「有别的客户端正在生成」，队列暂停、把这张留在队首等人工确认
    respond = (nth) =>
      Promise.resolve(
        nth === 1 ? { ok: false, error: { kind: 'concurrent', message: '有别的客户端正在生成' } } : okResult(),
      )
    const token = await pairToken()
    const stream = await openEvents(token)
    await post('/api/gen/start', token, { workspace: phoneWorkspace(), count: 1 })
    const paused = (await stream.waitFor(isProgress('paused'), '暂停的进度')) as ProgressEvent
    expect(paused.progress.pauseReason).toContain('别的客户端')

    const { status } = await post('/api/gen/resume', token)
    expect(status).toBe(200)
    await stream.waitFor(isProgress('done'), '继续之后整轮结束')
    // 同一张重发了一次，总共两次请求
    expect(bodies).toHaveLength(2)
    stream.close()
  })

  it('没有在途那一轮时也回 200（手机上重复点不该报错）', async () => {
    const token = await pairToken()
    expect((await post('/api/gen/cancel', token)).status).toBe(200)
    expect((await post('/api/gen/resume', token)).status).toBe(200)
  })
})

describe('服务端绝不写 workspace.json', () => {
  it('出图前后工作区文件一字未变，落盘的是手机发来的那份参数', async () => {
    const desktop = normalizeWorkspace(null)
    desktop.main.count = '2girls'
    desktop.negative = '桌面端的负面词'
    desktop.console.presetId = 'keep-me'
    workspaceStore.write(desktop)
    const before = readFileSync(wsPath, 'utf8')

    const token = await pairToken()
    const stream = await openEvents(token)
    await post('/api/gen/start', token, { workspace: phoneWorkspace(), count: 1 })
    await stream.waitFor(isProgress('done'), '整轮结束')
    stream.close()

    expect(readFileSync(wsPath, 'utf8')).toBe(before)
    // 这一轮用的确实是手机那份：落盘的快照里是手机的负面词，不是桌面端的
    const rounds = await get<RoundRecord[]>('/api/history', token)
    expect(rounds).toHaveLength(1)
    expect(rounds[0].snapshot.negative).toBe('手机那一份')
    expect(rounds[0].snapshot.main.count).toBe('1girl')
  })
})

describe('出图事件转推的订阅', () => {
  /**
   * 总线上还挂着几个订阅者。AppEvents 没有对外暴露这个数，这里摸了它的私有字段——
   * 「服务停掉要退订」除了数订阅者没有别的可观测点：停掉之后 SSE 连接本来就断了，
   * 光看手机收不收得到事件，退不退订都一样。
   */
  function listenerCount(bus: AppEvents): number {
    return (bus as unknown as { listeners: Set<unknown> }).listeners.size
  }

  it('forwardGenEvents 只转推出图的两种事件，退订后不再推', () => {
    const bus = new AppEvents()
    const pushed: MobileEvent[] = []
    const hub = { attach: () => () => {}, push: (e: MobileEvent) => pushed.push(e), count: 0 } as SseHub
    const progress: RunProgress = {
      roundId: 'r1',
      status: 'running',
      total: 1,
      done: 0,
      failed: 0,
      pauseReason: null,
      abortReason: null,
      current: 0,
    }
    const off = forwardGenEvents(bus, hub)
    bus.emit({ kind: 'gen-progress', progress })
    bus.emit({ kind: 'gen-image', image: { index: 0, file: 'a.png', seed: 1, status: 'ok', error: null, roundId: 'r1' } })
    bus.emit({ kind: 'gen-seed', seed: 9 })
    expect(pushed.map((e) => e.kind)).toEqual(['gen-progress', 'gen-image'])

    off()
    bus.emit({ kind: 'gen-progress', progress })
    expect(pushed).toHaveLength(2)
  })

  it('服务停掉时退订，总线上不留死订阅', async () => {
    const other = createMobileServer(makeDeps())
    const before = listenerCount(events)
    await other.start(0)
    expect(listenerCount(events)).toBe(before + 1)
    await other.stop()
    expect(listenerCount(events)).toBe(before)
  })

  it('端口被占用、根本没起来时不留订阅', async () => {
    const other = createMobileServer(makeDeps())
    const before = listenerCount(events)
    await expect(other.start(server.port!)).rejects.toThrow('占用')
    expect(listenerCount(events)).toBe(before)
  })
})
