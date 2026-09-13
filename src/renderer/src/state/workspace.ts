import { create } from 'zustand'
import type { Workspace } from '@shared/workspace'

/** 停手就存的体感阈值。逐字写盘既浪费，又会把原子写的 rename 打成高频操作 */
export const SAVE_DEBOUNCE_MS = 500

let saveTimer: ReturnType<typeof setTimeout> | null = null
/** 已排期但尚未落盘的工作区；关窗时用它做同步冲刷 */
let pending: Workspace | null = null

function scheduleSave(ws: Workspace, onResult: (error: string | null) => void): void {
  pending = ws
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    pending = null
    // 必须接住：主进程写盘失败（磁盘满、无权限）若无人处理，
    // 就是一个静默的 unhandledrejection，用户只会看到「编辑消失了」
    window.api
      .saveWorkspace(ws)
      .then(() => onResult(null))
      .catch((err: unknown) => onResult(`工作区保存失败：${String(err)}`))
  }, SAVE_DEBOUNCE_MS)
}

/** 把防抖窗口内还没写出去的那一次同步写掉。只给关窗前用 */
export function flushPendingWorkspace(): void {
  if (pending === null) return
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const ws = pending
  pending = null
  try {
    // 窗口即将卸载，这里置位 saveError 用户也看不见；失败只记日志
    if (!window.api.flushWorkspace(ws)) console.error('退出前冲刷工作区失败')
  } catch (err) {
    console.error('退出前冲刷工作区失败', err)
  }
}

/**
 * 挂上关窗冲刷，返回摘除函数。由 App 挂载时调用——不在模块求值期挂：
 * 那样 vitest 的 node 环境 import 本模块会直接 ReferenceError，HMR 下还会重复挂。
 */
export function initWorkspacePersistence(): () => void {
  const handler = (): void => flushPendingWorkspace()
  window.addEventListener('beforeunload', handler)
  return () => window.removeEventListener('beforeunload', handler)
}

interface WorkspaceState {
  workspace: Workspace | null
  loadError: string | null
  saveError: string | null
  load: () => Promise<void>
  /** 以「就地修改草稿」的形式更新工作区；修改后自动防抖落盘 */
  update: (fn: (draft: Workspace) => void) => void
  dismissSaveError: () => void
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  workspace: null,
  loadError: null,
  saveError: null,

  load: async () => {
    try {
      set({ workspace: await window.api.loadWorkspace(), loadError: null })
    } catch (err) {
      set({ loadError: `工作区载入失败：${String(err)}` })
    }
  },

  update: (fn) => {
    const current = get().workspace
    if (current === null) return
    // 结构化克隆而非浅拷贝：params、characters 都是嵌套对象，浅拷贝会让
    // 旧状态被顺手改掉，React 看不出变化，组件不重渲染
    const next = structuredClone(current)
    fn(next)
    set({ workspace: next })
    scheduleSave(next, (error) => set({ saveError: error }))
  },

  dismissSaveError: () => set({ saveError: null }),
}))
