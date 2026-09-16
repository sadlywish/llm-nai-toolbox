import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppEvents } from '../../../src/main/appEvents'
import { ConfigStore } from '../../../src/main/config-store'
import type { GenRunner } from '../../../src/main/gen/runner'
import type { MainServices } from '../../../src/main/ipc'
import { LlmSession } from '../../../src/main/llm/session'
import { dateDirName } from '../../../src/main/nai/save'
import type { SecretStore } from '../../../src/main/secret-store'
import { createDeviceStore, type DeviceStore } from '../../../src/main/server/devices'
import { createMobileServer, type MobileServer, type ServerDeps } from '../../../src/main/server/http'
import { JsonStore } from '../../../src/main/store'
import { mergeConfig } from '../../../src/shared/config'

/**
 * Task 6 图片与缩略图接口的测试：同 routes-read.test.ts，起真实服务用 fetch 打自己。
 *
 * makeThumbnail 是唯一一处需要 electron 的实现，这里造一个假的记录入参——
 * 真实实现（nativeImage）留给 index.ts 注入，服务层测试不该拖 electron 进来。
 */

let dir: string
let saveDir: string
let devices: DeviceStore
let configStore: ConfigStore
let thumbnailCalls: { maxEdge: number }[]
let server: MobileServer
let base: string

const startedAt = '2026-09-09T04:00:00.000Z' // 本地时间 2026-09-09（UTC+8 不跨零点），同 image-read.test.ts

function makeDeps(): ServerDeps {
  const services: MainServices = {
    configStore,
    secrets: {} as unknown as SecretStore,
    stylesStore: new JsonStore<unknown>(join(dir, 'styles.json'), () => []),
    workspaceStore: new JsonStore<unknown>(join(dir, 'workspace.json'), () => null),
    genRunner: { get busy() { return false } } as unknown as GenRunner,
    llmSession: new LlmSession(() => {
      throw new Error('image 测试不会真的跑一轮 LLM')
    }),
    events: new AppEvents(),
  }
  return {
    services,
    devices,
    staticDir: dir,
    makeThumbnail: (png, maxEdge) => {
      thumbnailCalls.push({ maxEdge })
      // 返回一个跟原图明显不同、但能认出「是缩图函数处理过」的字节串
      return Buffer.concat([Buffer.from('THUMB:'), png])
    },
    fetchUsage: () => Promise.reject(new Error('image 测试不会用到额度查询')),
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mobile-image-'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html>')
  saveDir = join(dir, 'saves')
  devices = createDeviceStore(join(dir, 'devices.json'))
  configStore = new ConfigStore(dir)
  configStore.write(mergeConfig({ saveDir }))
  thumbnailCalls = []

  mkdirSync(join(saveDir, dateDirName(new Date(startedAt))), { recursive: true })

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

async function raw(path: string, token: string): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } })
}

function imageUrl(file: string, size?: string): string {
  const q = new URLSearchParams({ round: startedAt, file })
  if (size !== undefined) q.set('size', size)
  return `/api/image?${q.toString()}`
}

describe('GET /api/image', () => {
  it('size=full 原样返回图片字节，Content-Type 按扩展名给', async () => {
    writeFileSync(join(saveDir, dateDirName(new Date(startedAt)), '00001-42.png'), Buffer.from('PNGBYTES'))
    writeFileSync(join(saveDir, dateDirName(new Date(startedAt)), '00002-43.webp'), Buffer.from('WEBPBYTES'))
    const token = await pairToken()

    const png = await raw(imageUrl('00001-42.png', 'full'), token)
    expect(png.status).toBe(200)
    expect(png.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await png.arrayBuffer()).toString()).toBe('PNGBYTES')
    expect(thumbnailCalls).toHaveLength(0)

    const webp = await raw(imageUrl('00002-43.webp', 'full'), token)
    expect(webp.status).toBe(200)
    expect(webp.headers.get('content-type')).toBe('image/webp')
  })

  it('size 缺省当 full', async () => {
    writeFileSync(join(saveDir, dateDirName(new Date(startedAt)), '00001-42.png'), Buffer.from('PNGBYTES'))
    const token = await pairToken()
    const r = await raw(imageUrl('00001-42.png'), token)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await r.arrayBuffer()).toString()).toBe('PNGBYTES')
  })

  it('图片内容不变，给 24 小时私有缓存', async () => {
    writeFileSync(join(saveDir, dateDirName(new Date(startedAt)), '00001-42.png'), Buffer.from('PNGBYTES'))
    const token = await pairToken()
    const r = await raw(imageUrl('00001-42.png', 'full'), token)
    expect(r.headers.get('cache-control')).toBe('private, max-age=86400')
  })

  it('size=thumb 调缩图函数，长边 512，返回 image/jpeg', async () => {
    writeFileSync(join(saveDir, dateDirName(new Date(startedAt)), '00001-42.png'), Buffer.from('PNGBYTES'))
    const token = await pairToken()
    const r = await raw(imageUrl('00001-42.png', 'thumb'), token)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/jpeg')
    expect(thumbnailCalls).toEqual([{ maxEdge: 512 }])
    expect(Buffer.from(await r.arrayBuffer()).toString()).toBe('THUMB:PNGBYTES')
  })

  it('size 给了 thumb/full 之外的值 → 400 bad-request', async () => {
    const token = await pairToken()
    const r = await raw(imageUrl('00001-42.png', 'large'), token)
    expect(r.status).toBe(400)
    expect((await r.json()) as { error: { kind: string } }).toEqual({
      error: { kind: 'bad-request', message: expect.any(String) },
    })
    expect(thumbnailCalls).toHaveLength(0)
  })

  it.each([
    ['等于 ..', '..'],
    ['等于 .', '.'],
    ['含 .. 路径段', '../devices.json'],
    ['含正斜杠', 'sub/evil.png'],
    ['含反斜杠', 'sub\\evil.png'],
    ['是绝对路径（POSIX）', '/etc/evil.png'],
    ['是绝对路径（Windows 盘符）', 'C:\\evil.png'],
  ])('文件名 %s 时一律 404（复用 readRoundImage 的路径防护）', async (_label, file) => {
    const token = await pairToken()
    const r = await raw(imageUrl(file, 'full'), token)
    expect(r.status).toBe(404)
    expect(((await r.json()) as { error: { kind: string } }).error.kind).toBe('not-found')
    expect(thumbnailCalls).toHaveLength(0)
  })

  it('不存在的图 404，不抛错，响应体是统一错误形状', async () => {
    const token = await pairToken()
    const r = await raw(imageUrl('nope.png', 'full'), token)
    expect(r.status).toBe(404)
    expect(await r.json()).toEqual({ error: { kind: 'not-found', message: expect.any(String) } })
  })

  it('缺 round 或 file 参数 → 400', async () => {
    const token = await pairToken()
    const noRound = await raw(`/api/image?file=00001-42.png`, token)
    expect(noRound.status).toBe(400)
    const noFile = await raw(`/api/image?round=${encodeURIComponent(startedAt)}`, token)
    expect(noFile.status).toBe(400)
  })

  it('没带令牌访问 → 401，同其余接口', async () => {
    const r = await fetch(`${base}${imageUrl('00001-42.png', 'full')}`)
    expect(r.status).toBe(401)
  })
})
