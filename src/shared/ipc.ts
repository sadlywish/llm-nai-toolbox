import type { CompletionPrefer } from './blockCompletion'
import type { AppConfig } from './config'

/** IPC 通道名。主进程与 preload 都从这里取，避免两处各写一份字符串漂移 */
export const IPC = {
  tagdbComplete: 'tagdb:complete',
  /** 主进程 → 渲染进程的状态广播 */
  tagdbStatus: 'tagdb:status',
  /** 渲染进程主动问一次当前状态：第一条广播可能早于组件挂载 */
  tagdbStatusGet: 'tagdb:status:get',
  configLoad: 'config:load',
  configSave: 'config:save',
  workspaceLoad: 'workspace:load',
  workspaceSave: 'workspace:save',
  /** 关窗前的同步冲刷（sendSync），防抖窗口内还没落盘的那一次 */
  workspaceFlush: 'workspace:flush',
  /** 跑一轮 LLM（invoke）。同一时刻只允许一轮 */
  llmRun: 'llm:run',
  /** 中止正在跑的那一轮（invoke） */
  llmAbort: 'llm:abort',
  /** 主进程 → 渲染进程：日志行与轮次 */
  llmEvent: 'llm:event',
  stylesLoad: 'styles:load',
  stylesSave: 'styles:save',
  /** 关窗前的同步冲刷（sendSync），同 workspace:flush */
  stylesFlush: 'styles:flush',
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

export interface ConfigLoadResult {
  config: AppConfig
  /** 只回传「有没有存过」，明文永远不进渲染进程 */
  hasLlmApiKey: boolean
  /** config.json 在不在；false 时启动自动弹设置抽屉（规格 §14.3） */
  configExists: boolean
}

export interface ConfigSaveInput {
  config: AppConfig
  /** undefined = 不改动已存的 Key。设置抽屉不回显明文，没填就不能把已存的覆盖掉 */
  llmApiKey?: string
}
