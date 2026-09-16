import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppEvents } from '../../../src/main/appEvents'
import { ConfigStore } from '../../../src/main/config-store'
import type { GenRunner } from '../../../src/main/gen/runner'
import type { MainServices } from '../../../src/main/ipc'
import type { TagData } from '../../../src/main/llm/data'
import type { RunnerDeps } from '../../../src/main/llm/runner'
import { LlmSession } from '../../../src/main/llm/session'
import type { SecretStore } from '../../../src/main/secret-store'
import { createDeviceStore, type DeviceStore } from '../../../src/main/server/devices'
import { createMobileServer, type MobileServer, type ServerDeps } from '../../../src/main/server/http'
import { JsonStore } from '../../../src/main/store'
import { defaultAppConfig } from '../../../src/shared/config'
import type { MobileEvent, MobileMeta } from '../../../src/shared/mobileApi'
import type { NaiSubscriptionResult } from '../../../src/shared/naiUser'
import { normalizeWorkspace } from '../../../src/shared/workspace'

/**
 * Task 8 的 LLM 接口与 SSE：同 routes-styles.test.ts，起真实服务用 fetch 打自己，
 * SSE 用 fetch 的可读流一块块解析。
 *
 * 这里跑的是**真的** LlmSession + runLlm，只把 RunnerDeps 换成测试能掐住的那份：
 * apiKey 留空时 runLlm 走「没填 Key」那条最短路径（一行日志 + failed），要一轮跑不完时
 * 就让 prepareData 挂在那儿。假一个 LlmSession 出来的话，在途保护与中止这两条正是
 * 要验的东西就全被假掉了。
 */

let dir: string
let devices: DeviceStore
let configStore: ConfigStore
let stylesStore: JsonStore<unknown>
let workspaceStore: JsonStore<unknown>
let wsPath: string
let events: AppEvents
let llmSession: LlmSession
let server: MobileServer
let base: string

/** make 被调了几次：入参不合法时必须一次都没调（「不碰 LlmSession」） */
let makeCalls: number
/** 留空时 runLlm 立刻以 failed 收尾；给了值就会走到 prepareData */
let runnerApiKey: string
/** 掐住 prepareData：调用它就把这一轮停在这儿，直到测试放行 */
let releasePrepare: (() => void) | null

const VALID_INPUT = {
  instruction: '画一只猫',
  multiCharacter: 'off',
  editExisting: false,
  transparent: false,
  style: { mode: 'none' },
  workspace: null,
}

function makeDeps(): ServerDeps {
  const services: MainServices = {
    configStore,
    secrets: {} as unknown as SecretStore,
    stylesStore,
    workspaceStore,
    genRunner: {
      get busy() {
        return false
      },
    } as unknown as GenRunner,
    llmSession,
    events,
  }
  return {
    services,
    devices,
    staticDir: dir,
    makeThumbnail: (png) => png,
    fetchUsage: () =>
      Promise.resolve({ ok: false, error: { kind: 'no-token', message: '未配置 Token' } } as NaiSubscriptionResult),
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mobile-routes-llm-'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html>')
  devices = createDeviceStore(join(dir, 'devices.json'))
  configStore = new ConfigStore(dir)
  wsPath = join(dir, 'workspace.json')
  stylesStore = new JsonStore<unknown>(join(dir, 'styles.json'), () => [])
  workspaceStore = new JsonStore<unknown>(wsPath, () => null)
  events = new AppEvents()

  makeCalls = 0
  runnerApiKey = ''
  releasePrepare = null
  llmSession = new LlmSession((_input, signal, emit): RunnerDeps => {
    makeCalls += 1
    return {
      config: defaultAppConfig(),
      apiKey: runnerApiKey,
      chat: () => Promise.reject(new Error('这些测试不会真的发请求')),
      prepareData: () =>
        new Promise<TagData>((resolve) => {
          // 中止那条路径上 runLlm 在 await 之后立刻 checkAbort，拿不到这个值就抛了
          releasePrepare = () => resolve(null as unknown as TagData)
        }),
      manuals: new Map(),
      manualToc: '',
      skillCore: '',
      signal,
      emit,
    }
  })

  server = createMobileServer(makeDeps())
  const started = await server.start(0)
  base = `http://127.0.0.1:${started.port}`
})

afterEach(async () => {
  await server.stop()
  rmSync(dir, { recursive: true, force: true })
})

async function pairToken(): Promise<string> {
  const { code } = devices.newPairingCode()
  const r = await fetch(`${base}/api/pair`, { method: 'POST', body: JSON.stringify({ code, deviceName: '测试机' }) })
  return ((await r.json()) as { token: string }).token
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

async function post(path: string, token: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: auth(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, body: await r.json() }
}

interface EventStream {
  /** 到目前为止收到的全部事件，按到达顺序 */
  received: MobileEvent[]
  waitFor(kind: MobileEvent['kind']): Promise<MobileEvent>
  close(): void
}

/** 开一条 SSE 连接并在后台解析。心跳与 `: connected` 是注释行，直接跳过 */
async function openEvents(token: string): Promise<EventStream> {
  const ac = new AbortController()
  const r = await fetch(`${base}/api/events`, { headers: auth(token), signal: ac.signal })
  expect(r.status).toBe(200)
  const reader = r.body!.getReader()
  const received: MobileEvent[] = []
  const waiters: { kind: string; resolve: (e: MobileEvent) => void }[] = []
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
              if (w.kind === e.kind) w.resolve(e)
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
    waitFor(kind) {
      const already = received.find((e) => e.kind === kind)
      if (already !== undefined) return Promise.resolve(already)
      return new Promise<MobileEvent>((resolve, reject) => {
        // 不等到天荒地老：超时了要让测试报「没等到这条事件」，而不是挂到 vitest 的总超时
        const timer = setTimeout(() => reject(new Error(`没等到 ${kind} 事件，收到的是 ${JSON.stringify(received)}`)), 3000)
        waiters.push({
          kind,
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

describe('POST /api/llm/run', () => {
  it('入参不合法 → 400，一次都不碰 LlmSession', async () => {
    const token = await pairToken()
    const { status, body } = await post('/api/llm/run', token, {})
    expect(status).toBe(400)
    expect((body as { error: { kind: string } }).error.kind).toBe('bad-request')
    expect(makeCalls).toBe(0)
    expect(llmSession.busy).toBe(false)
  })

  it('请求体不是 JSON → 400', async () => {
    const token = await pairToken()
    const r = await fetch(`${base}/api/llm/run`, { method: 'POST', headers: auth(token), body: '这不是 JSON' })
    expect(r.status).toBe(400)
    expect(makeCalls).toBe(0)
  })

  it('开跑就回 { ok: true }，不等这一轮跑完', async () => {
    runnerApiKey = 'sk-test'
    const token = await pairToken()
    const { status, body } = await post('/api/llm/run', token, VALID_INPUT)
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true })
    // 这一轮还停在 prepareData 上，响应却已经回来了
    expect(llmSession.busy).toBe(true)
  })

  it('电脑正在跑 → 409 busy，message 是能直接显示的中文一句话', async () => {
    runnerApiKey = 'sk-test'
    const token = await pairToken()
    await post('/api/llm/run', token, VALID_INPUT)
    const { status, body } = await post('/api/llm/run', token, VALID_INPUT)
    expect(status).toBe(409)
    const { error } = body as { error: { kind: string; message: string } }
    expect(error.kind).toBe('busy')
    expect(error.message).toContain('正在')
    // 第二次没有开出第二轮来
    expect(makeCalls).toBe(1)
  })

  it('在途时 GET /api/meta 的 busy.llm 为真（手机靠它知道电脑在忙）', async () => {
    runnerApiKey = 'sk-test'
    const token = await pairToken()
    await post('/api/llm/run', token, VALID_INPUT)
    const meta = (await (await fetch(`${base}/api/meta`, { headers: auth(token) })).json()) as MobileMeta
    expect(meta.busy.llm).toBe(true)
  })

  it('没带令牌 → 401，不开跑', async () => {
    const r = await fetch(`${base}/api/llm/run`, { method: 'POST', body: JSON.stringify(VALID_INPUT) })
    expect(r.status).toBe(401)
    expect(makeCalls).toBe(0)
  })
})

describe('SSE 上的 LLM 事件', () => {
  it('日志与结束事件按顺序推给手机', async () => {
    const token = await pairToken()
    const stream = await openEvents(token)
    // apiKey 留空：runLlm 记一行错误日志就以 failed 收尾
    await post('/api/llm/run', token, VALID_INPUT)
    const finished = await stream.waitFor('llm-finished')

    expect(stream.received.map((e) => e.kind)).toEqual(['llm-log', 'llm-finished'])
    const log = stream.received[0] as Extract<MobileEvent, { kind: 'llm-log' }>
    expect(log.line.level).toBe('E')
    expect(log.line.text).toContain('API Key')
    expect((finished as Extract<MobileEvent, { kind: 'llm-finished' }>).result).toMatchObject({
      status: 'failed',
      message: '还没有填写 API Key',
    })
    stream.close()
  })

  it('两台手机都收到同一轮的事件', async () => {
    const token = await pairToken()
    const a = await openEvents(token)
    const b = await openEvents(token)
    await post('/api/llm/run', token, VALID_INPUT)
    await Promise.all([a.waitFor('llm-finished'), b.waitFor('llm-finished')])
    expect(a.received.map((e) => e.kind)).toEqual(b.received.map((e) => e.kind))
    a.close()
    b.close()
  })

  it('依赖没接上时也推一条 failed 的 llm-finished，不留未处理的 rejection', async () => {
    const rejections: unknown[] = []
    const onRejection = (e: unknown): void => {
      rejections.push(e)
    }
    process.on('unhandledRejection', onRejection)
    try {
      llmSession = new LlmSession(() => {
        throw new Error('依赖没接上')
      })
      await server.stop()
      server = createMobileServer(makeDeps())
      base = `http://127.0.0.1:${(await server.start(0)).port}`

      const token = await pairToken()
      const stream = await openEvents(token)
      const { status } = await post('/api/llm/run', token, VALID_INPUT)
      expect(status).toBe(200)
      const finished = (await stream.waitFor('llm-finished')) as Extract<MobileEvent, { kind: 'llm-finished' }>
      expect(finished.result.status).toBe('failed')
      expect(finished.result).toMatchObject({ message: '依赖没接上' })
      stream.close()
      // 让 node 有机会把未处理的 rejection 报出来
      await new Promise((r) => setTimeout(r, 50))
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })
})

describe('POST /api/llm/abort', () => {
  it('中止在途那一轮，手机从 SSE 看到 aborted', async () => {
    runnerApiKey = 'sk-test'
    const token = await pairToken()
    const stream = await openEvents(token)
    await post('/api/llm/run', token, VALID_INPUT)
    expect(llmSession.busy).toBe(true)

    const { status } = await post('/api/llm/abort', token)
    expect(status).toBe(200)
    // runLlm 在 prepareData 之后才查中止标志，所以要放它往下走一步
    releasePrepare?.()
    const finished = (await stream.waitFor('llm-finished')) as Extract<MobileEvent, { kind: 'llm-finished' }>
    expect(finished.result.status).toBe('aborted')
    expect(llmSession.busy).toBe(false)
    stream.close()
  })

  it('没有在途的那一轮时也回 200（手机上重复点中止不该报错）', async () => {
    const token = await pairToken()
    const { status } = await post('/api/llm/abort', token)
    expect(status).toBe(200)
  })
})

describe('服务端绝不写 workspace.json', () => {
  it('跑完一轮后工作区文件一字未变', async () => {
    const ws = normalizeWorkspace(null)
    ws.main.count = '2'
    ws.negative = '桌面端的负面词'
    ws.console.presetId = 'keep-me'
    workspaceStore.write(ws)
    const before = readFileSync(wsPath, 'utf8')

    const token = await pairToken()
    const stream = await openEvents(token)
    // 手机发来的工作区里塞了别的内容：服务端要是把它落盘，这里就会被改掉
    await post('/api/llm/run', token, { ...VALID_INPUT, workspace: { ...ws, negative: '手机那一份' } })
    await stream.waitFor('llm-finished')
    stream.close()

    expect(readFileSync(wsPath, 'utf8')).toBe(before)
  })
})
