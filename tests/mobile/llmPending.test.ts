import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingLlmRequest } from '../../src/shared/consoleRun'
import type { FillResult, LlmRunResult } from '../../src/shared/llm'
import { contentFingerprint } from '../../src/shared/llmProvenance'
import type { StylePreset } from '../../src/shared/styles'
import { emptyWorkspace, type Workspace } from '../../src/shared/workspace'
import {
  applyFilled,
  clearPending,
  decideFinished,
  loadPending,
  MOBILE_PENDING_KEY,
  planRun,
  savePending,
  statusTitle,
} from '../../src/mobile/src/llmPending'

/**
 * 断线补偿那段纯逻辑（计划 Task 14 第 4 条）：手机锁屏、切后台都会把 SSE 断掉，
 * 断线期间跑完的那一轮只能靠 `GET /api/llm/last` 兜回来，所以「要不要应用」必须是
 * 一个能单独测的纯函数——它判错的后果是回填丢掉，或者把电脑那边跑的那一轮写进手机。
 */

let store: Record<string, string>

function fakeLocalStorage(): Storage {
  return {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
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

beforeEach(() => {
  store = {}
  vi.stubGlobal('localStorage', fakeLocalStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const REQUEST: PendingLlmRequest = {
  apiType: 'claude',
  model: '',
  instruction: '海边的少女，夕阳，逆光',
  multiCharacter: 'off',
  editExisting: true,
  transparent: false,
  styleMode: 'preset',
  presetName: '厚涂光影',
  autoGenerate: false,
}

function fill(patch: Partial<FillResult> = {}): FillResult {
  return {
    main: { count: '1girl, solo', artist: 'artist:ciloranko' },
    text: '',
    negative: 'lowres',
    aspectRatio: '2:3',
    width: 832,
    height: 1216,
    transparentBackground: false,
    characters: [],
    useCoords: false,
    ...patch,
  }
}

const FILLED: LlmRunResult = { status: 'filled', fill: fill(), rounds: 3, elapsedMs: 42_000 }

describe('待结算的那一轮', () => {
  it('存下来的能原样读回', () => {
    savePending({ runId: 'run-1', request: REQUEST })
    expect(loadPending()).toEqual({ runId: 'run-1', request: REQUEST })
  })

  it('结算完清掉，之后读回没有待办', () => {
    savePending({ runId: 'run-1', request: REQUEST })
    clearPending()
    expect(loadPending()).toBeNull()
  })

  it('存坏了（不是 JSON、缺 runId、请求形状不对）一律当没有待办', () => {
    store[MOBILE_PENDING_KEY] = '{坏了'
    expect(loadPending()).toBeNull()
    store[MOBILE_PENDING_KEY] = JSON.stringify({ request: REQUEST })
    expect(loadPending()).toBeNull()
    store[MOBILE_PENDING_KEY] = JSON.stringify({ runId: 'run-1', request: { instruction: 1 } })
    expect(loadPending()).toBeNull()
  })
})

describe('decideFinished', () => {
  it('runId 对得上且回填成功：应用，并把这一轮的轮数与用时补进请求记录', () => {
    const d = decideFinished({ runId: 'run-1', request: REQUEST }, { runId: 'run-1', result: FILLED })
    expect(d.kind).toBe('apply')
    if (d.kind !== 'apply') return
    expect(d.fill.width).toBe(832)
    expect(d.request).toEqual({ ...REQUEST, llmRounds: 3, elapsedMs: 42_000 })
  })

  it('已经结算过（待办清掉了）就不再回填一次', () => {
    expect(decideFinished(null, { runId: 'run-1', result: FILLED })).toEqual({ kind: 'ignore' })
  })

  it('runId 对不上的那一轮不动手机的工作区——那是电脑自己发的', () => {
    const d = decideFinished({ runId: 'run-1', request: REQUEST }, { runId: 'run-2', result: FILLED })
    expect(d).toEqual({ kind: 'ignore' })
  })

  it('服务端起来之后还没跑过任何一轮时不结算', () => {
    expect(decideFinished({ runId: 'run-1', request: REQUEST }, null)).toEqual({ kind: 'ignore' })
  })

  it('失败、中止、模型没给参数：只收尾显示原因，没有可回填的内容', () => {
    const cases: LlmRunResult[] = [
      { status: 'failed', rounds: 1, elapsedMs: 900, message: '电脑正在出图' },
      { status: 'aborted', rounds: 2, elapsedMs: 900 },
      { status: 'noParams', rounds: 4, elapsedMs: 900 },
    ]
    for (const result of cases) {
      expect(decideFinished({ runId: 'run-1', request: REQUEST }, { runId: 'run-1', result })).toEqual({
        kind: 'settle',
        result,
      })
    }
  })
})

describe('applyFilled', () => {
  const request = { ...REQUEST, llmRounds: 3, elapsedMs: 42_000 }

  function before(): Workspace {
    const ws = emptyWorkspace()
    ws.main.count = '旧的'
    ws.console.instruction = '海边的少女，夕阳，逆光'
    return ws
  }

  it('回填只改手机这一份，传进来的那份一个字都不动', () => {
    const ws = before()
    const next = applyFilled(ws, fill(), request)
    expect(ws.main.count).toBe('旧的')
    expect(ws.llm).toBeNull()
    expect(next.main.count).toBe('1girl, solo')
    expect(next.params.width).toBe(832)
  })

  it('记下这一轮的 LLM 来源', () => {
    const next = applyFilled(before(), fill(), request)
    expect(next.llm?.request.instruction).toBe('海边的少女，夕阳，逆光')
    expect(next.llm?.request.llmRounds).toBe(3)
    expect(next.llm?.stale).toBe(false)
  })

  it('指纹取的是回填之后的内容，刚回填完不算手改过', () => {
    const next = applyFilled(before(), fill(), request)
    expect(next.llm?.fingerprint).toBe(contentFingerprint(next))
  })

  it('指令区的开关不受回填影响', () => {
    const ws = before()
    ws.console.autoGenerate = true
    expect(applyFilled(ws, fill(), request).console.autoGenerate).toBe(true)
  })
})

describe('planRun', () => {
  const presets: StylePreset[] = [{ id: 'st-1', name: '厚涂光影', tags: 'artist:wlop' }]

  function ws(): Workspace {
    const w = emptyWorkspace()
    w.console = {
      instruction: '海边的少女',
      multiCharacter: 'coords',
      editExisting: true,
      transparent: true,
      styleMode: 'preset',
      presetId: 'st-1',
      autoGenerate: true,
    }
    return w
  }

  // 电脑上的 LLM 类型与模型名，来自 GET /api/meta 的 llm
  const API = { apiType: 'claude' as const, model: 'claude-opus-4-8' }

  it('五个开关一个不少地进了这一轮：四个进入参，回填后自动生成进请求记录', () => {
    const { input, request } = planRun(ws(), presets, API)
    expect(input.instruction).toBe('海边的少女')
    expect(input.multiCharacter).toBe('coords')
    expect(input.editExisting).toBe(true)
    expect(input.transparent).toBe(true)
    expect(input.style).toEqual({ mode: 'preset', tags: 'artist:wlop' })
    expect(request.autoGenerate).toBe(true)
    expect(request.presetName).toBe('厚涂光影')
    // 记进溯源的模型名是电脑那边真实在用的，不是编的
    expect([request.apiType, request.model]).toEqual(['claude', 'claude-opus-4-8'])
  })

  it('发出去的是手机这一份工作区', () => {
    const w = ws()
    w.main.artist = 'artist:ciloranko'
    expect(planRun(w, presets, API).input.workspace.main.artist).toBe('artist:ciloranko')
  })
})

describe('statusTitle', () => {
  it('运行中带上第几轮', () => {
    expect(statusTitle({ kind: 'running', round: 2, maxRounds: 10 })).toBe('运行中 · 第 2 / 10 轮')
  })

  it('还没进第一轮时只写运行中', () => {
    expect(statusTitle({ kind: 'running', round: 0, maxRounds: 0 })).toBe('运行中')
  })

  it('回填成功写轮数与用时', () => {
    expect(statusTitle({ kind: 'done', result: FILLED })).toBe('✓ 已回填 · 3 轮 · 用时 42s')
  })

  it('一轮都没跑就失败的（发送被拒）直接写原因', () => {
    const result: LlmRunResult = { status: 'failed', rounds: 0, elapsedMs: 0, message: '电脑正在出图，等这一轮结束再试' }
    expect(statusTitle({ kind: 'done', result })).toBe('✕ 电脑正在出图，等这一轮结束再试')
  })

  it('中止与没给参数各有各的说法', () => {
    expect(statusTitle({ kind: 'done', result: { status: 'aborted', rounds: 2, elapsedMs: 9 } })).toBe('■ 已中止 · 停在第 2 轮')
    expect(statusTitle({ kind: 'done', result: { status: 'noParams', rounds: 4, elapsedMs: 9 } })).toBe('✕ 模型没有给出参数 · 4 轮')
  })

  it('没发过时没有标题可显示', () => {
    expect(statusTitle({ kind: 'idle' })).toBe('')
  })
})
