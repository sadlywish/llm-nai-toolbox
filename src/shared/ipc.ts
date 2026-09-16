import type { CompletionPrefer } from './blockCompletion'
import type { AppConfig } from './config'
import type { MagicGroup, MagicItem, MagicSearch } from './magicbook'

/** IPC 通道名。主进程与 preload 都从这里取，避免两处各写一份字符串漂移 */
export const IPC = {
  tagdbComplete: 'tagdb:complete',
  /** 主进程 → 渲染进程的状态广播 */
  tagdbStatus: 'tagdb:status',
  /** 渲染进程主动问一次当前状态：第一条广播可能早于组件挂载 */
  tagdbStatusGet: 'tagdb:status:get',
  configLoad: 'config:load',
  configSave: 'config:save',
  pickDirectory: 'dialog:pick-directory',
  workspaceLoad: 'workspace:load',
  workspaceSave: 'workspace:save',
  /** 关窗前的同步冲刷（sendSync），防抖窗口内还没落盘的那一次 */
  workspaceFlush: 'workspace:flush',
  /** 跑一轮 LLM（invoke）。同一时刻只允许一轮 */
  llmRun: 'llm:run',
  /** 中止正在跑的那一轮（invoke） */
  llmAbort: 'llm:abort',
  /** 主进程 → 渲染进程：日志行与轮次 */
  llmEvent: 'llm:event',
  stylesLoad: 'styles:load',
  stylesSave: 'styles:save',
  /** 关窗前的同步冲刷（sendSync），同 workspace:flush */
  stylesFlush: 'styles:flush',
  /** 开跑一轮出图；整轮结束才返回最终进度 */
  /** NovelAI 账号额度：剩余点数与 V5 按时限额 */
  naiSubscription: 'nai:subscription',
  genStart: 'gen:start',
  genResume: 'gen:resume',
  genCancel: 'gen:cancel',
  /** 主进程 → 渲染进程：进度、单张结果、要写回参数区的 seed */
  genProgress: 'gen:progress',
  genImage: 'gen:image',
  genSeed: 'gen:seed',
  historyLoad: 'history:load',
  imageRead: 'image:read',
  imageMeta: 'image:meta',
  copyImageAt: 'clipboard:copy-image-at',
  /** WIKI 栏：本地库精确查找（分类、中文别名、帖子数） */
  tagdbLookup: 'tagdb:lookup',
  /** 「加入」插不进去时的退路 */
  clipboardWriteText: 'clipboard:write-text',
  danbooruTags: 'danbooru:tags',
  danbooruTagInfo: 'danbooru:tag-info',
  danbooruWiki: 'danbooru:wiki',
  danbooruArtist: 'danbooru:artist',
  danbooruPosts: 'danbooru:posts',
  danbooruSearchByOtherName: 'danbooru:search-artists-by-other-name',
  danbooruSearchByUrl: 'danbooru:search-artists-by-url',
  /** 魔法书：分类树 */
  magicbookTree: 'magicbook:tree',
  /** 魔法书：某一类的全部标签 */
  magicbookList: 'magicbook:list',
  /** 魔法书：检索 */
  magicbookSearch: 'magicbook:search',
  /** 工具附带的中文说明（魔法书详情、WIKI 竖栏） */
  tagdbGloss: 'tagdb:gloss',
  /** 设置页「手机端」分组：服务状态、地址、二维码要用的配对码与剩余时间、已配对设备 */
  mobileStatus: 'mobile:status',
  /** 换一个配对码（原来那个立即作废），返回值同 mobileStatus */
  mobileNewCode: 'mobile:new-code',
  /** 吊销一个设备（入参 deviceId），返回值同 mobileStatus */
  mobileRevoke: 'mobile:revoke',
} as const

export interface TagdbCompleteInput {
  query: string
  prefer: CompletionPrefer
  limit?: number
  /**
   * 按中文释义补充最多几条（只在查询含中文、prefer 为 general 时生效）。
   * 不传 = 0，不补充。传了 limit 时补充再封顶到 limit - 原结果条数。
   */
  glossMax?: number
}

export type TagdbState = 'idle' | 'loading' | 'ready' | 'missing' | 'error'

/**
 * 标签库加载状态，是一份 IPC 广播载荷：`detail` 会被渲染进程原样当界面文案
 * 显示。放在 shared/ 而不是 main/tagdb/loader.ts——preload 与渲染进程都要
 * 引用这个类型，而 loader.ts 里挨着 `import { readFile } from 'fs/promises'`，
 * 渲染进程不该有任何理由靠近一个会读文件的模块。
 */
export interface TagdbStatus {
  state: TagdbState
  /** 可直接展示给用户的一句中文说明 */
  detail: string
  counts: { artists: number; characters: number; series: number; general: number } | null
}

export interface CompletionItem {
  tag: string
  /** Danbooru 图数。3 张图和 3 万张图的 tag 值不值得用，差别很大 */
  count: number
  zh: string[]
  series: string[]
  /** 工具附带的中文释义（tag_gloss.json）；没有说明的标签不带 */
  gloss?: string
  /** 这一条是按中文释义补充进来的，不是本地索引按名字/别名匹配出来的 */
  byGloss?: true
}

export type TagdbCompleteResult =
  | { ok: true; items: CompletionItem[] }
  | { ok: false; status: TagdbStatus }

/** 本地库精确查找结果（tagdb:lookup） */
export interface TagLookup {
  tag: string
  category: CompletionPrefer
  zh: string[]
  count: number
}

export interface ConfigLoadResult {
  config: AppConfig
  /** 只回传「有没有存过」，明文永远不进渲染进程 */
  hasLlmApiKey: boolean
  /** 同上：NovelAI Token 有没有存过 */
  hasNaiToken: boolean
  /** 同上：Danbooru API Key 有没有存过 */
  hasDanbooruApiKey: boolean
  /** config.json 在不在；false 时启动自动切到设置页（规格 §14.3） */
  configExists: boolean
}

export interface ConfigSaveInput {
  config: AppConfig
  /** undefined = 不改动已存的 Key。设置页不回显明文，没填就不能把已存的覆盖掉 */
  llmApiKey?: string
  /** 同 llmApiKey：undefined = 不改动已存的 Token */
  naiToken?: string
  /** 同 llmApiKey：undefined = 不改动已存的 Key */
  danbooruApiKey?: string
}

export type MagicTreeResult = { ok: true; groups: MagicGroup[]; total: number } | { ok: false; detail: string }
export type MagicListResult = { ok: true; items: MagicItem[] } | { ok: false; detail: string }
export type MagicSearchResult = { ok: true; result: MagicSearch } | { ok: false; detail: string }

/**
 * 设置页「手机端」分组要展示的一台已配对设备。结构与 `main/server/devices.ts` 的
 * `PairedDevice` 一致，但不从那边 import——`shared/` 给渲染进程与手机前端共用，
 * 不该反过来依赖 `main/`（后者可以自由引用 electron）。
 */
export interface MobileDeviceInfo {
  id: string
  name: string
  /** ISO 时间串 */
  pairedAt: string
  /** ISO 时间串 */
  lastSeenAt: string
}

/** mobile:status / mobile:new-code / mobile:revoke 的统一回话（设置页「手机端」分组用） */
export interface MobileStatus {
  running: boolean
  port: number | null
  /** 各网卡上手机能连的地址；服务没在跑时为空数组 */
  urls: string[]
  /** 当前有效的一次性配对码；没有（还没生成过，或已过期未续）时为 null */
  code: string | null
  /** code 的过期时间（epoch ms）；code 为 null 时同为 null */
  codeExpiresAt: number | null
  devices: MobileDeviceInfo[]
  /** 服务该开却没跑起来的原因（如端口被占用），可直接显示；服务未开启或正常运行时为 null */
  error: string | null
}
