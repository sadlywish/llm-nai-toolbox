import { create } from 'zustand'
import { normalizeTag } from '@shared/danbooru'
import type { MagicGroup, MagicItem, MagicSearch } from '@shared/magicbook'
import { formatWikiTag } from '../prompt/insertTag'
import { errorLoad, loadTagEntry, readyLoad, tagEntryInit, type Load, type WikiEntry } from './wikiEntryLoad'

/**
 * TAG 魔法书的浏览状态（规格 docs/superpowers/specs/2026-09-15-magicbook-design.md §4.2）。
 * 放 store 而不是组件：切到别的标签组件会卸载，回来时折叠、分类、检索词、选中项都要还在（仅本次运行）。
 */

export const MAGIC_SEARCH_DEBOUNCE_MS = 250
export const COPIED_MS = 1500

export interface MagicTree {
  groups: MagicGroup[]
  total: number
}

interface MagicState {
  /** null = 还没初始化 */
  tree: Load<MagicTree> | null
  expanded: string[]
  /** 浏览时打开的分类；检索时 null 表示「全部命中」 */
  activeCat: string | null
  list: Load<MagicItem[]> | null
  query: string
  /** null = 不在检索 */
  search: Load<MagicSearch> | null
  /** 开始检索前打开的分类，清空检索时回去 */
  prevCat: string | null
  selected: string | null
  entry: WikiEntry | null
  /** 刚复制的标签：按钮短暂显示「已复制」 */
  copied: string | null
  init: () => void
  toggleGroup: (top: string) => void
  openCat: (cat: string | null) => void
  setQuery: (q: string) => void
  select: (tag: string) => void
  locate: (tag: string) => void
  copy: (tag: string) => void
}

// 防抖与请求代次放模块级，不进 store：它们不是要渲染的状态
let searchTimer: ReturnType<typeof setTimeout> | null = null
let copiedTimer: ReturnType<typeof setTimeout> | null = null
let listSeq = 0
let searchSeq = 0
let entrySeq = 0

/** 规范名：空白折下划线、小写（与 tag_browse.json 的 t 一致） */
const canonical = (tag: string): string => normalizeTag(tag.trim()).toLowerCase()
const topOf = (cat: string): string => cat.split('/')[0]

export const useMagicBook = create<MagicState>((set, get) => {
  function loadList(cat: string): void {
    listSeq += 1
    const seq = listSeq
    set({ list: { status: 'loading' } })
    window.api.magicbookList(cat).then(
      (r) => {
        if (seq === listSeq) set({ list: r.ok ? readyLoad(r.items) : errorLoad(r.detail) })
      },
      (e: unknown) => {
        if (seq === listSeq) set({ list: errorLoad(String(e)) })
      },
    )
  }

  /**
   * showLoading：换了检索词时先显示载入中；只是在检索里切分类时不清旧结果，
   * 否则树上的命中数会闪一下没掉。
   */
  function runSearch(raw: string, cat: string | null, showLoading: boolean): void {
    searchSeq += 1
    const seq = searchSeq
    if (showLoading) set({ search: { status: 'loading' } })
    window.api.magicbookSearch(raw.trim(), cat ?? undefined).then(
      (r) => {
        // 结果回来时检索词可能已经变了：答非所问的结果不落地
        if (seq !== searchSeq || get().query !== raw) return
        set({ search: r.ok ? readyLoad(r.result) : errorLoad(r.detail) })
      },
      (e: unknown) => {
        if (seq === searchSeq) set({ search: errorLoad(String(e)) })
      },
    )
  }

  /** 退出检索：丢掉在途请求，回到检索前打开的分类 */
  function leaveSearch(): void {
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = null
    searchSeq += 1
    const back = get().prevCat
    set({ query: '', search: null, prevCat: null, activeCat: back })
    if (back !== null) loadList(back)
  }

  return {
    tree: null,
    expanded: [],
    activeCat: null,
    list: null,
    query: '',
    search: null,
    prevCat: null,
    selected: null,
    entry: null,
    copied: null,

    init: () => {
      if (get().tree !== null) return
      set({ tree: { status: 'loading' } })
      window.api.magicbookTree().then(
        (r) => {
          if (!r.ok) {
            set({ tree: errorLoad(r.detail) })
            return
          }
          set({ tree: readyLoad({ groups: r.groups, total: r.total }) })
          const first = r.groups[0]
          // 第一次打开：展开第一组、打开它条数最多的一类（subs 已按条数降序）
          if (first !== undefined && get().activeCat === null && get().search === null) {
            set({ expanded: [first.top] })
            if (first.subs[0] !== undefined) get().openCat(first.subs[0].cat)
          }
        },
        (e: unknown) => set({ tree: errorLoad(String(e)) }),
      )
    },

    toggleGroup: (top) =>
      set((s) => ({ expanded: s.expanded.includes(top) ? s.expanded.filter((t) => t !== top) : [...s.expanded, top] })),

    openCat: (cat) => {
      const s = get()
      if (s.search !== null) {
        set({ activeCat: cat })
        runSearch(s.query, cat, false)
        return
      }
      if (cat === null) return
      set({ activeCat: cat })
      loadList(cat)
    },

    setQuery: (q) => {
      if (q.trim() === '') {
        if (get().search !== null) leaveSearch()
        else set({ query: q })
        return
      }
      const s = get()
      if (s.search === null) set({ query: q, prevCat: s.activeCat, activeCat: null, search: { status: 'loading' } })
      else set({ query: q, activeCat: null })
      if (searchTimer) clearTimeout(searchTimer)
      searchTimer = setTimeout(() => {
        searchTimer = null
        runSearch(q, null, true)
      }, MAGIC_SEARCH_DEBOUNCE_MS)
    },

    select: (raw) => {
      const tag = canonical(raw)
      if (tag === '') return
      entrySeq += 1
      const seq = entrySeq
      set({ selected: tag, entry: tagEntryInit(tag, undefined) })
      const patch = (fn: (e: WikiEntry) => Partial<WikiEntry>): void => {
        const e = get().entry
        if (seq !== entrySeq || e === null) return
        set({ entry: { ...e, ...fn(e) } })
      }
      window.api
        .tagdbLookup(tag)
        .catch(() => null)
        .then((v) => patch(() => ({ local: readyLoad(v) })))
      void loadTagEntry(tag, patch)
    },

    locate: (raw) => {
      const tag = canonical(raw)
      if (tag === '') return
      if (get().search !== null) leaveSearch()
      get().select(tag)
      window.api
        .tagdbGloss(tag)
        .catch(() => null)
        .then((g) => {
          // 期间又选了别的：不再跳分类
          if (get().selected !== tag || g === null || g.cat === undefined) return
          const cat = g.cat
          set((s) => ({ expanded: s.expanded.includes(topOf(cat)) ? s.expanded : [...s.expanded, topOf(cat)], activeCat: cat }))
          loadList(cat)
        })
    },

    copy: (tag) => {
      void window.api.writeClipboardText(formatWikiTag(tag, false)).then(() => {
        if (copiedTimer) clearTimeout(copiedTimer)
        set({ copied: tag })
        copiedTimer = setTimeout(() => {
          copiedTimer = null
          if (get().copied === tag) set({ copied: null })
        }, COPIED_MS)
      })
    },
  }
})
