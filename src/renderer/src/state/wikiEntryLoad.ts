import type { DanbooruArtistInfo, DanbooruPost, DanbooruTagInfo, DanbooruWikiPage } from '@shared/danbooru'
import type { TagLookup } from '@shared/ipc'
import type { TagGloss } from '@shared/magicbook'
import type { PageBucketKind } from '../danbooru/pageBuckets'

/**
 * 标签源 D 站词条的形状与加载（WIKI 竖栏与魔法书共用，规格 §4.3）。
 * 请求代次归调用方管：各自的 patch 里判断结果是否过期，两边互不干扰。
 */

/** 标签源：评分最高 6 张（规格 R5） */
export const TAG_POSTS_LIMIT = 6

export type Load<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; message: string }

export interface PostsBucketState {
  kind: PageBucketKind
  page: number
  posts: Load<DanbooruPost[]>
}

export interface WikiEntry {
  /** 规范名（下划线、小写） */
  tag: string
  source: 'artist' | 'tag'
  /** 本地库；value 为 null = 没收录 */
  local: Load<TagLookup | null>
  /** 标签源用；画师源恒为 ready(null) */
  tagInfo: Load<DanbooruTagInfo | null>
  /** 画师源用；标签源恒为 ready(null) */
  artist: Load<DanbooruArtistInfo | null>
  wiki: Load<DanbooruWikiPage | null>
  /** 标签源例图；画师源恒为 ready([]) */
  tagPosts: Load<DanbooruPost[]>
  /** 画师源分档；null = 还在取帖子数 */
  buckets: PostsBucketState[] | null
  artistPostCount: number | null
  bucketsCollapsed: boolean
  /** 工具附带的中文说明；画师源恒为 ready(null)，没有说明也是 ready(null) */
  gloss: Load<TagGloss | null>
}

export const readyLoad = <T>(value: T): Load<T> => ({ status: 'ready', value })
export const errorLoad = (message: string): Load<never> => ({ status: 'error', message })

/** 标签源词条的初始形状：D 站三块与中文说明都在载入中；local 为 undefined 表示还要查本地库 */
export function tagEntryInit(tag: string, local: TagLookup | null | undefined): WikiEntry {
  return {
    tag,
    source: 'tag',
    local: local === undefined ? { status: 'loading' } : readyLoad(local),
    tagInfo: { status: 'loading' },
    artist: readyLoad(null),
    wiki: { status: 'loading' },
    tagPosts: { status: 'loading' },
    buckets: [],
    artistPostCount: null,
    bucketsCollapsed: false,
    gloss: { status: 'loading' },
  }
}

/** 并发取标签源词条的 D 站三块与中文说明，逐块经 patch 写回 */
export async function loadTagEntry(tag: string, patch: (fn: (e: WikiEntry) => Partial<WikiEntry>) => void): Promise<void> {
  await Promise.all([
    window.api.danbooruTagInfo(tag).then((r) => patch(() => ({ tagInfo: r.ok ? readyLoad(r.tag) : errorLoad(r.error.message) }))),
    window.api.danbooruWiki(tag).then((r) => patch(() => ({ wiki: r.ok ? readyLoad(r.wiki) : errorLoad(r.error.message) }))),
    (async () => {
      let r = await window.api.danbooruPosts({ tag, limit: TAG_POSTS_LIMIT, page: 1, order: 'score' })
      // order:score 被拒（例如匿名 tag 数限制）时退回不排序，至少有图
      if (!r.ok) r = await window.api.danbooruPosts({ tag, limit: TAG_POSTS_LIMIT, page: 1 })
      patch(() => ({ tagPosts: r.ok ? readyLoad(r.posts) : errorLoad(r.error.message) }))
    })(),
    // 中文说明是本地数据，失败（通道异常）按没有说明处理，不占 D 站那几块的错误位
    window.api
      .tagdbGloss(tag)
      .catch(() => null)
      .then((g) => patch(() => ({ gloss: readyLoad(g) }))),
  ])
}
