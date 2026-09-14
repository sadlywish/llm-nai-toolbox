import { create } from 'zustand'
import type { CompletionPrefer } from '@shared/blockCompletion'
import {
  normalizeTag,
  type DanbooruArtistInfo,
  type DanbooruPost,
  type DanbooruTagInfo,
  type DanbooruWikiPage,
} from '@shared/danbooru'
import type { CompletionItem, TagLookup } from '@shared/ipc'
import { computePageBuckets, type PageBucketKind } from '../danbooru/pageBuckets'
import { looksLikeLinkQuery, mergeArtistSuggestions, mergeTagSuggestions, type WikiSuggestion } from '../danbooru/suggest'
import { cleanCursorWord } from '../prompt/insertTag'

/** 跟随光标防抖（规格 §11.4），与编辑器补全的 250ms 不是一回事 */
export const CURSOR_DEBOUNCE_MS = 400
export const SEARCH_DEBOUNCE_MS = 250
/** 标签源：评分最高 6 张（规格 R5） */
export const TAG_POSTS_LIMIT = 6
/** 画师源分档的分页 limit；显示张数是另一个常量，两者不复用（规格 §11.3） */
export const ARTIST_POSTS_PER_PAGE = 20
export const ARTIST_THUMBS_PER_BUCKET = 6
const TAG_LOOKUP_LIMIT = 10
const SEARCH_LIMIT = 20

const KEY_COLLAPSED = 'wiki.collapsed'
const KEY_FOLLOW = 'wiki.follow-cursor'
const KEY_SOURCE = 'wiki.source'

export type WikiSource = 'artist' | 'tag'

export type Load<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; message: string }

export interface PostsBucketState {
  kind: PageBucketKind
  page: number
  posts: Load<DanbooruPost[]>
}

export interface WikiEntry {
  /** 规范名（下划线、小写） */
  tag: string
  source: WikiSource
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
}

interface WikiState {
  collapsed: boolean
  followCursor: boolean
  source: WikiSource
  query: string
  suggestions: WikiSuggestion[]
  suggestLoading: boolean
  entry: WikiEntry | null
  /** 词条头下方的一次性提示（「已复制到剪贴板」） */
  notice: string | null
  toggleCollapsed: () => void
  toggleFollowCursor: () => void
  setSource: (source: WikiSource) => void
  setQuery: (q: string) => void
  show: (tag: string, source: WikiSource) => void
  onCursorWord: (word: string, preferArtist: boolean) => void
  setNotice: (text: string | null) => void
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}

function readSource(): WikiSource {
  try {
    return localStorage.getItem(KEY_SOURCE) === 'artist' ? 'artist' : 'tag'
  } catch {
    return 'tag'
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 存不下就算了：只影响下次启动的默认值
  }
}

/** 规范名：去 artist:/@ 前缀、空白折下划线、小写（Danbooru tag 全小写） */
function canonical(tag: string): string {
  return normalizeTag(tag.trim().replace(/^artist:/i, '').replace(/^@/, '')).toLowerCase()
}

const ready = <T>(value: T): Load<T> => ({ status: 'ready', value })
const errorOf = (message: string): Load<never> => ({ status: 'error', message })

// 防抖与请求代次放模块级，不进 store：它们不是要渲染的状态
let searchTimer: ReturnType<typeof setTimeout> | null = null
let cursorTimer: ReturnType<typeof setTimeout> | null = null
/** 最近一次被光标选中的词；同一个词不重复查 */
let lastCursorKey: string | null = null
let requestSeq = 0

async function safeLookup(tag: string): Promise<TagLookup | null> {
  try {
    return await window.api.tagdbLookup(tag)
  } catch {
    return null
  }
}

async function safeComplete(query: string, prefer: CompletionPrefer): Promise<CompletionItem[]> {
  try {
    const r = await window.api.tagdbComplete({ query, prefer, limit: SEARCH_LIMIT })
    return r.ok ? r.items : []
  } catch {
    return []
  }
}

export const useWiki = create<WikiState>((set, get) => {
  /** 只在代次仍是当前时改词条；旧请求晚回来直接丢掉 */
  const patch = (seq: number, fn: (e: WikiEntry) => Partial<WikiEntry>): void => {
    const e = get().entry
    if (seq !== requestSeq || e === null) return
    set({ entry: { ...e, ...fn(e) } })
  }

  async function loadTag(tag: string, seq: number): Promise<void> {
    await Promise.all([
      window.api.danbooruTagInfo(tag).then((r) => patch(seq, () => ({ tagInfo: r.ok ? ready(r.tag) : errorOf(r.error.message) }))),
      window.api.danbooruWiki(tag).then((r) => patch(seq, () => ({ wiki: r.ok ? ready(r.wiki) : errorOf(r.error.message) }))),
      (async () => {
        let r = await window.api.danbooruPosts({ tag, limit: TAG_POSTS_LIMIT, page: 1, order: 'score' })
        // order:score 被拒（例如匿名 tag 数限制）时退回不排序，至少有图
        if (!r.ok) r = await window.api.danbooruPosts({ tag, limit: TAG_POSTS_LIMIT, page: 1 })
        patch(seq, () => ({ tagPosts: r.ok ? ready(r.posts) : errorOf(r.error.message) }))
      })(),
    ])
  }

  async function loadArtist(tag: string, seq: number): Promise<void> {
    const [artistRes] = await Promise.all([
      window.api.danbooruArtist(tag).then((r) => {
        patch(seq, () => ({ artist: r.ok ? ready(r.artist) : errorOf(r.error.message) }))
        return r
      }),
      window.api.danbooruWiki(tag).then((r) => patch(seq, () => ({ wiki: r.ok ? ready(r.wiki) : errorOf(r.error.message) }))),
    ])
    if (seq !== requestSeq) return
    // 例图用画师条目给的规范名：用户输入可能是别名或带空格写法，拿去查 posts 会是 0 条
    const name = artistRes.ok && artistRes.artist ? artistRes.artist.name : tag
    const tagsRes = await window.api.danbooruTags({ nameMatches: name, limit: TAG_LOOKUP_LIMIT })
    if (seq !== requestSeq) return
    const want = normalizeTag(name)
    const postCount = tagsRes.ok ? (tagsRes.tags.find((t) => normalizeTag(t.name) === want)?.postCount ?? 0) : 0
    const { buckets, collapsed } = computePageBuckets(postCount, ARTIST_POSTS_PER_PAGE)
    patch(seq, () => ({
      artistPostCount: tagsRes.ok ? postCount : null,
      bucketsCollapsed: collapsed,
      buckets: buckets.map((b) => ({ kind: b.kind, page: b.page, posts: { status: 'loading' } })),
    }))
    await Promise.all(
      buckets.map(async (b) => {
        const r = await window.api.danbooruPosts({ tag: name, limit: ARTIST_POSTS_PER_PAGE, page: b.page })
        patch(seq, (e) => ({
          buckets: (e.buckets ?? []).map((cur) =>
            cur.kind === b.kind ? { ...cur, posts: r.ok ? ready(r.posts) : errorOf(r.error.message) } : cur,
          ),
        }))
      }),
    )
  }

  function showWith(rawTag: string, source: WikiSource, local: TagLookup | null | undefined): void {
    const tag = canonical(rawTag)
    if (tag === '') return
    requestSeq += 1
    const seq = requestSeq
    write(KEY_SOURCE, source)
    set({
      source,
      query: '',
      suggestions: [],
      suggestLoading: false,
      notice: null,
      entry: {
        tag,
        source,
        local: local === undefined ? { status: 'loading' } : ready(local),
        tagInfo: source === 'tag' ? { status: 'loading' } : ready(null),
        artist: source === 'artist' ? { status: 'loading' } : ready(null),
        wiki: { status: 'loading' },
        tagPosts: source === 'tag' ? { status: 'loading' } : ready([]),
        buckets: source === 'artist' ? null : [],
        artistPostCount: null,
        bucketsCollapsed: false,
      },
    })
    if (local === undefined) void safeLookup(tag).then((v) => patch(seq, () => ({ local: ready(v) })))
    void (source === 'tag' ? loadTag(tag, seq) : loadArtist(tag, seq))
  }

  return {
    collapsed: readFlag(KEY_COLLAPSED, false),
    followCursor: readFlag(KEY_FOLLOW, true),
    source: readSource(),
    query: '',
    suggestions: [],
    suggestLoading: false,
    entry: null,
    notice: null,

    toggleCollapsed: () => {
      const next = !get().collapsed
      write(KEY_COLLAPSED, next ? '1' : '0')
      if (next) {
        // 收起即停：待触发的光标查询作废，重新展开后下一次移动光标重新判定
        if (cursorTimer) clearTimeout(cursorTimer)
        cursorTimer = null
        lastCursorKey = null
      }
      set({ collapsed: next })
    },

    toggleFollowCursor: () => {
      const next = !get().followCursor
      write(KEY_FOLLOW, next ? '1' : '0')
      if (!next && cursorTimer) {
        clearTimeout(cursorTimer)
        cursorTimer = null
      }
      lastCursorKey = null
      set({ followCursor: next })
    },

    setSource: (source) => {
      write(KEY_SOURCE, source)
      const e = get().entry
      set({ source, suggestions: [] })
      if (e !== null && e.source !== source) showWith(e.tag, source, e.local.status === 'ready' ? e.local.value : undefined)
    },

    setQuery: (q) => {
      set({ query: q })
      if (searchTimer) clearTimeout(searchTimer)
      if (q.trim() === '') {
        set({ suggestions: [], suggestLoading: false })
        return
      }
      set({ suggestLoading: true })
      searchTimer = setTimeout(() => {
        searchTimer = null
        const source = get().source
        const task =
          source === 'tag'
            ? Promise.all([safeComplete(q, 'general'), safeComplete(q, 'character'), safeComplete(q, 'series')]).then((groups) =>
                mergeTagSuggestions(groups, SEARCH_LIMIT),
              )
            : Promise.all([
                safeComplete(q, 'artist'),
                window.api
                  .danbooruSearchArtistsByOtherName({ query: q, limit: SEARCH_LIMIT })
                  .then((r) => (r.ok ? r.items : []))
                  .catch(() => []),
                looksLikeLinkQuery(q)
                  ? window.api
                      .danbooruSearchArtistsByUrl({ query: q, limit: SEARCH_LIMIT })
                      .then((r) => (r.ok ? r.items : []))
                      .catch(() => [])
                  : Promise.resolve([]),
              ]).then(([local, alias, url]) => mergeArtistSuggestions(local, alias, url))
        void task.then((suggestions) => {
          // 结果回来时输入框可能已经变了：答非所问的下拉不落地
          if (get().query !== q) return
          set({ suggestions, suggestLoading: false })
        })
      }, SEARCH_DEBOUNCE_MS)
    },

    show: (tag, source) => {
      if (cursorTimer) clearTimeout(cursorTimer)
      cursorTimer = null
      showWith(tag, source, undefined)
    },

    onCursorWord: (word, preferArtist) => {
      const s = get()
      // 第二道保险：收起或跟随关闭时，WIKI 栏本就不订阅光标广播
      if (s.collapsed || !s.followCursor) return
      const cleaned = cleanCursorWord(word)
      if (cleaned === '') return
      const key = canonical(cleaned)
      if (key === lastCursorKey) return
      lastCursorKey = key
      if (cursorTimer) clearTimeout(cursorTimer)
      cursorTimer = setTimeout(() => {
        cursorTimer = null
        void safeLookup(key).then((local) => {
          if (lastCursorKey !== key) return
          const st = get()
          if (st.collapsed || !st.followCursor) return
          const isArtist = preferArtist || /^(artist:|@)/i.test(cleaned) || local?.category === 'artist'
          showWith(key, isArtist ? 'artist' : 'tag', local)
        })
      }, CURSOR_DEBOUNCE_MS)
    },

    setNotice: (text) => set({ notice: text }),
  }
})
