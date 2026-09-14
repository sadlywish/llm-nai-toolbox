import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fillSummary } from '../../src/shared/applyFill'
import type { FillResult, LlmEvent, LlmRunInput, LlmRunResult } from '../../src/shared/llm'
import { emptyWorkspace } from '../../src/shared/workspace'

type Mod = typeof import('../../src/renderer/src/state/llm')

let mod: Mod
let api: {
  llmRun: ReturnType<typeof vi.fn>
  llmAbort: ReturnType<typeof vi.fn>
  onLlmEvent: ReturnType<typeof vi.fn>
}
let rejectRun: (err: unknown) => void

const input: LlmRunInput = {
  instruction: '海边',
  multiCharacter: 'off',
  editExisting: false,
  transparent: false,
  style: { mode: 'none' },
  workspace: emptyWorkspace(),
}

const fill: FillResult = {
  main: { count: '1girl', style: '', character: '', artist: '', appearance: '', tags: '', environment: 'beach', series: '', nltags: '', quality: '' },
  text: '',
  negative: 'lowres',
  aspectRatio: '2:3',
  width: 832,
  height: 1216,
  transparentBackground: false,
  characters: [],
  useCoords: false,
}

const filled: LlmRunResult = { status: 'filled', fill, rounds: 3, elapsedMs: 31_000 }
const noParams: LlmRunResult = { status: 'noParams', rounds: 2, elapsedMs: 9_000 }

function log(text: string): LlmEvent {
  return { kind: 'log', line: { time: '12:30:01', level: 'I', text } }
}

const state = (): ReturnType<Mod['useLlm']['getState']> => mod.useLlm.getState()

beforeEach(async () => {
  vi.resetModules()
  api = {
    llmRun: vi.fn().mockImplementation(
      () =>
        new Promise<LlmRunResult>((_resolve, reject) => {
          rejectRun = reject
        }),
    ),
    llmAbort: vi.fn().mockResolvedValue(undefined),
    onLlmEvent: vi.fn().mockReturnValue(() => {}),
  }
  ;(globalThis as Record<string, unknown>).window = { api }
  mod = await import('../../src/renderer/src/state/llm')
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
})

describe('状态文字与工具函数', () => {
  it('各阶段的状态文字', () => {
    const done = (result: LlmRunResult): string => mod.statusText({ kind: 'done', result })
    expect(mod.statusText({ kind: 'idle' })).toBe('')
    expect(mod.statusText({ kind: 'running', round: 0, maxRounds: 0 })).toBe('运行中')
    expect(mod.statusText({ kind: 'running', round: 2, maxRounds: 10 })).toBe('运行中 · 第 2 / 10 轮')
    expect(done({ status: 'filled', fill, rounds: 3, elapsedMs: 31_600 })).toBe('✓ 已回填 · 3 轮 · 用时 32s')
    expect(done(noParams)).toBe('✕ 模型没有给出参数 · 2 轮')
    expect(done({ status: 'failed', rounds: 1, elapsedMs: 1, message: '401 authentication_error' })).toBe('✕ 请求失败 · 第 1 轮')
    expect(done({ status: 'failed', rounds: 0, elapsedMs: 1, message: '还没有填写 API Key' })).toBe('✕ 还没有填写 API Key')
    expect(done({ status: 'aborted', rounds: 3, elapsedMs: 1 })).toBe('■ 已中止 · 停在第 3 轮')
    expect(done({ status: 'aborted', rounds: 0, elapsedMs: 1 })).toBe('■ 已中止')
  })

  it('状态色', () => {
    const tone = (result: LlmRunResult): ReturnType<Mod['statusTone']> => mod.statusTone({ kind: 'done', result })
    expect(mod.statusTone({ kind: 'idle' })).toBe(null)
    expect(mod.statusTone({ kind: 'running', round: 1, maxRounds: 10 })).toBe('running')
    expect(tone(filled)).toBe('ok')
    expect(tone(noParams)).toBe('bad')
    expect(tone({ status: 'failed', rounds: 1, elapsedMs: 1, message: 'x' })).toBe('bad')
    expect(tone({ status: 'aborted', rounds: 1, elapsedMs: 1 })).toBe('stop')
  })

  it('clockText 补零', () => {
    expect(mod.clockText(new Date(2026, 8, 13, 9, 5, 7))).toBe('09:05:07')
  })

  it('appendCapped 超出上限丢最早的，不改原数组', () => {
    const lines = [1, 2, 3]
    expect(mod.appendCapped(lines, 4, 3)).toEqual([2, 3, 4])
    expect(mod.appendCapped([1], 2, 3)).toEqual([1, 2])
    expect(lines).toEqual([1, 2, 3])
  })
})

describe('useLlm', () => {
  it('run 进入运行中；日志逐行追加、带递增序号；round 更新轮次', () => {
    void state().run(input, vi.fn())
    expect(api.llmRun).toHaveBeenCalledWith(input)
    expect(state().phase).toEqual({ kind: 'running', round: 0, maxRounds: 0 })
    state().handleEvent(log('本轮工具集: generate_image'))
    state().handleEvent({ kind: 'round', round: 1, maxRounds: 10 })
    state().handleEvent(log('Token 累计: 第1轮 10in/2out'))
    expect(state().phase).toEqual({ kind: 'running', round: 1, maxRounds: 10 })
    expect(state().lines.map((l) => l.text)).toEqual(['本轮工具集: generate_image', 'Token 累计: 第1轮 10in/2out'])
    expect(state().lines[1].seq).toBeGreaterThan(state().lines[0].seq)
  })

  it('finished(filled)：先回填，再追加绿色的「已回填」行', () => {
    const onFilled = vi.fn(() => {
      // 回填发生时「已回填」行还没追加
      expect(state().lines.some((l) => l.ok === true)).toBe(false)
    })
    void state().run(input, onFilled)
    state().handleEvent(log('LLM 全部轮次完成'))
    state().handleEvent({ kind: 'finished', result: filled })
    expect(onFilled).toHaveBeenCalledWith(fill)
    expect(state().phase).toEqual({ kind: 'done', result: filled })
    const last = state().lines[state().lines.length - 1]
    expect(last).toMatchObject({ level: 'I', ok: true, text: fillSummary(fill) })
  })

  it('没有回填的结束不调回填，也不追加「已回填」行', () => {
    const onFilled = vi.fn()
    void state().run(input, onFilled)
    state().handleEvent(log('模型没有给出参数，编辑器内容未改动'))
    state().handleEvent({ kind: 'finished', result: noParams })
    expect(onFilled).not.toHaveBeenCalled()
    expect(state().phase).toEqual({ kind: 'done', result: noParams })
    expect(state().lines).toHaveLength(1)
  })

  it('invoke 被拒：转为失败，补一行原因并去掉 Electron 的包装前缀', async () => {
    const running = state().run(input, vi.fn())
    rejectRun(new Error("Error invoking remote method 'llm:run': Error: 上一轮还在运行，先等它结束或中止"))
    await running
    const message = '上一轮还在运行，先等它结束或中止'
    expect(state().phase).toEqual({ kind: 'done', result: { status: 'failed', rounds: 0, elapsedMs: 0, message } })
    expect(state().lines[state().lines.length - 1]).toMatchObject({ level: 'E', text: `发送失败：${message}` })
  })

  it('运行中再 run 被忽略', () => {
    void state().run(input, vi.fn())
    void state().run(input, vi.fn())
    expect(api.llmRun).toHaveBeenCalledTimes(1)
  })

  it('不是本窗口发起的那一轮：round 与 finished 不认，日志照样追加', () => {
    state().handleEvent({ kind: 'round', round: 2, maxRounds: 10 })
    state().handleEvent({ kind: 'finished', result: filled })
    state().handleEvent(log('迟到的一行'))
    expect(state().phase).toEqual({ kind: 'idle' })
    expect(state().lines.map((l) => l.text)).toEqual(['迟到的一行'])
  })

  it('再发一轮不清掉上一轮的日志', () => {
    void state().run(input, vi.fn())
    state().handleEvent(log('第一轮'))
    state().handleEvent({ kind: 'finished', result: noParams })
    void state().run(input, vi.fn())
    expect(state().lines.map((l) => l.text)).toEqual(['第一轮'])
    expect(state().phase.kind).toBe('running')
  })

  it('abort 只在运行中通知主进程', () => {
    state().abort()
    expect(api.llmAbort).not.toHaveBeenCalled()
    void state().run(input, vi.fn())
    state().abort()
    expect(api.llmAbort).toHaveBeenCalledTimes(1)
  })

  it('清空：运行中无效；结束后清掉日志并回到空闲', () => {
    void state().run(input, vi.fn())
    state().handleEvent(log('a'))
    state().clear()
    expect(state().lines).toHaveLength(1)
    state().handleEvent({ kind: 'finished', result: noParams })
    state().clear()
    expect(state().lines).toEqual([])
    expect(state().phase).toEqual({ kind: 'idle' })
  })

  it('日志抽屉：发送时自动打开；可手动收起、再打开', () => {
    expect(state().logOpen).toBe(false)
    void state().run(input, vi.fn())
    expect(state().logOpen).toBe(true)
    state().closeLog()
    expect(state().logOpen).toBe(false)
    state().openLog()
    expect(state().logOpen).toBe(true)
  })

  it('日志抽屉：运行中再 run 被忽略时不改抽屉', () => {
    void state().run(input, vi.fn())
    state().closeLog()
    void state().run(input, vi.fn())
    expect(state().logOpen).toBe(false)
  })

  it('日志抽屉：回填成功后自动收起——接下来要去操作参数区', () => {
    void state().run(input, vi.fn())
    state().handleEvent({ kind: 'finished', result: filled })
    expect(state().logOpen).toBe(false)
  })

  it('日志抽屉：没有回填的结束保持原样——原因在日志里', () => {
    for (const result of [noParams, { status: 'failed', rounds: 1, elapsedMs: 1, message: 'x' }, { status: 'aborted', rounds: 1, elapsedMs: 1 }] as LlmRunResult[]) {
      void state().run(input, vi.fn())
      state().handleEvent({ kind: 'finished', result })
      expect(state().logOpen).toBe(true)
    }
  })

  it('日志抽屉：清空后收起；运行中清空无效时也不收起', () => {
    void state().run(input, vi.fn())
    state().clear()
    expect(state().logOpen).toBe(true)
    state().handleEvent({ kind: 'finished', result: noParams })
    state().clear()
    expect(state().logOpen).toBe(false)
  })

  it('initLlmEvents 订阅事件交给 handleEvent，返回退订函数', () => {
    const off = vi.fn()
    api.onLlmEvent.mockReturnValue(off)
    const detach = mod.initLlmEvents()
    const cb = api.onLlmEvent.mock.calls[0][0] as (e: LlmEvent) => void
    cb(log('x'))
    expect(state().lines.map((l) => l.text)).toEqual(['x'])
    detach()
    expect(off).toHaveBeenCalled()
  })
})
