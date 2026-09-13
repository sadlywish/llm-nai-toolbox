import { join } from 'path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { registerIpc } from './ipc'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#15171b',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // 等首屏画完再显示，避免白屏闪一下
  win.on('ready-to-show', () => win.show())

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
  // 必须在 createWindow 之前、且整个应用只调一次。放进 createWindow 会让
  // macOS 的「窗口全关后再激活」走到第二次注册，`ipcMain.handle` 会抛
  // 「Attempted to register a second handler」（实测），窗口建不出来。
  registerIpc({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    // 开发态 app.getAppPath() 就是项目根；打包后是 asar 路径，
    // 那种形态用不到 appRoot（见 resolveTagdbDir）。
    appRoot: app.getAppPath(),
    // %APPDATA%\llm-nai-toolbox（名字取自 package.json 的 name），规格 §2.1
    userDataDir: app.getPath('userData'),
  })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
