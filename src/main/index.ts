import { join } from 'path'
import { app, BrowserWindow, ipcMain, screen, session, shell } from 'electron'
import { installContextMenu } from './context-menu'
import { DANBOORU_CDN_URLS, withDanbooruReferer } from './danbooru/cdn'
import { registerIpc } from './ipc'

/* 默认窗口按 1080P 开，并按工作区上限收窄（同画师串工具箱）：
   设计基准是 1920 − 200（历史竖栏）− 400（WIKI 竖栏）≈ 1320 的中间列。
   取 workAreaSize 而不是屏幕尺寸，任务栏才不会被盖住；比 1080P 小的屏幕照样能开。 */
function createWindow(): void {
  const { workAreaSize } = screen.getPrimaryDisplay()
  const win = new BrowserWindow({
    width: Math.min(1920, workAreaSize.width),
    height: Math.min(1080, workAreaSize.height),
    minWidth: 1024,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // 等首屏画完再显示，避免白屏闪一下
  win.on('ready-to-show', () => win.show())
  installContextMenu(win)

  // 页面里的外链一律交给系统浏览器，不在应用内开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    // 只放行 http/https。无条件 openExternal 会把 file:、ms-* 这类 scheme
    // 一并交给系统处理，WIKI 区落地后就是一个可利用面。
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

// 版本号取 app.getVersion()，也就是 Electron 从 package.json 读出来的那个。
// 不烤成渲染层的构建期常量——那样 dev 与打包版会报不同的值。
ipcMain.handle('app:version', () => app.getVersion())

void app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: DANBOORU_CDN_URLS }, (details, callback) => {
    callback({ requestHeaders: withDanbooruReferer(details.requestHeaders) })
  })

  // 必须在 createWindow 之前、且整个应用只调一次。放进 createWindow 会让
  // macOS 的「窗口全关后再激活」走到第二次注册，`ipcMain.handle` 会抛
  // 「Attempted to register a second handler」（实测），窗口建不出来。
  // 返回的这几样服务先接住：手机端 HTTP 服务（计划 Task 4）要和 IPC 用同一份
  // GenRunner / LlmSession / 事件总线，各造一份会让在途保护与事件订阅各说各话
  const services = registerIpc({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    // 开发态 app.getAppPath() 就是项目根；打包后是 asar 路径，
    // 那种形态用不到 appRoot（见 resolveTagdbDir）。
    appRoot: app.getAppPath(),
    // %APPDATA%\llm-nai-toolbox（名字取自 package.json 的 name），规格 §2.1
    userDataDir: app.getPath('userData'),
  })
  void services
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
