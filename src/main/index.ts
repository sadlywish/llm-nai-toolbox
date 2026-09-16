import { join } from 'path'
import { app, BrowserWindow, ipcMain, nativeImage, screen, session, shell } from 'electron'
import { installContextMenu } from './context-menu'
import { DANBOORU_CDN_URLS, withDanbooruReferer } from './danbooru/cdn'
import { registerIpc, type IpcHooks, type MainServices } from './ipc'
import { fetchSubscription } from './nai/user'
import { appFetch } from './net'
import { createDeviceStore } from './server/devices'
import { createMobileServer } from './server/http'

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

/**
 * 手机端 HTTP 服务的启停（计划 Task 4）。服务本身不 import electron，
 * 凡是 electron 才有的东西都在这里注入：页面目录、缩图、额度查询。
 */
function startMobileServer(services: MainServices, hooks: IpcHooks, userDataDir: string): void {
  const server = createMobileServer({
    services,
    devices: createDeviceStore(join(userDataDir, 'devices.json')),
    // 开发态 __dirname 是 out/main，手机端页面构建在 out/mobile；打包后整个 out 都在 app.asar 里
    staticDir: app.isPackaged
      ? join(process.resourcesPath, 'app.asar', 'out', 'mobile')
      : join(__dirname, '../mobile'),
    makeThumbnail: (png, maxEdge) => {
      const img = nativeImage.createFromBuffer(png)
      const { width, height } = img.getSize()
      // 只给一条边时 nativeImage 会按比例缩；给长边才能保证两边都不超过 maxEdge
      const fit = width >= height ? { width: maxEdge } : { height: maxEdge }
      return Buffer.from(img.resize(fit).toJPEG(80))
    },
    // 与 IPC 的额度查询同一套参数（见 ipc.ts 的 naiSubscription）：Token 与地址都在主进程读
    fetchUsage: () => {
      const config = services.configStore.read()
      return fetchSubscription({
        baseUrl: config.naiBaseUrl,
        token: services.secrets.read('naiToken').trim(),
        timeoutMs: Math.max(10_000, Math.round((config.naiTimeoutSec * 1000) / 10)),
        fetchImpl: appFetch,
      })
    },
  })

  // 启停排成一条队：连着保存两次设置会来两次重启，重叠跑会撞上「服务已经在运行」
  let chain: Promise<void> = Promise.resolve()
  const apply = (enabled: boolean, port: number): void => {
    chain = chain.then(async () => {
      try {
        await server.stop()
        if (!enabled) return
        const { port: actual, urls } = await server.start(port)
        console.log(`[mobile] 手机端服务已启动（端口 ${actual}）：${urls.join('、') || '本机没有可用的局域网地址'}`)
      } catch (e) {
        // 端口被占用之类的启动失败不能把应用带走，记一条就算；设置页上的显示是 Task 10 的事
        console.warn('[mobile] 手机端服务启动失败：', e)
      }
    })
  }

  hooks.onMobileServerSettingsChanged = ({ enabled, port }) => apply(enabled, port)
  const config = services.configStore.read()
  apply(config.mobileServerEnabled, config.mobileServerPort)

  // 退出前停掉：SSE 是长连接，不主动掐断的话端口要等进程真正结束才释放
  app.on('before-quit', () => {
    void server.stop()
  })
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
  // 回调对象先建出来、稍后再填：服务要用 registerIpc 的返回值才能构造（见 IpcHooks 的注释）
  const hooks: IpcHooks = {}
  const userDataDir = app.getPath('userData')
  const services = registerIpc(
    {
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      // 开发态 app.getAppPath() 就是项目根；打包后是 asar 路径，
      // 那种形态用不到 appRoot（见 resolveTagdbDir）。
      appRoot: app.getAppPath(),
      // %APPDATA%\llm-nai-toolbox（名字取自 package.json 的 name），规格 §2.1
      userDataDir,
    },
    hooks,
  )
  startMobileServer(services, hooks, userDataDir)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
