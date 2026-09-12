import { contextBridge, ipcRenderer } from 'electron'

const api = {
  appVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
