import type { FieldSpec } from '@shared/fields'

export interface CursorEvent {
  editorId: string
  doc: string
  specs: readonly FieldSpec[]
  head: number
}

export type CursorListener = (e: CursorEvent) => void

let listener: CursorListener | null = null

/**
 * 正向提示词编辑器 → WIKI 栏的选区变化广播。只允许一个订阅者（WIKI 栏）。
 * WIKI 栏收起或跟随关闭时没有订阅者，编辑器那边先问 active() 再取文档，收起期间零开销（规格 R2）。
 */
export const cursorBus = {
  subscribe(l: CursorListener): () => void {
    listener = l
    return () => {
      if (listener === l) listener = null
    }
  },
  active(): boolean {
    return listener !== null
  },
  emit(e: CursorEvent): void {
    listener?.(e)
  },
}
