import { create } from 'zustand'
import { fillSummary } from '@shared/applyFill'
import type { FillResult, LlmEvent, LlmLogLine, LlmRunInput, LlmRunResult } from '@shared/llm'

/** 日志区最多留这么多行，更早的丢掉。一轮通常几十到两三百行 */
export const MAX_LOG_LINES = 2000

export type ConsolePhase =
  | { kind: 'idle' }
  /** round 为 0：还没进入第一轮（在备齐标签数据） */
  | { kind: 'running'; round: number; maxRounds: number }
  | { kind: 'done'; result: LlmRunResult }

export interface ConsoleLine extends LlmLogLine {
  /** 递增序号，给 React 当 key——行数封顶后下标会整体移位 */
  seq: number
  /** 「已回填: …」那行，绿色 */
  ok?: boolean
}

export type StatusTone = 'running' | 'ok' | 'bad' | 'stop'

export function clockText(d: Date): string {
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
}

export function appendCapped<T>(lines: readonly T[], line: T, cap: number = MAX_LOG_LINES): T[] {
  const next = lines.length >= cap ? lines.slice(lines.length - cap + 1) : lines.slice()
  next.push(line)
  return next
}

/** 日志区顶部那条状态（界面稿第 3 版状态 1–3） */
export function statusText(phase: ConsolePhase): string {
  if (phase.kind === 'idle') return ''
  if (phase.kind === 'running') {
    return phase.round > 0 ? `运行中 · 第 ${phase.round} / ${phase.maxRounds} 轮` : '运行中'
  }
  const r = phase.result
  if (r.status === 'filled') return `✓ 已回填 · ${r.rounds} 轮 · 用时 ${Math.round(r.elapsedMs / 1000)}s`
  if (r.status === 'noParams') return `✕ 模型没有给出参数 · ${r.rounds} 轮`
  // 0 轮就失败的（没填 Key、指令为空、发送被拒）没有「第几轮」可说，直接写原因
  if (r.status === 'failed') return r.rounds > 0 ? `✕ 请求失败 · 第 ${r.rounds} 轮` : `✕ ${r.message}`
  return r.rounds > 0 ? `■ 已中止 · 停在第 ${r.rounds} 轮` : '■ 已中止'
}

export function statusTone(phase: ConsolePhase): StatusTone | null {
  if (phase.kind === 'idle') return null
  if (phase.kind === 'running') return 'running'
  if (phase.result.status === 'filled') return 'ok'
  if (phase.result.status === 'aborted') return 'stop'
  return 'bad'
}

let seq = 0
/** 本窗口发起、还没结束的那一轮的回填回调 */
let pendingFill: ((fill: FillResult) => void) | null = null

function makeLine(line: LlmLogLine, ok = false): ConsoleLine {
  seq += 1
  return ok ? { ...line, seq, ok } : { ...line, seq }
}

/** invoke 被拒时 Electron 会包一层 "Error invoking remote method 'llm:run': Error: …"，只留原因 */
function ipcErrorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')
}

interface LlmState {
  phase: ConsolePhase
  lines: ConsoleLine[]
  /** 日志抽屉（从指令区顶边向上展开）是否打开。界面稿第 4 版 */
  logOpen: boolean
  run: (input: LlmRunInput, onFilled: (fill: FillResult) => void) => Promise<void>
  handleEvent: (e: LlmEvent) => void
  abort: () => void
  clear: () => void
  openLog: () => void
  closeLog: () => void
}

export const useLlm = create<LlmState>((set, get) => ({
  phase: { kind: 'idle' },
  lines: [],
  logOpen: false,

  run: async (input, onFilled) => {
    if (get().phase.kind === 'running') return
    pendingFill = onFilled
    // 发送即打开日志抽屉
    set({ phase: { kind: 'running', round: 0, maxRounds: 0 }, logOpen: true })
    try {
      // 结果不从返回值取：结束经 finished 事件送达，和日志同一条通道，先后有保证
      await window.api.llmRun(input)
    } catch (err) {
      // 被拒时主进程不会发 finished，这里自己收尾
      if (get().phase.kind !== 'running') return
      pendingFill = null
      const message = ipcErrorMessage(err)
      const line = makeLine({ time: clockText(new Date()), level: 'E', text: `发送失败：${message}` })
      set((s) => ({
        phase: { kind: 'done', result: { status: 'failed', rounds: 0, elapsedMs: 0, message } },
        lines: appendCapped(s.lines, line),
      }))
    }
  },

  handleEvent: (e) => {
    if (e.kind === 'log') {
      const line = makeLine(e.line)
      set((s) => ({ lines: appendCapped(s.lines, line) }))
      return
    }
    // 轮次与结束只认本窗口发起、还在跑的那一轮（例如窗口重载前发出的那一轮就不认）
    if (get().phase.kind !== 'running') return
    if (e.kind === 'round') {
      set({ phase: { kind: 'running', round: e.round, maxRounds: e.maxRounds } })
      return
    }
    const onFilled = pendingFill
    pendingFill = null
    set({ phase: { kind: 'done', result: e.result } })
    if (e.result.status === 'filled' && onFilled !== null) {
      onFilled(e.result.fill)
      const line = makeLine({ time: clockText(new Date()), level: 'I', text: fillSummary(e.result.fill) }, true)
      // 回填成功就收起抽屉：接下来要去操作参数区。没有回填的结束不动抽屉——原因在日志里
      set((s) => ({ lines: appendCapped(s.lines, line), logOpen: false }))
    }
  },

  abort: () => {
    if (get().phase.kind === 'running') void window.api.llmAbort()
  },

  clear: () => {
    if (get().phase.kind === 'running') return
    set({ phase: { kind: 'idle' }, lines: [], logOpen: false })
  },

  openLog: () => set({ logOpen: true }),

  closeLog: () => set({ logOpen: false }),
}))

/** 订阅主进程推来的 llm:event，返回退订函数。由 App 挂载时调用 */
export function initLlmEvents(): () => void {
  return window.api.onLlmEvent((e) => useLlm.getState().handleEvent(e))
}
