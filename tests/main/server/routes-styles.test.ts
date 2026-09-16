import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppEvents } from '../../../src/main/appEvents'
import { ConfigStore } from '../../../src/main/config-store'
import type { GenRunner } from '../../../src/main/gen/runner'
import type { MainServices } from '../../../src/main/ipc'
import { LlmSession } from '../../../src/main/llm/session'
import type { SecretStore } from '../../../src/main/secret-store'
import { createDeviceStore, type DeviceStore } from '../../../src/main/server/devices'
import { createMobileServer, type MobileServer, type ServerDeps } from '../../../src/main/server/http'
import { JsonStore } from '../../../src/main/store'
import type { NaiSubscriptionResult } from '../../../src/shared/naiUser'
import type { StylePreset } from '../../../src/shared/styles'
import { normalizeWorkspace, type Workspace } from '../../../src/shared/workspace'

/**
 * Task 7 画风写接口的测试：同 routes-read.test.ts，起真实服务用 fetch 打自己。
 *
 * 这里额外要盯的是 Global Constraints 里的归属规则：增删改/排序四个接口绝不能碰
 * workspace.json，「选为预设」是全服务唯一允许写它的接口，且只能动 console.presetId。
 */

let dir: string
let devices: DeviceStore
let configStore: ConfigStore
let stylesStore: JsonStore<unknown>
let workspaceStore: JsonStore<unknown>
let stylesPath: string
let wsPath: string
let events: AppEvents
let llmSession: LlmSession
let server: MobileServer
let base: string

function makeDeps(): ServerDeps {
  const services: MainServices = {
    configStore,
    secrets: {} as unknown as SecretStore,
    stylesStore,
    workspaceStore,
    genRunner: { get busy() { return false } } as unknown as GenRunner,
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
  dir = mkdtempSync(join(tmpdir(), 'mobile-routes-styles-'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html>')
  devices = createDeviceStore(join(dir, 'devices.json'))
  configStore = new ConfigStore(dir)
  stylesPath = join(dir, 'styles.json')
  wsPath = join(dir, 'workspace.json')
  stylesStore = new JsonStore<unknown>(stylesPath, () => [])
  workspaceStore = new JsonStore<unknown>(wsPath, () => null)
  events = new AppEvents()
  llmSession = new LlmSession(() => {
    throw new Error('routes-styles 测试不会真的跑一轮 LLM')
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
  const body = (await r.json()) as { token: string }
  return body.token
}

async function call(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, body: await r.json() }
}

function readStyles(): StylePreset[] {
  return JSON.parse(readFileSync(stylesPath, 'utf8')) as StylePreset[]
}

describe('POST /api/styles', () => {
  it('新建返回带新 id 的画风，并写进 styles.json', async () => {
    const token = await pairToken()
    const { status, body } = await call('POST', '/api/styles', token, { name: '厚涂', tags: 'artist:wlop' })
    expect(status).toBe(200)
    const created = body as StylePreset
    expect(created.name).toBe('厚涂')
    expect(created.tags).toBe('artist:wlop')
    expect(created.id).toBeTruthy()

    const saved = readStyles()
    expect(saved).toEqual([created])
  })

  it('不是对象时 400', async () => {
    const token = await pairToken()
    const { status, body } = await call('POST', '/api/styles', token, [1, 2, 3])
    expect(status).toBe(400)
    expect((body as { error: { kind: string } }).error.kind).toBe('bad-request')
  })
})

describe('PATCH /api/styles/:id', () => {
  it('改名与改标签只动指定那条', async () => {
    stylesStore.write([
      { id: 'st-1', name: 'A', tags: 'a' },
      { id: 'st-2', name: 'B', tags: 'b' },
    ])
    const token = await pairToken()
    const { status, body } = await call('PATCH', '/api/styles/st-1', token, { name: 'A2', tags: 'a2' })
    expect(status).toBe(200)
    expect(body).toEqual({ id: 'st-1', name: 'A2', tags: 'a2' })
    expect(readStyles()).toEqual([
      { id: 'st-1', name: 'A2', tags: 'a2' },
      { id: 'st-2', name: 'B', tags: 'b' },
    ])
  })

  it('只给 name 时不动 tags', async () => {
    stylesStore.write([{ id: 'st-1', name: 'A', tags: 'a' }])
    const token = await pairToken()
    const { body } = await call('PATCH', '/api/styles/st-1', token, { name: 'A2' })
    expect(body).toEqual({ id: 'st-1', name: 'A2', tags: 'a' })
  })

  it('id 不存在 404', async () => {
    const token = await pairToken()
    const { status, body } = await call('PATCH', '/api/styles/nope', token, { name: 'x' })
    expect(status).toBe(404)
    expect((body as { error: { kind: string } }).error.kind).toBe('not-found')
  })
})

describe('DELETE /api/styles/:id', () => {
  it('删除后列表里没有它', async () => {
    stylesStore.write([
      { id: 'st-1', name: 'A', tags: 'a' },
      { id: 'st-2', name: 'B', tags: 'b' },
    ])
    const token = await pairToken()
    const { status } = await call('DELETE', '/api/styles/st-1', token)
    expect(status).toBe(200)
    expect(readStyles().map((s) => s.id)).toEqual(['st-2'])
  })

  it('id 不存在 404', async () => {
    const token = await pairToken()
    const { status, body } = await call('DELETE', '/api/styles/nope', token)
    expect(status).toBe(404)
    expect((body as { error: { kind: string } }).error.kind).toBe('not-found')
  })
})

describe('POST /api/styles/order', () => {
  it('按给的 id 顺序落盘', async () => {
    stylesStore.write([
      { id: 'st-1', name: 'A', tags: 'a' },
      { id: 'st-2', name: 'B', tags: 'b' },
      { id: 'st-3', name: 'C', tags: 'c' },
    ])
    const token = await pairToken()
    const { status } = await call('POST', '/api/styles/order', token, { ids: ['st-3', 'st-1', 'st-2'] })
    expect(status).toBe(200)
    expect(readStyles().map((s) => s.id)).toEqual(['st-3', 'st-1', 'st-2'])
  })

  it('缺一个 id 时 400，不落盘', async () => {
    stylesStore.write([
      { id: 'st-1', name: 'A', tags: 'a' },
      { id: 'st-2', name: 'B', tags: 'b' },
    ])
    const token = await pairToken()
    const { status } = await call('POST', '/api/styles/order', token, { ids: ['st-1'] })
    expect(status).toBe(400)
    expect(readStyles().map((s) => s.id)).toEqual(['st-1', 'st-2'])
  })

  it('多一个不存在的 id 时 400', async () => {
    stylesStore.write([{ id: 'st-1', name: 'A', tags: 'a' }])
    const token = await pairToken()
    const { status } = await call('POST', '/api/styles/order', token, { ids: ['st-1', 'st-x'] })
    expect(status).toBe(400)
  })

  it('id 重复时 400', async () => {
    stylesStore.write([
      { id: 'st-1', name: 'A', tags: 'a' },
      { id: 'st-2', name: 'B', tags: 'b' },
    ])
    const token = await pairToken()
    const { status } = await call('POST', '/api/styles/order', token, { ids: ['st-1', 'st-1'] })
    expect(status).toBe(400)
  })
})

describe('POST /api/styles/:id/preset', () => {
  function seedWorkspace(): Workspace {
    const ws = normalizeWorkspace(null)
    ws.main.count = '2'
    ws.negative = '原有负面词'
    ws.params.width = 832
    ws.console.presetId = ''
    workspaceStore.write(ws)
    return ws
  }

  it('会写桌面端工作区的 console.presetId', async () => {
    stylesStore.write([{ id: 'st-1', name: 'A', tags: 'a' }])
    seedWorkspace()
    const token = await pairToken()
    const { status } = await call('POST', '/api/styles/st-1/preset', token)
    expect(status).toBe(200)
    const saved = normalizeWorkspace(JSON.parse(readFileSync(wsPath, 'utf8')))
    expect(saved.console.presetId).toBe('st-1')
  })

  it('不动工作区里的提示词字段', async () => {
    stylesStore.write([{ id: 'st-1', name: 'A', tags: 'a' }])
    const before = seedWorkspace()
    const token = await pairToken()
    await call('POST', '/api/styles/st-1/preset', token)
    const saved = normalizeWorkspace(JSON.parse(readFileSync(wsPath, 'utf8')))
    expect(saved.main.count).toBe(before.main.count)
    expect(saved.negative).toBe(before.negative)
    expect(saved.params).toEqual(before.params)
  })

  it('id 不存在 404，不碰工作区文件', async () => {
    seedWorkspace()
    const before = readFileSync(wsPath, 'utf8')
    const token = await pairToken()
    const { status } = await call('POST', '/api/styles/nope/preset', token)
    expect(status).toBe(404)
    expect(readFileSync(wsPath, 'utf8')).toBe(before)
  })
})

describe('增删改排序四个接口绝不碰 workspace.json', () => {
  it('新建、改名、排序、删除全程不写工作区文件', async () => {
    const ws = normalizeWorkspace(null)
    ws.console.presetId = 'keep-me'
    workspaceStore.write(ws)
    const before = readFileSync(wsPath, 'utf8')

    stylesStore.write([{ id: 'st-1', name: 'A', tags: 'a' }])
    const token = await pairToken()

    await call('POST', '/api/styles', token, { name: 'N', tags: 't' })
    await call('PATCH', '/api/styles/st-1', token, { name: 'A2' })
    const ids = readStyles().map((s) => s.id)
    await call('POST', '/api/styles/order', token, { ids: [...ids].reverse() })
    await call('DELETE', '/api/styles/st-1', token)

    expect(readFileSync(wsPath, 'utf8')).toBe(before)
  })
})
