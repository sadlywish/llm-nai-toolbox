import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type ConfigLoadResult,
  type ConfigSaveInput,
  type TagdbCompleteInput,
  type TagdbCompleteResult,
  type TagdbStatus,
} from '@shared/ipc'
import type { LlmEvent, LlmRunInput, LlmRunResult } from '@shared/llm'
import type { StylePreset } from '@shared/styles'
import type { Workspace } from '@shared/workspace'

const api = {
  appVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),

  tagdbComplete: (input: TagdbCompleteInput): Promise<TagdbCompleteResult> =>
    ipcRenderer.invoke(IPC.tagdbComplete, input),

  tagdbStatus: (): Promise<TagdbStatus> => ipcRenderer.invoke(IPC.tagdbStatusGet),

  /** 返回取消订阅的函数 —— 不返回的话组件卸载时没法摘掉监听，HMR 下会越积越多 */
  onTagdbStatus: (cb: (s: TagdbStatus) => void): (() => void) => {
    const handler = (_e: unknown, s: TagdbStatus): void => cb(s)
    ipcRenderer.on(IPC.tagdbStatus, handler)
    return () => ipcRenderer.off(IPC.tagdbStatus, handler)
  },

  loadConfig: (): Promise<ConfigLoadResult> => ipcRenderer.invoke(IPC.configLoad),

  saveConfig: (input: ConfigSaveInput): Promise<void> => ipcRenderer.invoke(IPC.configSave, input),

  loadWorkspace: (): Promise<Workspace> => ipcRenderer.invoke(IPC.workspaceLoad),

  saveWorkspace: (ws: Workspace): Promise<void> => ipcRenderer.invoke(IPC.workspaceSave, ws),

  /** 同步写盘，只给关窗前的 beforeunload 用：那时异步 invoke 来不及返回 */
  flushWorkspace: (ws: Workspace): boolean => ipcRenderer.sendSync(IPC.workspaceFlush, ws),

  /** 跑一轮 LLM。过程经 onLlmEvent 推送；上一轮没结束时 reject */
  llmRun: (input: LlmRunInput): Promise<LlmRunResult> => ipcRenderer.invoke(IPC.llmRun, input),

  llmAbort: (): Promise<void> => ipcRenderer.invoke(IPC.llmAbort),

  /** 返回取消订阅的函数（同 onTagdbStatus） */
  onLlmEvent: (cb: (e: LlmEvent) => void): (() => void) => {
    const handler = (_e: unknown, ev: LlmEvent): void => cb(ev)
    ipcRenderer.on(IPC.llmEvent, handler)
    return () => ipcRenderer.off(IPC.llmEvent, handler)
  },

  loadStyles: (): Promise<StylePreset[]> => ipcRenderer.invoke(IPC.stylesLoad),

  saveStyles: (presets: StylePreset[]): Promise<void> => ipcRenderer.invoke(IPC.stylesSave, presets),

  /** 同步写盘，只给关窗前的 beforeunload 用 */
  flushStyles: (presets: StylePreset[]): boolean => ipcRenderer.sendSync(IPC.stylesFlush, presets),
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
