import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NaiSubscription } from '../../src/shared/naiUser'

type Mod = typeof import('../../src/renderer/src/state/naiUsage')

let mod: Mod
let api: { naiSubscription: ReturnType<typeof vi.fn> }

const subscription: NaiSubscription = {
  anlas: { fixed: 8000, purchased: 4345, total: 12345 },
  tier: 3,
  active: true,
  expiresAt: null,
  usage: { percent: 87, timeUntilNextPercent: 312, isNegative: false },
}

beforeEach(async () => {
  vi.resetModules()
  api = { naiSubscription: vi.fn().mockResolvedValue({ ok: true, subscription }) }
  ;(globalThis as Record<string, unknown>).window = { api }
  mod = await import('../../src/renderer/src/state/naiUsage')
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
})

const state = () => mod.useNaiUsage.getState()

describe('useNaiUsage', () => {
  it('初始是 idle；查成功后是 ready', async () => {
    expect(state().state.kind).toBe('idle')
    await state().refresh()
    expect(state().state).toMatchObject({ kind: 'ready', subscription })
  })

  it('查询中先切 loading', async () => {
    let release: (v: unknown) => void = () => {}
    api.naiSubscription.mockReturnValue(new Promise((r) => (release = r)))
    const p = state().refresh()
    expect(state().state.kind).toBe('loading')
    release({ ok: true, subscription })
    await p
    expect(state().state.kind).toBe('ready')
  })

  it('查询中再点不叠第二次请求', async () => {
    let release: (v: unknown) => void = () => {}
    api.naiSubscription.mockReturnValue(new Promise((r) => (release = r)))
    const p = state().refresh()
    await state().refresh()
    expect(api.naiSubscription).toHaveBeenCalledTimes(1)
    release({ ok: true, subscription })
    await p
  })

  it('失败原样落到界面状态', async () => {
    api.naiSubscription.mockResolvedValue({ ok: false, error: { kind: 'unauthorized', message: 'Token 无效' } })
    await state().refresh()
    expect(state().state).toEqual({ kind: 'error', error: { kind: 'unauthorized', message: 'Token 无效' } })
  })

  it('通道本身抛错也落成 error，不会卡在 loading', async () => {
    api.naiSubscription.mockRejectedValue(new Error('Error invoking remote method: 主进程炸了'))
    await state().refresh()
    expect(state().state.kind).toBe('error')
    expect(state().state.kind === 'error' && state().state).toMatchObject({ error: { kind: 'network' } })
  })
})
