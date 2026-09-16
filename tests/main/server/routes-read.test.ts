import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppEvents } from '../../../src/main/appEvents'
import { ConfigStore } from '../../../src/main/config-store'
import type { GenRunner } from '../../../src/main/gen/runner'
import type { MainServices } from '../../../src/main/ipc'
import { LlmSession } from '../../../src/main/llm/session'
import { IndexStore } from '../../../src/main/nai/index-store'
import { dateDirName } from '../../../src/main/nai/save'
import type { SecretStore } from '../../../src/main/secret-store'
import { createDeviceStore, type DeviceStore } from '../../../src/main/server/devices'
import { createMobileServer, type MobileServer, type ServerDeps } from '../../../src/main/server/http'
import { JsonStore } from '../../../src/main/store'
import { emptyValues } from '../../../src/shared/blockDoc'
import { mergeConfig } from '../../../src/shared/config'
import { MAIN_FIELDS } from '../../../src/shared/fields'
import type { RoundRecord } from '../../../src/shared/gen'
import type { NaiSubscriptionResult } from '../../../src/shared/naiUser'
import { defaultGenParams, normalizeWorkspace } from '../../../src/shared/workspace'

/**
 * Task 5 只读接口的测试：同 http.test.ts，起真实服务用 fetch 打自己。
 *
 * MainServices 里用不到的两样造假的：secrets 真实实现走 electron 的 safeStorage，
 * genRunner 这四个只读接口根本不碰——真造一份只会把 electron 拖进 node 测试进程，
 * 这也是 http.test.ts 里 `services: {} as unknown as MainServices` 同一个理由。
 */

let dir: string
let devices: DeviceStore
let configStore: ConfigStore
let stylesStore: JsonStore<unknown>
let workspaceStore: JsonStore<unknown>
let events: AppEvents
let llmSession: LlmSession
let fetchUsageCalls: number
let fetchUsageResult: NaiSubscriptionResult
let server: MobileServer
let base: string

function makeDeps(): ServerDeps {
  const services: MainServices = {
    configStore,
    secrets: {} as unknown as SecretStore,
    stylesStore,
    workspaceStore,
    genRunner: {} as unknown as GenRunner,
    llmSession,
    events,
  }
  return {
    services,
    devices,
    staticDir: dir,
    makeThumbnail: (png) => png,
    fetchUsage: () => {
      fetchUsageCalls++
      return Promise.resolve(fetchUsageResult)
    },
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mobile-routes-'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html>')
  devices = createDeviceStore(join(dir, 'devices.json'))
  configStore = new ConfigStore(dir)
  stylesStore = new JsonStore<unknown>(join(dir, 'styles.json'), () => [])
  workspaceStore = new JsonStore<unknown>(join(dir, 'workspace.json'), () => null)
  events = new AppEvents()
  llmSession = new LlmSession(() => {
    throw new Error('routes-read 测试不会真的跑一轮 LLM')
  })
  fetchUsageCalls = 0
  fetchUsageResult = { ok: false, error: { kind: 'no-token', message: '未配置 Token' } }

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

async function get(path: string, token: string): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  return { status: r.status, body: await r.json() }
}

describe('GET /api/meta', () => {
  it('给出字段集与上限，且不含任何密钥或完整路径', async () => {
    configStore.write(mergeConfig({ saveDir: 'C:\\Users\\test\\Pictures\\NAI' }))
    const token = await pairToken()
    const { status, body } = await get('/api/meta', token)
    expect(status).toBe(200)

    const meta = body as {
      apiVersion: number
      mainFields: { name: string }[]
      charFields: unknown[]
      maxCharacters: number
      maxPixels: number
      tokenLimit: number
      saveDirName: string
      busy: { llm: boolean; gen: boolean }
    }
    expect(meta.apiVersion).toBe(1)
    expect(meta.mainFields.map((f) => f.name)).toEqual([
      'count',
      'style',
      'character',
      'artist',
      'appearance',
      'tags',
      'environment',
      'series',
      'nltags',
      'quality',
    ])
    expect(meta.charFields).toHaveLength(5)
    expect(meta.maxCharacters).toBe(22)
    expect(meta.maxPixels).toBe(1024 * 1024)
    // 默认模型是 nai-diffusion-5-full，V5 的上限是 1471
    expect(meta.tokenLimit).toBe(1471)
    expect(meta.saveDirName).toBe('NAI')
    expect(meta.busy).toEqual({ llm: false, gen: false })

    const raw = JSON.stringify(meta)
    expect(raw).not.toContain('pst-')
    // 不含盘符路径：既不能有 "C:\" 这种前缀，也不能有目录里的用户名片段
    expect(raw).not.toMatch(/[A-Za-z]:[\\/]/)
    expect(raw).not.toContain('Users')
  })
})

describe('GET /api/styles', () => {
  it('给出画风与当前预设 id', async () => {
    stylesStore.write([{ id: 'st-1', name: '厚涂光影', tags: 'artist:wlop' }])
    const ws = normalizeWorkspace(null)
    ws.console.presetId = 'st-1'
    workspaceStore.write(ws)

    const token = await pairToken()
    const { status, body } = await get('/api/styles', token)
    expect(status).toBe(200)
    const result = body as { styles: { id: string; name: string; tags: string }[]; presetId: string }
    expect(result.styles).toEqual([{ id: 'st-1', name: '厚涂光影', tags: 'artist:wlop' }])
    expect(result.presetId).toBe('st-1')
  })
})

describe('GET /api/history', () => {
  it('读的是桌面端的记录', async () => {
    const saveDir = join(dir, 'saves')
    configStore.write(mergeConfig({ saveDir }))

    const startedAt = new Date()
    const round: RoundRecord = {
      id: 'round-today',
      startedAt: startedAt.toISOString(),
      finishedAt: startedAt.toISOString(),
      status: 'done',
      count: 1,
      snapshot: {
        main: emptyValues(MAIN_FIELDS),
        text: '',
        negative: '',
        characters: [],
        useCoords: false,
        params: defaultGenParams(),
      },
      assembled: { positive: 'tag a, tag b', negative: '', characters: [] },
      images: [{ index: 0, file: 'x.png', seed: 1, status: 'ok', error: null }],
    }
    new IndexStore(join(saveDir, dateDirName(startedAt))).startRound(round)

    const token = await pairToken()
    const { status, body } = await get('/api/history?days=2', token)
    expect(status).toBe(200)
    const rounds = body as RoundRecord[]
    expect(rounds).toHaveLength(1)
    expect(rounds[0].id).toBe('round-today')
  })

  it('不带 days 时按 config.historyDays 兜底（不是数字也不报错）', async () => {
    const saveDir = join(dir, 'saves')
    // historyDays 默认 30 天，覆盖成 1 天：只有「今天」这一条能进结果
    configStore.write(mergeConfig({ saveDir, historyDays: 1 }))
    const startedAt = new Date()
    const round: RoundRecord = {
      id: 'round-today',
      startedAt: startedAt.toISOString(),
      finishedAt: startedAt.toISOString(),
      status: 'done',
      count: 1,
      snapshot: {
        main: emptyValues(MAIN_FIELDS),
        text: '',
        negative: '',
        characters: [],
        useCoords: false,
        params: defaultGenParams(),
      },
      assembled: { positive: '', negative: '', characters: [] },
      images: [],
    }
    new IndexStore(join(saveDir, dateDirName(startedAt))).startRound(round)

    const token = await pairToken()
    const { status, body } = await get('/api/history?days=abc', token)
    expect(status).toBe(200)
    expect((body as RoundRecord[])).toHaveLength(1)
  })
})

describe('GET /api/usage', () => {
  it('复用额度查询，60 秒内不重复请求', async () => {
    const token = await pairToken()
    const first = await get('/api/usage', token)
    const second = await get('/api/usage', token)
    expect(first.status).toBe(200)
    expect(second.body).toEqual(first.body)
    expect(fetchUsageCalls).toBe(1)
  })

  it('超过 60 秒后重新请求', async () => {
    const token = await pairToken()
    const spy = vi.spyOn(Date, 'now')
    const t0 = Date.now()
    spy.mockReturnValue(t0)
    await get('/api/usage', token)
    spy.mockReturnValue(t0 + 61_000)
    await get('/api/usage', token)
    spy.mockRestore()
    expect(fetchUsageCalls).toBe(2)
  })
})
