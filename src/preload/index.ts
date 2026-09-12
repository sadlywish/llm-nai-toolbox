import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type TagdbCompleteInput } from '@shared/ipc'
import type { CompletionItem } from '../main/tagdb/complete'
import type { TagdbStatus } from '../main/tagdb/loader'

export type TagdbCompleteResult =
  | { ok: true; items: CompletionItem[] }
  | { ok: false; status: TagdbStatus }

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
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
