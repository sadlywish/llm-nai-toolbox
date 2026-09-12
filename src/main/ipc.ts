import { BrowserWindow, ipcMain } from 'electron'
import { IPC, type TagdbCompleteInput } from '@shared/ipc'
import { completeFrom } from './tagdb/complete'
import { TagdbLoader } from './tagdb/loader'
import { resolveTagdbDir } from './tagdb/paths'

/**
 * 注册 IPC 并开始加载标签库。**整个应用只能调一次。**
 *
 * 不收 `win` 参数是有原因的：`ipcMain.handle` 与加载器都是**应用级**的，
 * 而窗口是会开关的。若把本函数放进 `createWindow()`，macOS 上「窗口全关后
 * 再激活」会走到第二次 `createWindow()`，于是：
 *  - 第二次 `ipcMain.handle` **抛错**（实测：`Attempted to register a second
 *    handler for 'tagdb:complete'`），异常发生在 `activate` 回调里，窗口建不出来；
 *  - 还会再构造一个 `TagdbLoader` 并再加载一遍 —— 实测那是 **3949ms** 与
 *    **554MB** 的重复开销。
 *
 * 所以状态推送改为广播给**当前所有窗口**。加载之后才出现的新窗口不靠推送，
 * 它在挂载时会用 `tagdb:status:get` 主动拉一次（见 Task 7 的 store）。
 *
 * 加载不 await：让窗口尽快出来、显示载入中，随后按 tagdb:status 自己刷新。
 * 实测完整加载 **3949ms**（读盘 85ms + JSON.parse 210ms + 建两份索引约 3.6s），
 * 后两段是同步的、会占住主线程 —— 这正是必须先把 `loading` 播出去的原因。
 */
export function registerIpc(
  appInfo: { isPackaged: boolean; resourcesPath: string; appRoot: string },
): void {
  const dir = resolveTagdbDir(appInfo)

  const loader = new TagdbLoader(dir, (status) => {
    // 广播给当前所有窗口。`isDestroyed` 只是省一次无用调用，真正的兜底在
    // TagdbLoader.set 里 —— 它把回调包在 try/catch 里，监听方抛错不会中断加载。
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(IPC.tagdbStatus, status)
    }
  })

  ipcMain.handle(IPC.tagdbComplete, (_e, input: TagdbCompleteInput) => {
    const cats = loader.categories
    if (cats === null) return { ok: false as const, status: loader.status }
    return {
      ok: true as const,
      items: completeFrom(cats, input.query, input.prefer, input.limit),
    }
  })

  // 渲染进程可能在第一条 status 广播之后才挂上监听，所以它也要能主动问一次
  ipcMain.handle(IPC.tagdbStatusGet, () => loader.status)

  void loader.load()
}
