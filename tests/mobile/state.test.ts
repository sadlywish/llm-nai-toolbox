import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyWorkspace, normalizeWorkspace } from '../../src/shared/workspace'

/**
 * 手机自己那份状态的测试：假 localStorage。
 * 模块里有防抖计时器与「上一次写了什么」这类模块级状态，所以每条用例都 resetModules 重新 import
 * （写法同 tests/renderer/styles-state.test.ts）。
 */

type Mod = typeof import('../../src/mobile/src/state')

let mod: Mod
let store: Record<string, string>
/** 下一次 setItem 抛错（隐私模式、存储被禁用） */
let failWrite: boolean

function fakeLocalStorage(): Storage {
  return {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      if (failWrite) throw new Error('存储被禁用')
      store[k] = v
    },
    removeItem: (k: string) => {
      delete store[k]
    },
    clear: () => {
      store = {}
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() {
      return Object.keys(store).length
    },
  } as Storage
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  store = {}
  failWrite = false
  vi.stubGlobal('localStorage', fakeLocalStorage())
  mod = await import('../../src/mobile/src/state')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('loadState', () => {
  it('没存过时给一份空工作区，连接信息为 null', () => {
    expect(mod.loadState()).toEqual({ workspace: emptyWorkspace(), connection: null })
  })

  it('存过的原样读回', () => {
    const ws = emptyWorkspace()
    ws.main.artist = 'artist:wlop'
    ws.runCount = 4
    store[mod.MOBILE_STATE_KEY] = JSON.stringify(ws)
    store[mod.MOBILE_CONN_KEY] = JSON.stringify({ baseUrl: 'http://pc:7321', token: 'tok' })
    expect(mod.loadState()).toEqual({ workspace: ws, connection: { baseUrl: 'http://pc:7321', token: 'tok' } })
  })

  it('存进去的形状不对时过 normalizeWorkspace 收拾干净，而不是把坏值带进界面', () => {
    store[mod.MOBILE_STATE_KEY] = JSON.stringify({ params: { width: '宽' }, characters: '不是数组', runCount: 7 })
    const ws = mod.loadState().workspace
    expect(ws.params.width).toBe(emptyWorkspace().params.width)
    expect(ws.characters).toEqual([])
    expect(ws.runCount).toBe(7)
  })

  it('存的根本不是 JSON 时当没存过', () => {
    store[mod.MOBILE_STATE_KEY] = '{坏了'
    store[mod.MOBILE_CONN_KEY] = '{也坏了'
    expect(mod.loadState()).toEqual({ workspace: emptyWorkspace(), connection: null })
  })

  it('连接信息缺地址或缺令牌一律当没连过', () => {
    store[mod.MOBILE_CONN_KEY] = JSON.stringify({ baseUrl: 'http://pc:7321' })
    expect(mod.loadState().connection).toBeNull()
    store[mod.MOBILE_CONN_KEY] = JSON.stringify({ baseUrl: '', token: 'tok' })
    expect(mod.loadState().connection).toBeNull()
  })
})

describe('saveState', () => {
  it('写进去的内容能被 normalizeWorkspace 原样接受', () => {
    const ws = emptyWorkspace()
    ws.main.artist = 'artist:wlop'
    mod.saveState({ workspace: ws, connection: null })
    vi.advanceTimersByTime(mod.SAVE_DEBOUNCE_MS)
    expect(normalizeWorkspace(JSON.parse(store[mod.MOBILE_STATE_KEY]))).toEqual(ws)
  })

  it('防抖 300 毫秒，连着改只落最后一份', () => {
    const ws = emptyWorkspace()
    mod.saveState({ workspace: { ...ws, runCount: 2 }, connection: null })
    mod.saveState({ workspace: { ...ws, runCount: 3 }, connection: null })
    vi.advanceTimersByTime(mod.SAVE_DEBOUNCE_MS - 1)
    expect(store[mod.MOBILE_STATE_KEY]).toBeUndefined()
    vi.advanceTimersByTime(1)
    expect(JSON.parse(store[mod.MOBILE_STATE_KEY]).runCount).toBe(3)
  })

  it('连接信息单独一个键，且立刻落盘不等防抖——配对完页面随时可能被刷掉', () => {
    mod.saveState({ workspace: emptyWorkspace(), connection: { baseUrl: 'http://pc:7321', token: 'tok' } })
    expect(JSON.parse(store[mod.MOBILE_CONN_KEY])).toEqual({ baseUrl: 'http://pc:7321', token: 'tok' })
    expect(store[mod.MOBILE_STATE_KEY]).toBeUndefined()
  })

  it('连接信息给 null 就把那个键清掉（令牌失效、手动断开）', () => {
    store[mod.MOBILE_CONN_KEY] = JSON.stringify({ baseUrl: 'http://pc:7321', token: 'tok' })
    mod.saveState({ workspace: emptyWorkspace(), connection: null })
    expect(mod.MOBILE_CONN_KEY in store).toBe(false)
  })

  it('flushState 把还没到点的那一份立刻落下去（页面切后台时用）', () => {
    mod.saveState({ workspace: { ...emptyWorkspace(), runCount: 5 }, connection: null })
    mod.flushState()
    expect(JSON.parse(store[mod.MOBILE_STATE_KEY]).runCount).toBe(5)
    // 落过之后计时器不该再写一遍
    store[mod.MOBILE_STATE_KEY] = '占位'
    vi.advanceTimersByTime(mod.SAVE_DEBOUNCE_MS)
    expect(store[mod.MOBILE_STATE_KEY]).toBe('占位')
  })

  it('存储写不进去时不抛错：隐私模式下整个界面不能因此白屏', () => {
    failWrite = true
    expect(() => {
      mod.saveState({ workspace: emptyWorkspace(), connection: { baseUrl: 'http://pc:7321', token: 'tok' } })
      vi.advanceTimersByTime(mod.SAVE_DEBOUNCE_MS)
    }).not.toThrow()
  })
})
