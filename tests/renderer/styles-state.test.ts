import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StylePreset } from '../../src/shared/styles'

type Mod = typeof import('../../src/renderer/src/state/styles')

let mod: Mod
let api: {
  loadStyles: ReturnType<typeof vi.fn>
  saveStyles: ReturnType<typeof vi.fn>
  flushStyles: ReturnType<typeof vi.fn>
}
let win: { api: typeof api; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> }
const preset: StylePreset = { id: 'a', name: 'wlop', tags: 'artist:wlop' }

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  api = {
    loadStyles: vi.fn().mockResolvedValue([preset]),
    saveStyles: vi.fn().mockResolvedValue(undefined),
    flushStyles: vi.fn().mockReturnValue(true),
  }
  win = { api, addEventListener: vi.fn(), removeEventListener: vi.fn() }
  ;(globalThis as Record<string, unknown>).window = win
  mod = await import('../../src/renderer/src/state/styles')
})

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as Record<string, unknown>).window
})

describe('useStyles', () => {
  it('load 取回预设；失败时给出说明', async () => {
    await mod.useStyles.getState().load()
    expect(mod.useStyles.getState().presets).toEqual([preset])
    api.loadStyles.mockRejectedValueOnce(new Error('坏了'))
    await mod.useStyles.getState().load()
    expect(mod.useStyles.getState().loadError).toContain('坏了')
  })

  it('没载入时 update 什么都不做', async () => {
    mod.useStyles.getState().update((list) => {
      list.push(preset)
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.saveStyles).not.toHaveBeenCalled()
  })

  it('连续改动防抖后只存最后一份；存完 saving 回到 false', async () => {
    await mod.useStyles.getState().load()
    mod.useStyles.getState().update((list) => {
      list[0].tags = 'x'
    })
    mod.useStyles.getState().update((list) => {
      list[0].tags = 'y'
    })
    expect(mod.useStyles.getState().saving).toBe(true)
    await vi.advanceTimersByTimeAsync(mod.STYLES_SAVE_DEBOUNCE_MS)
    expect(api.saveStyles).toHaveBeenCalledTimes(1)
    expect(api.saveStyles.mock.calls[0][0][0].tags).toBe('y')
    expect(mod.useStyles.getState().saving).toBe(false)
  })

  it('update 深拷贝，旧数组不被改动', async () => {
    await mod.useStyles.getState().load()
    const before = mod.useStyles.getState().presets!
    mod.useStyles.getState().update((list) => {
      list[0].name = 'changed'
    })
    expect(before[0].name).toBe('wlop')
  })

  it('保存失败写明原因', async () => {
    await mod.useStyles.getState().load()
    api.saveStyles.mockRejectedValueOnce(new Error('磁盘满'))
    mod.useStyles.getState().update((list) => {
      list[0].tags = 'z'
    })
    await vi.advanceTimersByTimeAsync(mod.STYLES_SAVE_DEBOUNCE_MS)
    expect(mod.useStyles.getState().saveError).toContain('磁盘满')
  })

  it('关窗前同步冲刷还没写出去的那一份；没有待存内容时不冲刷', async () => {
    await mod.useStyles.getState().load()
    const detach = mod.initStylesPersistence()
    const handler = win.addEventListener.mock.calls[0][1] as () => void
    handler()
    expect(api.flushStyles).not.toHaveBeenCalled()
    mod.useStyles.getState().update((list) => {
      list[0].tags = 'w'
    })
    handler()
    expect(api.flushStyles).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(mod.STYLES_SAVE_DEBOUNCE_MS)
    expect(api.saveStyles).not.toHaveBeenCalled()
    detach()
    expect(win.removeEventListener).toHaveBeenCalled()
  })
})
