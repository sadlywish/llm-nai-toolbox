import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAppConfig } from '../../../src/shared/config'
import type { LlmEvent, LlmRunInput, LlmRunResult } from '../../../src/shared/llm'
import { emptyWorkspace } from '../../../src/shared/workspace'
import type { RunnerDeps } from '../../../src/main/llm/runner'
import { BusyError, LlmSession } from '../../../src/main/llm/session'

// runLlm 自己在 tests/main/llm-runner.test.ts 里测过；这里只关心「同一时刻只跑一轮」这道闸，
// 换成可控的桩才能精确卡在「第一轮还没结束」的那一刻
const { runLlm } = vi.hoisted(() => ({ runLlm: vi.fn<[LlmRunInput, RunnerDeps], Promise<LlmRunResult>>() }))
vi.mock('../../../src/main/llm/runner', () => ({ runLlm }))

const DONE: LlmRunResult = { status: 'noParams', rounds: 1, elapsedMs: 1 }

function input(over: Partial<LlmRunInput> = {}): LlmRunInput {
  return {
    instruction: '画初音未来',
    multiCharacter: 'off',
    editExisting: false,
    transparent: false,
    style: { mode: 'none' },
    workspace: emptyWorkspace(),
    ...over,
  }
}

interface Harness {
  session: LlmSession
  /** 每轮交给 runLlm 的那份依赖，按开跑顺序 */
  made: RunnerDeps[]
}

function harness(): Harness {
  const made: RunnerDeps[] = []
  const session = new LlmSession((_input, signal, emit) => {
    const deps: RunnerDeps = {
      config: defaultAppConfig(),
      apiKey: 'sk-test',
      chat: async () => ({ text: '', pendingCalls: [], stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } }),
      prepareData: async () => {
        throw new Error('这个桩用不到标签数据')
      },
      manuals: new Map(),
      manualToc: '',
      skillCore: '',
      signal,
      emit,
    }
    made.push(deps)
    return deps
  })
  return { session, made }
}

beforeEach(() => {
  runLlm.mockReset()
})

describe('LlmSession', () => {
  it('同一时刻只允许一轮，第二次抛 BusyError', async () => {
    let release!: (r: LlmRunResult) => void
    runLlm.mockImplementation(() => new Promise<LlmRunResult>((r) => (release = r)))
    const { session } = harness()

    const first = session.run(input(), () => {})
    expect(session.busy).toBe(true)
    await expect(session.run(input(), () => {})).rejects.toBeInstanceOf(BusyError)

    release(DONE)
    await expect(first).resolves.toEqual(DONE)
    expect(session.busy).toBe(false)
  })

  it('被拒的那次文案固定，且完全不碰在途的那一轮', async () => {
    let release!: (r: LlmRunResult) => void
    runLlm.mockImplementation(() => new Promise<LlmRunResult>((r) => (release = r)))
    const { session, made } = harness()

    const first = session.run(input(), () => {})
    const events: LlmEvent[] = []
    await expect(session.run(input(), (e) => events.push(e))).rejects.toThrow('上一轮还在运行，先等它结束或中止')
    // 第二次连依赖都不该做出来：做出来就意味着又读了一次配置、又建了一个 AbortController
    expect(made).toHaveLength(1)
    expect(runLlm).toHaveBeenCalledTimes(1)
    expect(events).toEqual([])

    release(DONE)
    await first
  })

  it('跑完（含抛错）都要把 busy 放开', async () => {
    runLlm.mockRejectedValueOnce(new Error('依赖没接上'))
    const { session } = harness()
    const events: LlmEvent[] = []

    await expect(session.run(input(), (e) => events.push(e))).rejects.toThrow('依赖没接上')
    expect(session.busy).toBe(false)
    // 抛错的那一轮不发收尾事件：渲染层是靠 invoke 的 reject 收场的
    expect(events).toEqual([])

    // 放开之后能接着跑下一轮
    runLlm.mockResolvedValueOnce(DONE)
    await expect(session.run(input(), () => {})).resolves.toEqual(DONE)
  })

  it('abort 会 abort 传给 runLlm 的 signal', async () => {
    let release!: (r: LlmRunResult) => void
    runLlm.mockImplementation(() => new Promise<LlmRunResult>((r) => (release = r)))
    const { session, made } = harness()

    const first = session.run(input(), () => {})
    expect(made[0].signal.aborted).toBe(false)
    session.abort()
    expect(made[0].signal.aborted).toBe(true)

    release({ status: 'aborted', rounds: 1, elapsedMs: 1 })
    await first
    // 没有在途的一轮时 abort 是空操作，不该抛
    expect(() => session.abort()).not.toThrow()
  })

  it('收尾的 finished 排在最后一行日志之后，走同一条 emit', async () => {
    runLlm.mockImplementation(async (_i, deps) => {
      deps.emit({ kind: 'log', line: { time: '12:30:09', level: 'I', text: '第一行' } })
      deps.emit({ kind: 'log', line: { time: '12:30:10', level: 'I', text: '第二行' } })
      return DONE
    })
    const { session } = harness()
    const events: LlmEvent[] = []

    await session.run(input(), (e) => events.push(e))
    expect(events.map((e) => e.kind)).toEqual(['log', 'log', 'finished'])
    expect(events[2]).toEqual({ kind: 'finished', result: DONE })
  })

  it('每一轮的依赖都是开跑那一刻现做的，两轮各有各的 signal', async () => {
    runLlm.mockResolvedValue(DONE)
    const { session, made } = harness()

    await session.run(input(), () => {})
    await session.run(input(), () => {})
    expect(made).toHaveLength(2)
    expect(made[0].signal).not.toBe(made[1].signal)
    // 中止第二轮不该波及已经结束的第一轮
    session.abort()
    expect([made[0].signal.aborted, made[1].signal.aborted]).toEqual([false, false])
  })

  it('入参原样交给 runLlm', async () => {
    runLlm.mockResolvedValue(DONE)
    const { session } = harness()
    const i = input({ instruction: '换成侧脸', editExisting: true })

    await session.run(i, () => {})
    expect(runLlm.mock.calls[0][0]).toBe(i)
  })
})
