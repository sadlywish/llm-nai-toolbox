import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyWorkspace } from '../../src/shared/workspace'

type Mod = typeof import('../../src/renderer/src/state/workspace')

let mod: Mod
let api: {
  loadWorkspace: ReturnType<typeof vi.fn>
  saveWorkspace: ReturnType<typeof vi.fn>
  flushWorkspace: ReturnType<typeof vi.fn>
  onPresetChanged: ReturnType<typeof vi.fn>
}
/** initPresetSync 挂上来的那个回调；测试用它冒充主进程推来的一条 preset-changed */
let pushPreset: (presetId: string) => void
let offPreset: ReturnType<typeof vi.fn>
let win: { api: typeof api; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> }

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  offPreset = vi.fn()
  pushPreset = () => {
    throw new Error('还没调用 initPresetSync')
  }
  api = {
    loadWorkspace: vi.fn().mockResolvedValue(emptyWorkspace()),
    saveWorkspace: vi.fn().mockResolvedValue(undefined),
    flushWorkspace: vi.fn().mockReturnValue(true),
    onPresetChanged: vi.fn(),
  }
  api.onPresetChanged.mockImplementation((cb: unknown) => {
    pushPreset = cb as (presetId: string) => void
    return offPreset
  })
  win = { api, addEventListener: vi.fn(), removeEventListener: vi.fn() }
  ;(globalThis as Record<string, unknown>).window = win
  mod = await import('../../src/renderer/src/state/workspace')
})

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as Record<string, unknown>).window
})

describe('useWorkspace', () => {
  it('load 取回主进程给的工作区', async () => {
    await mod.useWorkspace.getState().load()
    expect(mod.useWorkspace.getState().workspace).toEqual(emptyWorkspace())
  })

  it('load 失败给出说明，而不是永远停在载入中', async () => {
    api.loadWorkspace.mockRejectedValueOnce(new Error('坏了'))
    await mod.useWorkspace.getState().load()
    expect(mod.useWorkspace.getState().loadError).toContain('坏了')
  })

  it('工作区未载入时 update 什么都不做', async () => {
    mod.useWorkspace.getState().update((ws) => {
      ws.text = 'x'
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(mod.useWorkspace.getState().workspace).toBeNull()
    expect(api.saveWorkspace).not.toHaveBeenCalled()
  })

  it('update 深拷贝后再改，旧状态对象不被改动', async () => {
    await mod.useWorkspace.getState().load()
    const before = mod.useWorkspace.getState().workspace!
    mod.useWorkspace.getState().update((ws) => {
      ws.params.steps = 40
    })
    expect(before.params.steps).toBe(28)
    expect(mod.useWorkspace.getState().workspace!.params.steps).toBe(40)
  })

  it('连续修改只在停手 500ms 后落盘一次，存的是最后那份', async () => {
    await mod.useWorkspace.getState().load()
    mod.useWorkspace.getState().update((ws) => {
      ws.text = 'a'
    })
    await vi.advanceTimersByTimeAsync(300)
    mod.useWorkspace.getState().update((ws) => {
      ws.text = 'b'
    })
    await vi.advanceTimersByTimeAsync(mod.SAVE_DEBOUNCE_MS - 1)
    expect(api.saveWorkspace).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(api.saveWorkspace).toHaveBeenCalledTimes(1)
    expect(api.saveWorkspace.mock.calls[0][0].text).toBe('b')
  })

  it('关窗冲刷：把防抖中的那份同步写掉，定时器不再重复写', async () => {
    await mod.useWorkspace.getState().load()
    mod.useWorkspace.getState().update((ws) => {
      ws.text = 'c'
    })
    mod.flushPendingWorkspace()
    expect(api.flushWorkspace).toHaveBeenCalledTimes(1)
    expect(api.flushWorkspace.mock.calls[0][0].text).toBe('c')
    await vi.advanceTimersByTimeAsync(2000)
    expect(api.saveWorkspace).not.toHaveBeenCalled()
  })

  it('没有待写的内容时冲刷什么都不发', () => {
    mod.flushPendingWorkspace()
    expect(api.flushWorkspace).not.toHaveBeenCalled()
  })

  it('落盘失败把原因放进 saveError，下一次成功后清掉', async () => {
    await mod.useWorkspace.getState().load()
    api.saveWorkspace.mockRejectedValueOnce(new Error('磁盘满'))
    mod.useWorkspace.getState().update((ws) => {
      ws.text = 'd'
    })
    await vi.advanceTimersByTimeAsync(mod.SAVE_DEBOUNCE_MS)
    expect(mod.useWorkspace.getState().saveError).toContain('磁盘满')
    mod.useWorkspace.getState().update((ws) => {
      ws.text = 'e'
    })
    await vi.advanceTimersByTimeAsync(mod.SAVE_DEBOUNCE_MS)
    expect(mod.useWorkspace.getState().saveError).toBeNull()
  })

  it('initWorkspacePersistence 挂上 beforeunload，返回的函数摘掉同一个监听', () => {
    const off = mod.initWorkspacePersistence()
    expect(win.addEventListener).toHaveBeenCalledWith('beforeunload', expect.any(Function))
    const handler = win.addEventListener.mock.calls[0][1]
    off()
    expect(win.removeEventListener).toHaveBeenCalledWith('beforeunload', handler)
  })
})

describe('initPresetSync（手机端改了预设画风）', () => {
  it('只改 console.presetId，工作区别的字段原样不动', async () => {
    await mod.useWorkspace.getState().load()
    mod.useWorkspace.getState().update((ws) => {
      ws.main.artist = 'artist:wlop'
      ws.negative = '原有负面词'
      ws.params.steps = 40
      ws.console.instruction = '画个猫'
      ws.console.presetId = 'st-old'
    })
    const before = mod.useWorkspace.getState().workspace!

    mod.initPresetSync()
    pushPreset('st-new')

    const after = mod.useWorkspace.getState().workspace!
    expect(after.console.presetId).toBe('st-new')
    expect(after.main).toEqual(before.main)
    expect(after.negative).toBe(before.negative)
    expect(after.params).toEqual(before.params)
    expect(after.console.instruction).toBe(before.console.instruction)
  })

  it('改动走防抖存盘，磁盘上那份也跟着换成新预设', async () => {
    await mod.useWorkspace.getState().load()
    mod.initPresetSync()
    pushPreset('st-new')
    await vi.advanceTimersByTimeAsync(mod.SAVE_DEBOUNCE_MS)
    expect(api.saveWorkspace).toHaveBeenCalledTimes(1)
    expect(api.saveWorkspace.mock.calls[0][0].console.presetId).toBe('st-new')
  })

  it('返回的函数摘掉订阅', () => {
    const off = mod.initPresetSync()
    expect(api.onPresetChanged).toHaveBeenCalledTimes(1)
    off()
    expect(offPreset).toHaveBeenCalledTimes(1)
  })
})
