import { join } from 'path'
import { BrowserWindow, clipboard, dialog, ipcMain, safeStorage } from 'electron'
import { mergeConfig, validateConfig } from '@shared/config'
import type { DanbooruArtistSearchInput, DanbooruPostsInput, DanbooruTagsInput } from '@shared/danbooru'
import {
  IPC,
  type ConfigLoadResult,
  type ConfigSaveInput,
  type MagicListResult,
  type MagicSearchResult,
  type MagicTreeResult,
  type MobileStatus,
  type TagdbCompleteInput,
} from '@shared/ipc'
import { parseGenStartInput, type ReadImageInput } from '@shared/gen'
import { parseLlmRunInput, type LlmRunResult } from '@shared/llm'
import { normalizeStyles } from '@shared/styles'
import { normalizeWorkspace } from '@shared/workspace'
import { AppEvents } from './appEvents'
import { ConfigStore } from './config-store'
import { createDanbooruClient, fail as danbooruFail, type DanbooruClient } from './danbooru/client'
import { GenRunner } from './gen/runner'
import { createClaudeChat } from './llm/claude'
import { prepareTagData } from './llm/data'
import { createOpenAIChat } from './llm/openai'
import { TAG_MANUALS, TAG_MANUAL_TOC, TAG_SKILL_CORE } from './llm/resources'
import { LlmSession } from './llm/session'
import { generateImage } from './nai/client'
import { loadRecentRounds, readRoundImage, readRoundImageMeta } from './nai/index-store'
import { fetchSubscription } from './nai/user'
import { appFetch, applyProxy } from './net'
import { SecretStore, type SecretCrypto } from './secret-store'
import { JsonStore } from './store'
import { COMPLETION_PREFERS, completeFrom } from './tagdb/complete'
import { TagExtrasLoader } from './tagdb/extras'
import { TagdbLoader } from './tagdb/loader'
import { lookupTag } from './tagdb/lookup'
import { buildTree, glossOf, listCategory, searchMagic, withGloss } from './tagdb/magicbook'
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

/**
 * 主进程里「有状态、要被复用」的那几样。IPC 与手机端 HTTP 服务必须拿到**同一份**：
 * 各造一份的话，在途保护（同一时刻只跑一轮）与事件订阅就会各说各话——
 * 电脑和手机能同时发起一轮，回填互相覆盖。所以 registerIpc 把它们交出来，
 * 由 index.ts 转手给服务层，而不是让服务层自己 new。
 */
export interface MainServices {
  configStore: ConfigStore
  secrets: SecretStore
  stylesStore: JsonStore<unknown>
  workspaceStore: JsonStore<unknown>
  genRunner: GenRunner
  llmSession: LlmSession
  events: AppEvents
}

/**
 * index.ts 往里填的回调。做成「可后填的对象」而不是 registerIpc 的必填参数，是因为
 * 手机端服务要拿 registerIpc 的返回值才能构造——先有 IPC 才有服务，回调只能晚一步挂上来。
 * 这样 ipc.ts 不必 import server/http.ts，依赖方向仍是 index.ts → ipc.ts、index.ts → server。
 */
export interface IpcHooks {
  /** 保存设置后开关或端口变了；实现方负责按新配置重启服务 */
  onMobileServerSettingsChanged?: (settings: { enabled: boolean; port: number }) => void
  /**
   * 设置页「手机端」分组的三个操作，由 index.ts 在服务与设备表建好之后注入（同
   * onMobileServerSettingsChanged 的理由：ipc.ts 不能 import server/http.ts）。
   * 注册 IPC 处理器时钩子可能还没填上（服务还没起），未注入时给一份「未运行」的状态。
   */
  getMobileStatus?: () => MobileStatus
  newMobileCode?: () => MobileStatus
  revokeMobileDevice?: (deviceId: string) => MobileStatus
}

/** 钩子还没注入时的兜底状态：不代表真的关闭，只是「还不知道」，界面按未运行处理 */
const NO_MOBILE_STATUS: MobileStatus = {
  running: false,
  port: null,
  urls: [],
  code: null,
  codeExpiresAt: null,
  devices: [],
  error: null,
}

export function registerIpc(
  appInfo: { isPackaged: boolean; resourcesPath: string; appRoot: string; userDataDir: string },
  hooks: IpcHooks = {},
): MainServices {
  if (registered) {
    throw new Error('registerIpc 只能在整个应用生命周期里调用一次，见函数注释')
  }
  registered = true

  const configStore = new ConfigStore(appInfo.userDataDir)
  const secrets = new SecretStore(appInfo.userDataDir, electronCrypto)
  // 读进来的形状不可信，一律交给 normalizeWorkspace，所以这里存 unknown
  const workspaceStore = new JsonStore<unknown>(join(appInfo.userDataDir, 'workspace.json'), () => null)
  const stylesStore = new JsonStore<unknown>(join(appInfo.userDataDir, 'styles.json'), () => [])
  // 主进程事件总线。出图事件原本直接广播给窗口，现在先进总线——手机端 HTTP 服务要订同一份
  const events = new AppEvents()

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
    // 写盘前先读一份旧的：手机端服务只在开关或端口真的变了时才重启，
    // 每次保存设置都重启会把正在看进度的手机踢下线
    const before = configStore.read()
    configStore.write(config)
    // 去掉首尾空白：复制粘贴的 Key 常带一个换行，带着它请求会被判 401
    if (typeof input.llmApiKey === 'string') secrets.write('llmApiKey', input.llmApiKey.trim())
    if (typeof input.naiToken === 'string') secrets.write('naiToken', input.naiToken.trim())
    if (typeof input.danbooruApiKey === 'string') secrets.write('danbooruApiKey', input.danbooruApiKey.trim())
    danbooru = buildDanbooru()
    if (
      before.mobileServerEnabled !== config.mobileServerEnabled ||
      before.mobileServerPort !== config.mobileServerPort
    ) {
      hooks.onMobileServerSettingsChanged?.({
        enabled: config.mobileServerEnabled,
        port: config.mobileServerPort,
      })
    }
    // 代理是 session 级设置，改了立刻重新应用，否则就是「填了要重启才生效」
    void applyProxy(config.proxy)
      .then((r) => {
        if (!r.ok) console.warn('[proxy]', r.message)
      })
      .catch((e: unknown) => console.warn('[proxy] 应用代理失败：', e))
  })

  // 设置页「手机端」分组：状态是只读查询，换码与吊销是写操作，三个都直接回最新状态，
  // 省得设置页再补一次查询才能刷新界面
  ipcMain.handle(IPC.mobileStatus, (): MobileStatus => hooks.getMobileStatus?.() ?? NO_MOBILE_STATUS)
  ipcMain.handle(IPC.mobileNewCode, (): MobileStatus => hooks.newMobileCode?.() ?? NO_MOBILE_STATUS)
  ipcMain.handle(IPC.mobileRevoke, (_e, deviceId: unknown): MobileStatus =>
    typeof deviceId === 'string' ? (hooks.revokeMobileDevice?.(deviceId) ?? NO_MOBILE_STATUS) : NO_MOBILE_STATUS,
  )

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

  const dir = resolveTagdbDir({
    ...appInfo,
    // 只给集成测试模拟缺文件；打包态 resolveTagdbDir 不认它
    override: process.env['LLM_NAI_TAGDB_DIR'] || undefined,
  })

  const extras = new TagExtrasLoader(dir)

  const loader = new TagdbLoader(dir, (status) => {
    // 广播给当前所有窗口。`isDestroyed` 只是省一次无用调用，真正的兜底在
    // TagdbLoader.set 里 —— 它把回调包在 try/catch 里，监听方抛错不会中断加载。
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(IPC.tagdbStatus, status)
    }
    // 索引就绪后顺手把魔法书与补全释义要用的两份数据读进来：
    // 放到第一次打开魔法书或第一次补全时再读，会让那一下卡住解析 JSON 的时间
    if (status.state === 'ready') {
      void extras.browse()
      void extras.gloss()
    }
  })

  ipcMain.handle(IPC.tagdbComplete, async (_e, input: TagdbCompleteInput) => {
    // 这是主进程唯一对外暴露的入口——渲染进程 contextIsolation，理论上只有
    // 我们自己写的 preload 会调它，但入口就是入口，不能假定调用方一定守规矩。
    if (typeof input?.query !== 'string' || !COMPLETION_PREFERS.includes(input.prefer)) {
      return { ok: false as const, status: loader.status }
    }
    const cats = loader.categories
    if (cats === null) return { ok: false as const, status: loader.status }
    const items = completeFrom(cats, input.query, input.prefer, input.limit)
    const [gloss, browse] = await Promise.all([extras.gloss(), extras.browse()])
    // 释义补充是 browse 里的一般标签；角色、作品、画师段补一般标签属于跨类，不补（同 complete.ts 的约定）
    const glossMax = input.prefer === 'general' && typeof input.glossMax === 'number' ? input.glossMax : 0
    return {
      ok: true as const,
      items: withGloss(
        items,
        gloss.ok ? gloss.value : null,
        browse.ok ? browse.value : null,
        input.query,
        glossMax,
        input.limit,
      ),
    }
  })

  // 渲染进程可能在第一条 status 广播之后才挂上监听，所以它也要能主动问一次
  ipcMain.handle(IPC.tagdbStatusGet, () => loader.status)

  ipcMain.handle(IPC.tagdbLookup, (_e, tag: unknown) => {
    const cats = loader.categories
    return typeof tag === 'string' && cats !== null ? lookupTag(cats, tag) : null
  })

  ipcMain.handle(IPC.tagdbGloss, async (_e, tag: unknown) => {
    if (typeof tag !== 'string') return null
    const [gloss, browse] = await Promise.all([extras.gloss(), extras.browse()])
    return glossOf(gloss.ok ? gloss.value : null, browse.ok ? browse.value : null, tag)
  })

  ipcMain.handle(IPC.magicbookTree, async (): Promise<MagicTreeResult> => {
    const browse = await extras.browse()
    if (!browse.ok) return { ok: false, detail: browse.detail }
    return { ok: true, ...buildTree(browse.value) }
  })

  ipcMain.handle(IPC.magicbookList, async (_e, cat: unknown): Promise<MagicListResult> => {
    const [browse, gloss] = await Promise.all([extras.browse(), extras.gloss()])
    if (!browse.ok) return { ok: false, detail: browse.detail }
    const items = typeof cat === 'string' ? listCategory(browse.value, gloss.ok ? gloss.value : null, cat) : null
    return { ok: true, items: items ?? [] }
  })

  ipcMain.handle(IPC.magicbookSearch, async (_e, query: unknown, cat: unknown): Promise<MagicSearchResult> => {
    const [browse, gloss] = await Promise.all([extras.browse(), extras.gloss()])
    if (!browse.ok) return { ok: false, detail: browse.detail }
    return {
      ok: true,
      result: searchMagic(
        browse.value,
        gloss.ok ? gloss.value : null,
        typeof query === 'string' ? query : '',
        undefined,
        typeof cat === 'string' ? cat : undefined,
      ),
    }
  })

  /**
   * 同一时刻只允许一轮，闸在 LlmSession 里（手机端 HTTP 服务要用同一道闸）。
   * 每轮的依赖在开跑那一刻现做：配置在发送那一刻读一次，这一轮跑完之前改设置不影响这一轮
   */
  const llmSession = new LlmSession((_input, signal, emit) => {
    const config = configStore.read()
    return {
      config,
      // 明文 Key 只在主进程里用，不进入参、返回值与日志
      apiKey: secrets.read('llmApiKey').trim(),
      chat: config.apiType === 'claude' ? createClaudeChat(appFetch) : createOpenAIChat(appFetch),
      prepareData: (log) => prepareTagData(loader, extras, config, log),
      manuals: TAG_MANUALS,
      manualToc: TAG_MANUAL_TOC,
      skillCore: TAG_SKILL_CORE,
      signal,
      emit,
    }
  })

  // 保持 async：入参不合法时原来是「返回被拒的 Promise」，同步抛出在 ipcMain.handle 里是另一条路径
  ipcMain.handle(IPC.llmRun, async (event, raw: unknown): Promise<LlmRunResult> => {
    // IPC 边界不能假定调用方守规矩：入参先校验，工作区快照过 normalizeWorkspace
    const input = parseLlmRunInput(raw)
    if (typeof input === 'string') throw new Error(input)
    const sender = event.sender
    // LLM 事件只推给发起这一轮的窗口（与出图不同：出图是广播），窗口关了就不推。
    // 收尾的 finished 也走这条通道，保证排在最后一行日志之后
    return llmSession.run(input, (e) => {
      if (!sender.isDestroyed()) sender.send(IPC.llmEvent, e)
    })
  })

  ipcMain.handle(IPC.llmAbort, () => {
    llmSession.abort()
  })

  /** 出图事件广播给当前所有窗口（同 tagdb 状态）：跑图中重开的窗口也要能看到进度 */
  const broadcast = (channel: string, payload: unknown): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload)
    }
  }

  // 出图事件先进总线再由这里广播，手机端 HTTP 服务订同一份总线（计划 Task 8、9）。
  // llm 事件不在这里处理：它只发给发起那一轮的窗口，广播出去会串到别的窗口上
  events.on((e) => {
    switch (e.kind) {
      case 'gen-progress':
        broadcast(IPC.genProgress, e.progress)
        break
      case 'gen-image':
        broadcast(IPC.genImage, e.image)
        break
      case 'gen-seed':
        broadcast(IPC.genSeed, e.seed)
        break
      // 手机端选了预设画风。同出图事件广播给所有窗口：哪个窗口显示着指令区都得跟着换名字
      case 'preset-changed':
        broadcast(IPC.workspacePresetChanged, e.presetId)
        break
      default:
        break
    }
  })

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
    onProgress: (p) => events.emit({ kind: 'gen-progress', progress: p }),
    onImage: (e) => events.emit({ kind: 'gen-image', image: e }),
    onSeedResolved: (seed) => events.emit({ kind: 'gen-seed', seed }),
    now: () => new Date(),
    randomSeed: () => Math.floor(Math.random() * 4294967295),
  })

  // 额度查询：Token 与地址都在主进程读，明文不进渲染层
  ipcMain.handle(IPC.naiSubscription, () => {
    const config = configStore.read()
    return fetchSubscription({
      baseUrl: config.naiBaseUrl,
      token: secrets.read('naiToken').trim(),
      // 额度查询卡住不该拖着界面，取的是出图超时的十分之一、下限 10 秒
      timeoutMs: Math.max(10_000, Math.round((config.naiTimeoutSec * 1000) / 10)),
      fetchImpl: appFetch,
    })
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

  return { configStore, secrets, stylesStore, workspaceStore, genRunner, llmSession, events }
}
