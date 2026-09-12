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
