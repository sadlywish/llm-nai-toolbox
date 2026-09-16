import { contextBridge, ipcRenderer } from 'electron'
import type {
  DanbooruArtistResult,
  DanbooruArtistSearchInput,
  DanbooruArtistSearchResult,
  DanbooruPostsInput,
  DanbooruPostsResult,
  DanbooruTagInfoResult,
  DanbooruTagsInput,
  DanbooruTagsResult,
  DanbooruWikiResult,
} from '@shared/danbooru'
import {
  IPC,
  type ConfigLoadResult,
  type ConfigSaveInput,
  type MagicListResult,
  type MagicSearchResult,
  type MagicTreeResult,
  type TagdbCompleteInput,
  type TagdbCompleteResult,
  type TagdbStatus,
  type TagLookup,
} from '@shared/ipc'
import type { GenImageEvent, GenStartInput, ImageMeta, ReadImageInput, RoundRecord, RunProgress } from '@shared/gen'
import type { LlmEvent, LlmRunInput, LlmRunResult } from '@shared/llm'
import type { TagGloss } from '@shared/magicbook'
import type { NaiSubscriptionResult } from '@shared/naiUser'
import type { StylePreset } from '@shared/styles'
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

  /** 系统的选择文件夹对话框；取消返回空串 */
  pickDirectory: (): Promise<string> => ipcRenderer.invoke(IPC.pickDirectory),

  loadWorkspace: (): Promise<Workspace> => ipcRenderer.invoke(IPC.workspaceLoad),

  saveWorkspace: (ws: Workspace): Promise<void> => ipcRenderer.invoke(IPC.workspaceSave, ws),

  /** 同步写盘，只给关窗前的 beforeunload 用：那时异步 invoke 来不及返回 */
  flushWorkspace: (ws: Workspace): boolean => ipcRenderer.sendSync(IPC.workspaceFlush, ws),

  /** 跑一轮 LLM。过程经 onLlmEvent 推送；上一轮没结束时 reject */
  llmRun: (input: LlmRunInput): Promise<LlmRunResult> => ipcRenderer.invoke(IPC.llmRun, input),

  llmAbort: (): Promise<void> => ipcRenderer.invoke(IPC.llmAbort),

  /** 返回取消订阅的函数（同 onTagdbStatus） */
  onLlmEvent: (cb: (e: LlmEvent) => void): (() => void) => {
    const handler = (_e: unknown, ev: LlmEvent): void => cb(ev)
    ipcRenderer.on(IPC.llmEvent, handler)
    return () => ipcRenderer.off(IPC.llmEvent, handler)
  },

  loadStyles: (): Promise<StylePreset[]> => ipcRenderer.invoke(IPC.stylesLoad),

  saveStyles: (presets: StylePreset[]): Promise<void> => ipcRenderer.invoke(IPC.stylesSave, presets),

  /** 同步写盘，只给关窗前的 beforeunload 用 */
  flushStyles: (presets: StylePreset[]): boolean => ipcRenderer.sendSync(IPC.stylesFlush, presets),

  /** 开跑一轮出图。整轮结束（完成、取消、中止）才 resolve；预检失败（没设目录、没填 Token、已有一轮在跑）时 reject */
  genStart: (input: GenStartInput): Promise<RunProgress> => ipcRenderer.invoke(IPC.genStart, input),

  /** 429 暂停后继续 */
  genResume: (): Promise<void> => ipcRenderer.invoke(IPC.genResume),

  genCancel: (): Promise<void> => ipcRenderer.invoke(IPC.genCancel),

  /** 返回取消订阅的函数（同 onTagdbStatus） */
  onGenProgress: (cb: (p: RunProgress) => void): (() => void) => {
    const handler = (_e: unknown, p: RunProgress): void => cb(p)
    ipcRenderer.on(IPC.genProgress, handler)
    return () => ipcRenderer.off(IPC.genProgress, handler)
  },

  onGenImage: (cb: (e: GenImageEvent) => void): (() => void) => {
    const handler = (_e: unknown, ev: GenImageEvent): void => cb(ev)
    ipcRenderer.on(IPC.genImage, handler)
    return () => ipcRenderer.off(IPC.genImage, handler)
  },

  /** 要写回参数区的 seed */
  onGenSeed: (cb: (seed: number) => void): (() => void) => {
    const handler = (_e: unknown, seed: number): void => cb(seed)
    ipcRenderer.on(IPC.genSeed, handler)
    return () => ipcRenderer.off(IPC.genSeed, handler)
  },

  /** 保存目录下最近「历史保留天数」天的轮次，最新的在前 */
  loadHistory: (): Promise<RoundRecord[]> => ipcRenderer.invoke(IPC.historyLoad),

  /** 读一张已落盘的图；不存在或路径越界返回 null */
  readImage: (input: ReadImageInput): Promise<ArrayBuffer | null> => ipcRenderer.invoke(IPC.imageRead, input),

  /** 直接从图片文件里读元信息；读不到文件返回 null */
  readImageMeta: (input: ReadImageInput): Promise<ImageMeta | null> => ipcRenderer.invoke(IPC.imageMeta, input),

  /** 复制视口坐标处已渲染的那张图到剪贴板（查看器的「复制」） */
  copyImageAt: (x: number, y: number): Promise<boolean> => ipcRenderer.invoke(IPC.copyImageAt, { x, y }),

  /** 本地库精确查找；没收录或库没载入返回 null */
  tagdbLookup: (tag: string): Promise<TagLookup | null> => ipcRenderer.invoke(IPC.tagdbLookup, tag),

  /** 工具附带的中文说明；没有说明或数据不可用返回 null */
  tagdbGloss: (tag: string): Promise<TagGloss | null> => ipcRenderer.invoke(IPC.tagdbGloss, tag),

  // 魔法书：tag_browse.json 不可用时 { ok: false, detail }
  magicbookTree: (): Promise<MagicTreeResult> => ipcRenderer.invoke(IPC.magicbookTree),
  magicbookList: (cat: string): Promise<MagicListResult> => ipcRenderer.invoke(IPC.magicbookList, cat),
  magicbookSearch: (query: string, cat?: string): Promise<MagicSearchResult> => ipcRenderer.invoke(IPC.magicbookSearch, query, cat),

  /** NovelAI 账号额度：失败一律返回 { ok: false }，从不 reject */
  naiSubscription: (): Promise<NaiSubscriptionResult> => ipcRenderer.invoke(IPC.naiSubscription),

  writeClipboardText: (text: string): Promise<void> => ipcRenderer.invoke(IPC.clipboardWriteText, text),

  // Danbooru：失败一律返回 { ok: false }，从不 reject
  danbooruTags: (input: DanbooruTagsInput): Promise<DanbooruTagsResult> => ipcRenderer.invoke(IPC.danbooruTags, input),
  danbooruTagInfo: (tag: string): Promise<DanbooruTagInfoResult> => ipcRenderer.invoke(IPC.danbooruTagInfo, tag),
  danbooruWiki: (tag: string): Promise<DanbooruWikiResult> => ipcRenderer.invoke(IPC.danbooruWiki, tag),
  danbooruArtist: (tag: string): Promise<DanbooruArtistResult> => ipcRenderer.invoke(IPC.danbooruArtist, tag),
  danbooruPosts: (input: DanbooruPostsInput): Promise<DanbooruPostsResult> => ipcRenderer.invoke(IPC.danbooruPosts, input),
  danbooruSearchArtistsByOtherName: (input: DanbooruArtistSearchInput): Promise<DanbooruArtistSearchResult> =>
    ipcRenderer.invoke(IPC.danbooruSearchByOtherName, input),
  danbooruSearchArtistsByUrl: (input: DanbooruArtistSearchInput): Promise<DanbooruArtistSearchResult> =>
    ipcRenderer.invoke(IPC.danbooruSearchByUrl, input),
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
