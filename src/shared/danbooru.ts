/**
 * Danbooru 相关的共享类型与规则（移植自画师串工具箱 src/shared/types.ts 的 Danbooru 段与 src/shared/tags.ts）。
 * 主进程构造 URL、渲染进程比对返回名都要用 normalizeTag，两边必须是同一套规则。
 */

export const DANBOORU_BASE_URL = 'https://danbooru.donmai.us'

/** tags.json 的 category 数字 */
export const DANBOORU_CATEGORY = { general: 0, artist: 1, copyright: 3, character: 4, meta: 5 } as const

/**
 * 用户写法 → Danbooru 规范形式：首尾去空白、连续空白折叠成下划线。
 * `tags=` 参数里空格是多个 tag 之间的 AND 分隔符，`manzai sugar` 不归一会查出 0 条。
 */
export function normalizeTag(tag: string): string {
  return tag.trim().replace(/\s+/g, '_')
}

export type DanbooruErrorKind = 'network' | 'timeout' | 'http' | 'invalid'

export interface DanbooruError {
  kind: DanbooruErrorKind
  /** 可直接展示的中文说明；界面只写一行灰字，不弹窗 */
  message: string
}

export interface DanbooruTagItem {
  name: string
  postCount: number
  category: number
}

export type DanbooruTagsResult = { ok: true; tags: DanbooruTagItem[] } | { ok: false; error: DanbooruError }

export interface DanbooruTagsInput {
  nameMatches: string
  limit: number
}

/** 标签源词条头：精确名的分类与帖子数 */
export interface DanbooruTagInfo {
  name: string
  category: number
  postCount: number
}

/** tag 为 null = D 站没有这个标签（不是错误） */
export type DanbooruTagInfoResult = { ok: true; tag: DanbooruTagInfo | null } | { ok: false; error: DanbooruError }

export interface DanbooruWikiPage {
  title: string
  body: string
}

/** wiki 为 null = 已确认没有可显示的正文（404 或空 body），不是错误 */
export type DanbooruWikiResult = { ok: true; wiki: DanbooruWikiPage | null } | { ok: false; error: DanbooruError }

export interface DanbooruArtistInfo {
  name: string
  otherNames: string[]
  urls: string[]
  isBanned: boolean
  isDeleted: boolean
}

export type DanbooruArtistResult = { ok: true; artist: DanbooruArtistInfo | null } | { ok: false; error: DanbooruError }

export interface DanbooruArtistSearchItem {
  name: string
  otherNames: string[]
  urls: string[]
}

export type DanbooruArtistSearchResult =
  | { ok: true; items: DanbooruArtistSearchItem[] }
  | { ok: false; error: DanbooruError }

export interface DanbooruArtistSearchInput {
  query: string
  limit: number
}

export interface DanbooruPost {
  id: number
  /** 缺失时渲染层回退 largeUrl */
  previewUrl: string | null
  /** large_file_url：压缩过的 sample */
  largeUrl: string | null
  /** file_url：原图，查看器优先用它 */
  originalUrl: string | null
}

export type DanbooruPostsResult = { ok: true; posts: DanbooruPost[] } | { ok: false; error: DanbooruError }

/** 目前只有标签源用「评分最高」 */
export type DanbooruPostsOrder = 'score'

export interface DanbooruPostsInput {
  tag: string
  limit: number
  page: number
  order?: DanbooruPostsOrder
}
