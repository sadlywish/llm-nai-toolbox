import { create } from 'zustand'
import type { FieldSpec } from '@shared/fields'
import type { GenImageEvent, GenStartInput, RoundRecord, RunProgress } from '@shared/gen'
import { snapshotLlmOf } from '@shared/llmProvenance'
import { emptyWorkspace, type Workspace } from '@shared/workspace'
import { ipcErrorMessage } from '../ipcError'
import { tokenBudget } from '../prompt/tokenBudget'
import { useWorkspace } from './workspace'

interface GenState {
  progress: RunProgress | null
  /** 当前活跃轮次已出的图（成功与失败），按 index */
  images: Record<number, GenImageEvent>
  history: RoundRecord[]
  /** 最近一次开跑失败的说明（预检、token 超限）；null 表示没问题 */
  runError: string | null
  /**
   * 出图弹窗的显示开关，纯界面状态。关闭只改这个字段，绝不碰队列——
   * 任务是否在跑由 progress 决定，两者故意分开，才能满足「关闭弹窗不中断任务」。
   */
  dialogOpen: boolean
  /**
   * 弹窗展示哪一轮。null 表示「当前活跃的那一轮」（刚点「生成」）；历史竖栏点条目时写成
   * 具体 id：与 progress.roundId 相同代表点的正是正在跑/刚跑完的那一轮，仍走实时数据；不同则按磁盘快照只读展示。
   */
  viewingRoundId: string | null
  /**
   * 开跑时的入参与时刻。磁盘历史要等一次往返才会出现这一轮，这段空档用它在历史竖栏顶部合成
   * 一条占位记录，而不是显示一堆 0；磁盘历史追上后清空。at 让占位记录的 startedAt 稳定不变。
   */
  starting: { input: GenStartInput; at: string } | null
  /** 工具栏「生成」与「回填后自动生成」共用：超出 token 上限就不发请求（规格 §15） */
  generate: (ws: Workspace, mainSpecs: readonly FieldSpec[], charSpecs: readonly FieldSpec[]) => Promise<void>
  start: (input: GenStartInput) => Promise<void>
  resume: () => Promise<void>
  cancel: () => Promise<void>
  loadHistory: () => Promise<void>
  dismissRunError: () => void
  /** 历史竖栏点击某一条：打开出图弹窗并指定展示那一轮 */
  openRound: (roundId: string) => void
  closeDialog: () => void
}

export const useGen = create<GenState>((set, get) => ({
  progress: null,
  images: {},
  history: [],
  runError: null,
  dialogOpen: false,
  viewingRoundId: null,
  starting: null,

  generate: async (ws, mainSpecs, charSpecs) => {
    const budget = tokenBudget(ws, mainSpecs, charSpecs)
    if (budget.over) {
      set({ runError: `提示词超出 token 上限（${budget.total} / ${budget.limit}），先删减再生成。` })
      return
    }
    await get().start({ workspace: ws, count: ws.runCount })
  },

  start: async (input) => {
    // 立刻弹出图弹窗：genStart 要整轮跑完才 resolve，等它再弹就看不到图一张张出来。
    // progress 也要清掉，否则收到第一个 gen:progress 之前弹窗会闪一下上一轮
    set({
      images: {},
      runError: null,
      dialogOpen: true,
      viewingRoundId: null,
      starting: { input, at: new Date().toISOString() },
      progress: null,
    })
    // 生成按钮的 disabled 只是体验层面的闸，主进程的在途保护才是安全闸——必须接住它的 reject
    try {
      await window.api.genStart(input)
      set({ history: await window.api.loadHistory(), starting: null })
    } catch (err) {
      // 预检类失败（在途、没设目录、没填 Token）没有轮次可看，把刚弹出的弹窗收回去；
      // 中止（fatal）走的是 resolve 不是 reject，弹窗保留，继续显示已出的图与失败格
      set({ runError: ipcErrorMessage(err), dialogOpen: false, starting: null })
    }
  },

  resume: async () => {
    await window.api.genResume()
  },

  cancel: async () => {
    await window.api.genCancel()
  },

  loadHistory: async () => {
    set({ history: await window.api.loadHistory() })
  },

  dismissRunError: () => set({ runError: null }),

  openRound: (roundId) => set({ dialogOpen: true, viewingRoundId: roundId }),

  closeDialog: () => set({ dialogOpen: false }),
}))

/**
 * 订阅主进程推送的进度、单张结果与 seed 回填。由 App 挂载时调用一次，返回值即 cleanup。
 * 不放在模块求值期：vitest 的 node 环境一 import 就会撞 window is not defined。
 */
export function initGenSubscriptions(): () => void {
  // 去重：同一个 roundId 只在磁盘历史还没包含它时补一次 loadHistory，不是每张图都打一次 IPC
  let historyRequestedFor: string | null = null

  const offProgress = window.api.onGenProgress((progress) => {
    useGen.setState({ progress })
    if (progress.roundId !== historyRequestedFor) {
      const known = useGen.getState().history.some((r) => r.id === progress.roundId)
      if (!known) {
        historyRequestedFor = progress.roundId
        void window.api.loadHistory().then((history) => useGen.setState({ history }))
      }
    }
  })
  const offImage = window.api.onGenImage((e) => useGen.setState((s) => ({ images: { ...s.images, [e.index]: e } })))
  // 要写回参数区的 seed：固定模式 -1 开跑时解析出的值、每张随机跑完后最后一张的
  const offSeed = window.api.onGenSeed((seed) =>
    useWorkspace.getState().update((ws) => {
      ws.params.seed = seed
    }),
  )
  return () => {
    offProgress()
    offImage()
    offSeed()
  }
}

/** 历史竖栏的一条：一轮记录，配上（如果它就是当前活跃的那一轮）实时进度 */
export interface HistoryDisplayEntry {
  round: RoundRecord
  live: RunProgress | null
}

/**
 * 合并磁盘历史与当前活跃进度。命中同一个 roundId 时用 progress 覆盖显示（计数实时走）；
 * progress 的轮次还没出现在历史里时，用 starting 现凑一条占位记录钉在最前面——
 * 否则点「生成」后的头几百毫秒历史列里完全没有这一轮，像是点了没反应。
 */
export function mergeHistoryWithProgress(
  history: RoundRecord[],
  progress: RunProgress | null,
  starting: { input: GenStartInput; at: string } | null,
): HistoryDisplayEntry[] {
  if (!progress) return history.map((round) => ({ round, live: null }))

  const idx = history.findIndex((r) => r.id === progress.roundId)
  if (idx >= 0) return history.map((round, i) => ({ round, live: i === idx ? progress : null }))

  const ws = starting?.input.workspace ?? emptyWorkspace()
  const placeholder: RoundRecord = {
    id: progress.roundId,
    startedAt: starting?.at ?? new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    count: starting?.input.count ?? 0,
    // 只取参与本轮的角色，与主进程落盘的快照口径一致
    snapshot: {
      main: ws.main,
      text: ws.text,
      negative: ws.negative,
      characters: ws.characters.filter((c) => c.enabled).map((c) => ({ fields: c.fields, negative: c.negative, position: c.position })),
      useCoords: ws.useCoords,
      params: ws.params,
      llm: snapshotLlmOf(ws),
    },
    assembled: { positive: '', negative: '', characters: [] },
    images: [],
  }
  return [{ round: placeholder, live: progress }, ...history.map((round) => ({ round, live: null }))]
}
