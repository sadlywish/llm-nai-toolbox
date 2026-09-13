import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type ConfigLoadResult,
  type ConfigSaveInput,
  type TagdbCompleteInput,
  type TagdbCompleteResult,
  type TagdbStatus,
} from '@shared/ipc'
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
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
