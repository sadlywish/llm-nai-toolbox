import { join } from 'path'
import { BrowserWindow, clipboard, dialog, ipcMain, safeStorage } from 'electron'
import { mergeConfig, validateConfig } from '@shared/config'
import type { DanbooruArtistSearchInput, DanbooruPostsInput, DanbooruTagsInput } from '@shared/danbooru'
import {
  IPC,
  type ConfigLoadResult,
  type ConfigSaveInput,
  type TagdbCompleteInput,
} from '@shared/ipc'
import { parseGenStartInput, type ReadImageInput } from '@shared/gen'
import { parseLlmRunInput, type LlmEvent, type LlmRunResult } from '@shared/llm'
import { normalizeStyles } from '@shared/styles'
import { normalizeWorkspace } from '@shared/workspace'
import { ConfigStore } from './config-store'
import { createDanbooruClient, fail as danbooruFail, type DanbooruClient } from './danbooru/client'
import { GenRunner } from './gen/runner'
import { createClaudeChat } from './llm/claude'
import { prepareTagData } from './llm/data'
import { createOpenAIChat } from './llm/openai'
import { TAG_MANUALS, TAG_MANUAL_TOC, TAG_SKILL_CORE } from './llm/resources'
import { runLlm } from './llm/runner'
import { generateImage } from './nai/client'
import { loadRecentRounds, readRoundImage, readRoundImageMeta } from './nai/index-store'
import { appFetch, applyProxy } from './net'
import { SecretStore, type SecretCrypto } from './secret-store'
import { JsonStore } from './store'
import { COMPLETION_PREFERS, completeFrom } from './tagdb/complete'
import { TagExtrasLoader } from './tagdb/extras'
import { TagdbLoader } from './tagdb/loader'
import { lookupTag } from './tagdb/lookup'
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
 *    **554MB** 的重复开销。554MB 本身不是异常数字：两份索引常驻内存、
 *    进程活多久占多久，没有淘汰机制，这是量过之后接受的代价；这里说的
 *    「开销」专指白白再付一次，bug 是重复加载，不是常驻本身。
 *
 * 所以状态推送改为广播给**当前所有窗口**。加载之后才出现的新窗口不靠推送，
 * 它在挂载时会用 `tagdb:status:get` 主动拉一次（见 Task 7 的 store）。
 *
 * 加载不 await：让窗口尽快出来、显示载入中，随后按 tagdb:status 自己刷新。
 * 实测完整加载 **3949ms**（读盘 85ms + JSON.parse 210ms + 建两份索引约 3.6s），
 * 后两段是同步的、会占住主线程 —— 这正是必须先把 `loading` 播出去的原因。
 */
// 见上面的函数注释：违反「只能调一次」目前只会得到 Electron 那句不指名道姓的
// 「second handler」异常，排查者得先怀疑到这里才行。这里提前拦一道，把违反的
// 是哪条契约说清楚。
let registered = false

/**
 * 生产环境的加密实现：Electron 的 safeStorage，Windows 下即 DPAPI，
 * 加密绑定当前系统用户。换机器后旧密文解不开，SecretStore 当作未设置。
 */
const electronCrypto: SecretCrypto = {
  encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
  decrypt: (cipher) => safeStorage.decryptString(Buffer.from(cipher, 'base64')),
}

/** image:read / image:meta 的入参守卫：渲染进程可任意调用，不是对象时下游解构会抛 */
function asReadImageInput(v: unknown): ReadImageInput | null {
  if (typeof v !== 'object' || v === null) return null
  const { roundStartedAt, file } = v as Record<string, unknown>
  return typeof roundStartedAt === 'string' && typeof file === 'string' ? { roundStartedAt, file } : null
}

export function registerIpc(
  appInfo: { isPackaged: boolean; resourcesPath: string; appRoot: string; userDataDir: string },
): void {
  if (registered) {
    throw new Error('registerIpc 只能在整个应用生命周期里调用一次，见函数注释')
  }
  registered = true

  const configStore = new ConfigStore(appInfo.userDataDir)
  const secrets = new SecretStore(appInfo.userDataDir, electronCrypto)
  // 读进来的形状不可信，一律交给 normalizeWorkspace，所以这里存 unknown
  const workspaceStore = new JsonStore<unknown>(join(appInfo.userDataDir, 'workspace.json'), () => null)
  const stylesStore = new JsonStore<unknown>(join(appInfo.userDataDir, 'styles.json'), () => [])

  const danbooruCacheDir = join(appInfo.userDataDir, 'danbooru-cache')
  // 用户名与 Key 在构造时读一次；保存设置后整个重建（令牌桶、内存缓存跟着换新，磁盘缓存不受影响）
  const buildDanbooru = (): DanbooruClient =>
    createDanbooruClient({
      cacheDir: danbooruCacheDir,
      fetchImpl: appFetch,
      login: configStore.read().danbooruLogin.trim(),
      apiKey: secrets.read('danbooruApiKey').trim(),
      // 只给集成测试的桩用；生产环境没有这个变量
      baseUrl: process.env['LLM_NAI_DANBOORU_BASE_URL'] || undefined,
    })
  let danbooru = buildDanbooru()

  // 代理必须在任何请求之前生效。不 await：窗口先出来，setProxy 只影响后续请求
  void applyProxy(configStore.read().proxy)
    .then((r) => {
      if (!r.ok) console.warn('[proxy]', r.message)
    })
    .catch((e: unknown) => console.warn('[proxy] 应用代理失败：', e))

  ipcMain.handle(
    IPC.configLoad,
    (): ConfigLoadResult => ({
      config: configStore.read(),
      hasLlmApiKey: secrets.read('llmApiKey') !== '',
      hasNaiToken: secrets.read('naiToken') !== '',
      hasDanbooruApiKey: secrets.read('danbooruApiKey') !== '',
      configExists: configStore.exists(),
    }),
  )

  ipcMain.handle(IPC.configSave, (_e, input: ConfigSaveInput) => {
    // IPC 边界不能假定调用方守规矩：先判过再解构
    if (typeof input !== 'object' || input === null) throw new Error('config:save 入参无效')
    const config = mergeConfig(input.config)
    const errors = Object.values(validateConfig(config))
    if (errors.length > 0) throw new Error(`配置不合法：${errors.join('；')}`)
    configStore.write(config)
    // 去掉首尾空白：复制粘贴的 Key 常带一个换行，带着它请求会被判 401
    if (typeof input.llmApiKey === 'string') secrets.write('llmApiKey', input.llmApiKey.trim())
    if (typeof input.naiToken === 'string') secrets.write('naiToken', input.naiToken.trim())
    if (typeof input.danbooruApiKey === 'string') secrets.write('danbooruApiKey', input.danbooruApiKey.trim())
    danbooru = buildDanbooru()
    // 代理是 session 级设置，改了立刻重新应用，否则就是「填了要重启才生效」
    void applyProxy(config.proxy)
      .then((r) => {
        if (!r.ok) console.warn('[proxy]', r.message)
      })
      .catch((e: unknown) => console.warn('[proxy] 应用代理失败：', e))
  })

  ipcMain.handle(IPC.pickDirectory, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? '' : (result.filePaths[0] ?? '')
  })

  ipcMain.handle(IPC.copyImageAt, (event, input: unknown) => {
    // 入参守卫先于使用：坐标不是数字时 copyImageAt 会抛，异常逃出 handler 就破坏了「永不 reject」
    if (typeof input !== 'object' || input === null) return false
    const { x, y } = input as { x?: unknown; y?: unknown }
    if (typeof x !== 'number' || !Number.isFinite(x)) return false
    if (typeof y !== 'number' || !Number.isFinite(y)) return false
    event.sender.copyImageAt(Math.round(x), Math.round(y))
    return true
  })

  ipcMain.handle(IPC.clipboardWriteText, (_e, text: unknown) => {
    if (typeof text === 'string') clipboard.writeText(text)
  })

  // ── Danbooru（WIKI 栏）。入参先守卫再用；客户端方法永不 reject ──
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
  const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0
  ipcMain.handle(IPC.danbooruTags, (_e, input: unknown) =>
    isObj(input) && typeof input.nameMatches === 'string' && isPositiveInt(input.limit)
      ? danbooru.tags((input as unknown as DanbooruTagsInput).nameMatches, input.limit)
      : danbooruFail('invalid', '参数不合法'),
  )
  ipcMain.handle(IPC.danbooruTagInfo, (_e, tag: unknown) =>
    typeof tag === 'string' ? danbooru.tagInfo(tag) : danbooruFail('invalid', '参数不合法'),
  )
  ipcMain.handle(IPC.danbooruWiki, (_e, tag: unknown) =>
    typeof tag === 'string' ? danbooru.wiki(tag) : danbooruFail('invalid', '参数不合法'),
  )
  ipcMain.handle(IPC.danbooruArtist, (_e, tag: unknown) =>
    typeof tag === 'string' ? danbooru.artist(tag) : danbooruFail('invalid', '参数不合法'),
  )
  ipcMain.handle(IPC.danbooruPosts, (_e, input: unknown) => {
    if (!isObj(input) || typeof input.tag !== 'string' || !isPositiveInt(input.limit) || !isPositiveInt(input.page)) {
      return danbooruFail('invalid', '参数不合法')
    }
    const { tag, limit, page, order } = input as unknown as DanbooruPostsInput
    return danbooru.posts(tag, limit, page, order)
  })
  ipcMain.handle(IPC.danbooruSearchByOtherName, (_e, input: unknown) =>
    isObj(input) && typeof input.query === 'string' && isPositiveInt(input.limit)
      ? danbooru.searchArtistsByOtherName((input as unknown as DanbooruArtistSearchInput).query, input.limit)
      : danbooruFail('invalid', '参数不合法'),
  )
  ipcMain.handle(IPC.danbooruSearchByUrl, (_e, input: unknown) =>
    isObj(input) && typeof input.query === 'string' && isPositiveInt(input.limit)
      ? danbooru.searchArtistsByUrl((input as unknown as DanbooruArtistSearchInput).query, input.limit)
      : danbooruFail('invalid', '参数不合法'),
  )

  ipcMain.handle(IPC.workspaceLoad, () => normalizeWorkspace(workspaceStore.read()))

  ipcMain.handle(IPC.workspaceSave, (_e, ws: unknown) => {
    workspaceStore.write(normalizeWorkspace(ws))
  })

  ipcMain.on(IPC.workspaceFlush, (event, ws: unknown) => {
    try {
      workspaceStore.write(normalizeWorkspace(ws))
      event.returnValue = true
    } catch {
      // 每条路径都必须给 returnValue 赋值，否则渲染进程会一直阻塞在 sendSync 上
      event.returnValue = false
    }
  })

  ipcMain.handle(IPC.stylesLoad, () => normalizeStyles(stylesStore.read()))

  ipcMain.handle(IPC.stylesSave, (_e, presets: unknown) => {
    stylesStore.write(normalizeStyles(presets))
  })

  ipcMain.on(IPC.stylesFlush, (event, presets: unknown) => {
    try {
      stylesStore.write(normalizeStyles(presets))
      event.returnValue = true
    } catch {
      // 每条路径都必须给 returnValue 赋值，否则渲染进程会一直阻塞在 sendSync 上
      event.returnValue = false
    }
  })

  const dir = resolveTagdbDir(appInfo)

  const loader = new TagdbLoader(dir, (status) => {
    // 广播给当前所有窗口。`isDestroyed` 只是省一次无用调用，真正的兜底在
    // TagdbLoader.set 里 —— 它把回调包在 try/catch 里，监听方抛错不会中断加载。
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(IPC.tagdbStatus, status)
    }
  })

  ipcMain.handle(IPC.tagdbComplete, (_e, input: TagdbCompleteInput) => {
    // 这是主进程唯一对外暴露的入口——渲染进程 contextIsolation，理论上只有
    // 我们自己写的 preload 会调它，但入口就是入口，不能假定调用方一定守规矩。
    if (typeof input?.query !== 'string' || !COMPLETION_PREFERS.includes(input.prefer)) {
      return { ok: false as const, status: loader.status }
    }
    const cats = loader.categories
    if (cats === null) return { ok: false as const, status: loader.status }
    return {
      ok: true as const,
      items: completeFrom(cats, input.query, input.prefer, input.limit),
    }
  })

  // 渲染进程可能在第一条 status 广播之后才挂上监听，所以它也要能主动问一次
  ipcMain.handle(IPC.tagdbStatusGet, () => loader.status)

  ipcMain.handle(IPC.tagdbLookup, (_e, tag: unknown) => {
    const cats = loader.categories
    return typeof tag === 'string' && cats !== null ? lookupTag(cats, tag) : null
  })

  const extras = new TagExtrasLoader(dir)
  /** 正在跑的那一轮。同一时刻只允许一轮：两轮并发写同一份工作区，回填结果谁先谁后说不清 */
  let currentRun: AbortController | null = null

  ipcMain.handle(IPC.llmRun, async (event, raw: unknown): Promise<LlmRunResult> => {
    // IPC 边界不能假定调用方守规矩：入参先校验，工作区快照过 normalizeWorkspace
    const input = parseLlmRunInput(raw)
    if (typeof input === 'string') throw new Error(input)
    if (currentRun !== null) throw new Error('上一轮还在运行，先等它结束或中止')

    // 配置在发送那一刻读一次：这一轮跑完之前改设置，不影响这一轮
    const config = configStore.read()
    const controller = new AbortController()
    currentRun = controller
    const sender = event.sender
    try {
      const result = await runLlm(input, {
        config,
        // 明文 Key 只在主进程里用，不进入参、返回值与日志
        apiKey: secrets.read('llmApiKey').trim(),
        chat: config.apiType === 'claude' ? createClaudeChat(appFetch) : createOpenAIChat(appFetch),
        prepareData: (log) => prepareTagData(loader, extras, config, log),
        manuals: TAG_MANUALS,
        manualToc: TAG_MANUAL_TOC,
        skillCore: TAG_SKILL_CORE,
        signal: controller.signal,
        // 只推给发起这一轮的窗口；窗口关了就不推
        emit: (e) => {
          if (!sender.isDestroyed()) sender.send(IPC.llmEvent, e)
        },
      })
      // 收尾经事件送达：与日志同一条通道，保证排在最后一行日志之后
      if (!sender.isDestroyed()) sender.send(IPC.llmEvent, { kind: 'finished', result } satisfies LlmEvent)
      return result
    } finally {
      currentRun = null
    }
  })

  ipcMain.handle(IPC.llmAbort, () => {
    currentRun?.abort()
  })

  /** 出图事件广播给当前所有窗口（同 tagdb 状态）：跑图中重开的窗口也要能看到进度 */
  const broadcast = (channel: string, payload: unknown): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload)
    }
  }

  const genRunner = new GenRunner({
    generate: (body, config, token) =>
      generateImage(
        {
          baseUrl: config.naiBaseUrl,
          token,
          timeoutMs: config.naiTimeoutSec * 1000,
          imageFormat: config.imageFormat,
          fetchImpl: appFetch,
        },
        body,
      ),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onProgress: (p) => broadcast(IPC.genProgress, p),
    onImage: (e) => broadcast(IPC.genImage, e),
    onSeedResolved: (seed) => broadcast(IPC.genSeed, seed),
    now: () => new Date(),
    randomSeed: () => Math.floor(Math.random() * 4294967295),
  })

  ipcMain.handle(IPC.genStart, (_e, raw: unknown) => {
    const input = parseGenStartInput(raw)
    if (typeof input === 'string') throw new Error(input)
    // 配置与 Token 在开跑那一刻读一次；明文 Token 只在主进程里用，不进事件与返回值
    return genRunner.start(input, configStore.read(), secrets.read('naiToken').trim())
  })
  ipcMain.handle(IPC.genResume, () => genRunner.resume())
  ipcMain.handle(IPC.genCancel, () => genRunner.cancel())

  ipcMain.handle(IPC.historyLoad, () => {
    const config = configStore.read()
    return loadRecentRounds(config.saveDir, config.historyDays)
  })
  ipcMain.handle(IPC.imageRead, (_e, raw: unknown) => {
    const input = asReadImageInput(raw)
    return input === null ? null : readRoundImage(configStore.read().saveDir, input)
  })
  ipcMain.handle(IPC.imageMeta, (_e, raw: unknown) => {
    const input = asReadImageInput(raw)
    return input === null ? null : readRoundImageMeta(configStore.read().saveDir, input)
  })

  void loader.load()
}
