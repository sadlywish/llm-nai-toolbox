import type { EditorView } from '@codemirror/view'
import { blockRanges } from '@shared/blockDoc'
import { fieldIndexAt } from '@shared/blockNav'
import type { FieldSpec } from '@shared/fields'
import { insertTagAt } from '../prompt/insertTag'

interface Entry {
  view: EditorView
  specs: readonly FieldSpec[]
}

const entries = new Map<string, Entry>()
let lastFocused: string | null = null

export function registerEditor(id: string, view: EditorView, specs: readonly FieldSpec[]): void {
  entries.set(id, { view, specs })
}

/** 只摘同一个实例：StrictMode 重挂、换页签时新实例可能先登记 */
export function unregisterEditor(id: string, view: EditorView): void {
  if (entries.get(id)?.view === view) entries.delete(id)
}

export function noteEditorFocus(id: string): void {
  lastFocused = id
}

/**
 * 「加入」：插到最后聚焦的正向提示词编辑器里、它当前选区所在的位置（规格 R7）。
 * 编辑器失焦后选区仍保留在它的 state 里，所以直接读 selection.main.head。
 * 插不进去（从没聚焦过、那个框已卸载、分块守卫拒绝了改动）返回 false，由调用方退回复制。
 */
export function insertIntoLastEditor(text: string): boolean {
  const entry = lastFocused === null ? undefined : entries.get(lastFocused)
  if (!entry) return false
  const { view, specs } = entry
  const doc = view.state.doc.toString()
  const head = view.state.selection.main.head
  const range = blockRanges(doc, specs)[fieldIndexAt(doc, head)]
  if (!range) return false
  const local = Math.max(0, Math.min(head - range.from, range.to - range.from))
  const r = insertTagAt(doc.slice(range.from, range.to), local, text)
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: r.text },
    selection: { anchor: range.from + r.cursor },
    scrollIntoView: true,
  })
  if (view.state.doc.toString() === doc) return false
  view.focus()
  return true
}
