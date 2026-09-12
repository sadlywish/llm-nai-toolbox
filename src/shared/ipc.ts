import type { CompletionPrefer } from './blockCompletion'

/** IPC 通道名。主进程与 preload 都从这里取，避免两处各写一份字符串漂移 */
export const IPC = {
  tagdbComplete: 'tagdb:complete',
  /** 主进程 → 渲染进程的状态广播 */
  tagdbStatus: 'tagdb:status',
  /** 渲染进程主动问一次当前状态：第一条广播可能早于组件挂载 */
  tagdbStatusGet: 'tagdb:status:get',
} as const

export interface TagdbCompleteInput {
  query: string
  prefer: CompletionPrefer
  limit?: number
}

export type TagdbState = 'idle' | 'loading' | 'ready' | 'missing' | 'error'

/**
 * 标签库加载状态，是一份 IPC 广播载荷：`detail` 会被渲染进程原样当界面文案
 * 显示。放在 shared/ 而不是 main/tagdb/loader.ts——preload 与渲染进程都要
 * 引用这个类型，而 loader.ts 里挨着 `import { readFile } from 'fs/promises'`，
 * 渲染进程不该有任何理由靠近一个会读文件的模块。
 */
export interface TagdbStatus {
  state: TagdbState
  /** 可直接展示给用户的一句中文说明 */
  detail: string
  counts: { artists: number; characters: number; series: number; general: number } | null
}

export interface CompletionItem {
  tag: string
  /** Danbooru 图数。3 张图和 3 万张图的 tag 值不值得用，差别很大 */
  count: number
  zh: string[]
  series: string[]
}

export type TagdbCompleteResult =
  | { ok: true; items: CompletionItem[] }
  | { ok: false; status: TagdbStatus }
