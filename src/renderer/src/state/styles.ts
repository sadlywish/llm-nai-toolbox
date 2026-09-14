import { create } from 'zustand'
import type { StylePreset } from '@shared/styles'

/**
 * 画风预设 store。和工作区一样改动即保存：防抖 500ms 落盘，关窗前同步冲刷一次。
 * 保存逻辑照 state/workspace.ts，两份各自独立——它们写的是不同文件，节奏互不影响。
 */
export const STYLES_SAVE_DEBOUNCE_MS = 500

let saveTimer: ReturnType<typeof setTimeout> | null = null
let pending: StylePreset[] | null = null

export function flushPendingStyles(): void {
  if (pending === null) return
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const presets = pending
  pending = null
  try {
    if (!window.api.flushStyles(presets)) console.error('退出前冲刷画风预设失败')
  } catch (err) {
    console.error('退出前冲刷画风预设失败', err)
  }
}

/** 挂上关窗冲刷，返回摘除函数。由 App 挂载时调用，不在模块求值期碰 window */
export function initStylesPersistence(): () => void {
  const handler = (): void => flushPendingStyles()
  window.addEventListener('beforeunload', handler)
  return () => window.removeEventListener('beforeunload', handler)
}

interface StylesState {
  presets: StylePreset[] | null
  loadError: string | null
  saveError: string | null
  /** 有改动还没落盘（防抖中或写盘中）。画风维护视图底部显示「保存中… / 已保存」 */
  saving: boolean
  load: () => Promise<void>
  update: (fn: (draft: StylePreset[]) => void) => void
  dismissSaveError: () => void
}

export const useStyles = create<StylesState>((set, get) => ({
  presets: null,
  loadError: null,
  saveError: null,
  saving: false,

  load: async () => {
    try {
      set({ presets: await window.api.loadStyles(), loadError: null })
    } catch (err) {
      set({ loadError: `画风预设载入失败：${String(err)}` })
    }
  },

  update: (fn) => {
    const current = get().presets
    if (current === null) return
    const next = structuredClone(current)
    fn(next)
    set({ presets: next, saving: true })
    pending = next
    if (saveTimer !== null) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      const toSave = pending
      pending = null
      if (toSave === null) return
      window.api
        .saveStyles(toSave)
        .then(() => set({ saveError: null, saving: pending !== null }))
        .catch((err: unknown) => set({ saveError: `画风预设保存失败：${String(err)}`, saving: pending !== null }))
    }, STYLES_SAVE_DEBOUNCE_MS)
  },

  dismissSaveError: () => set({ saveError: null }),
}))
