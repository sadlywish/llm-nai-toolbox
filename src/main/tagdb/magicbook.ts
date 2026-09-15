import type { CompletionItem } from '@shared/ipc'
import type { MagicGroup, MagicItem, MagicSearch, TagGloss } from '@shared/magicbook'
import { MAGIC_SEARCH_LIMIT } from '@shared/magicbook'
import type { BrowseDb, BrowseItem } from './browse'
import { normalizeTagKey, type GlossDb } from './gloss'

/**
 * TAG 魔法书的数据层（规格 docs/superpowers/specs/2026-09-15-magicbook-design.md §3.1）。
 *
 * 数据就是 browse_tags 工具读的那份 tag_browse.json 与 tag_gloss.json，由 extras.ts 读盘缓存；
 * 本模块只收解析好的对象，不读文件、不 import electron，好在 node 环境单测。
 */

interface Indexed {
  /** 规范名 → 分类键 */
  catOf: Map<string, string>
  /** 每条的检索面：m（已小写）或回退的「t g」小写 */
  hay: Map<BrowseItem, string>
  /** 每条的标签名检索面：小写、下划线换空格 */
  name: Map<BrowseItem, string>
}

// 同一个 BrowseDb 只建一次索引；extras.ts 缓存进程终生，这里跟着它活
const indexCache = new WeakMap<BrowseDb, Indexed>()

function indexOf(db: BrowseDb): Indexed {
  let idx = indexCache.get(db)
  if (idx !== undefined) return idx
  idx = { catOf: new Map(), hay: new Map(), name: new Map() }
  for (const [cat, items] of db.cats) {
    for (const it of items) {
      idx.catOf.set(normalizeTagKey(it.t), cat)
      // m 是构建期拼好的小写检索面；老数据没有就退回标签名 + 释义（与 browseCategory 一致）
      idx.hay.set(it, it.m ?? `${it.t} ${it.g}`.toLowerCase())
      idx.name.set(it, it.t.toLowerCase().replace(/_/g, ' '))
    }
  }
  indexCache.set(db, idx)
  return idx
}

function toItem(it: BrowseItem, cat: string, gloss: GlossDb | null): MagicItem {
  const e = gloss?.get(normalizeTagKey(it.t))
  return { t: it.t, g: it.g, c: it.c, cat, trap: e?.trap !== undefined, vs: e?.vs !== undefined }
}

export function buildTree(db: BrowseDb): { groups: MagicGroup[]; total: number } {
  const groups: MagicGroup[] = []
  let total = 0
  for (const [cat, items] of db.cats) {
    const slash = cat.indexOf('/')
    const top = slash < 0 ? cat : cat.slice(0, slash)
    const sub = slash < 0 ? cat : cat.slice(slash + 1)
    let g = groups.find((x) => x.top === top)
    if (g === undefined) {
      g = { top, n: 0, subs: [] }
      groups.push(g)
    }
    g.subs.push({ cat, sub, n: items.length })
    g.n += items.length
    total += items.length
  }
  // 二级按条数降序，与系统提示词里的目录（formatToc）一致
  for (const g of groups) g.subs.sort((a, b) => b.n - a.n)
  return { groups, total }
}

export function listCategory(db: BrowseDb, gloss: GlossDb | null, cat: string): MagicItem[] | null {
  const items = db.cats.get(cat)
  if (items === undefined) return null
  return items.map((it) => toItem(it, cat, gloss)).sort((a, b) => b.c - a.c)
}

/**
 * 检索。total 与 byCat 始终按全部命中计（树上的命中数要稳定）；
 * 传了 cat 时 items 只留这一类的命中再截断——否则被 500 条截掉的那部分在点分类时就看不到了。
 */
export function searchMagic(db: BrowseDb, gloss: GlossDb | null, query: string, limit = MAGIC_SEARCH_LIMIT, cat?: string): MagicSearch {
  const terms = query.trim().toLowerCase().split(/\s+/).filter((t) => t !== '')
  if (terms.length === 0) return { total: 0, byCat: {}, items: [] }
  const idx = indexOf(db)
  const nameTerms = terms.map((t) => t.replace(/_/g, ' '))
  const hits: { item: MagicItem; tier: number }[] = []
  const byCat: Record<string, number> = {}
  for (const [cat, items] of db.cats) {
    for (const it of items) {
      const hay = idx.hay.get(it)!
      if (!terms.every((t) => hay.includes(t))) continue
      const name = idx.name.get(it)!
      const g = it.g.toLowerCase()
      // 档 0：词都在标签名里；档 1：词都在释义里；档 2：只在别名或 wiki 正文里
      const tier = nameTerms.every((t) => name.includes(t)) ? 0 : terms.every((t) => g.includes(t)) ? 1 : 2
      hits.push({ item: toItem(it, cat, gloss), tier })
      byCat[cat] = (byCat[cat] ?? 0) + 1
    }
  }
  hits.sort((a, b) => a.tier - b.tier || b.item.c - a.item.c)
  const shown = cat === undefined ? hits : hits.filter((h) => h.item.cat === cat)
  return { total: hits.length, byCat, items: shown.slice(0, limit).map((h) => h.item) }
}

export function glossOf(gloss: GlossDb | null, db: BrowseDb | null, tag: string): TagGloss | null {
  if (gloss === null) return null
  const key = normalizeTagKey(tag)
  const e = gloss.get(key)
  if (e === undefined) return null
  const out: TagGloss = { g: e.g }
  if (e.trap !== undefined) out.trap = e.trap
  if (e.vs !== undefined) out.vs = e.vs
  const cat = db === null ? undefined : indexOf(db).catOf.get(key)
  if (cat !== undefined) out.cat = cat
  return out
}

const CJK = /[㐀-鿿]/

export function hasCjk(s: string): boolean {
  return CJK.test(s)
}

/**
 * 补全与 WIKI 联想的「释义」补充：只在查询含中文时、只看释义文字。
 *
 * 不用 m 检索面：m 里有英文 wiki 正文，打英文时会把一大片无关标签刷进来；
 * 名字与中文别名的匹配本来就由本地索引（complete.ts）负责，这里只补它够不着的「释义里的说法」。
 */
export function glossSupplement(db: BrowseDb, query: string, exclude: ReadonlySet<string>, max: number): MagicItem[] {
  const q = query.trim().toLowerCase()
  if (max <= 0 || q === '' || !hasCjk(q)) return []
  const out: MagicItem[] = []
  for (const [cat, items] of db.cats) {
    for (const it of items) {
      if (exclude.has(it.t) || !it.g.toLowerCase().includes(q)) continue
      out.push({ t: it.t, g: it.g, c: it.c, cat, trap: false, vs: false })
    }
  }
  return out.sort((a, b) => b.c - a.c).slice(0, max)
}

export function withGloss(
  items: CompletionItem[],
  gloss: GlossDb | null,
  browse: BrowseDb | null,
  query: string,
  glossMax: number,
  limit?: number,
): CompletionItem[] {
  const out: CompletionItem[] = items.map((it) => {
    const g = gloss?.get(normalizeTagKey(it.tag))?.g
    return g === undefined ? it : { ...it, gloss: g }
  })
  const room = limit === undefined ? glossMax : Math.min(glossMax, Math.max(0, limit - out.length))
  if (room <= 0 || browse === null) return out
  const have = new Set(out.map((it) => it.tag))
  for (const s of glossSupplement(browse, query, have, room)) {
    out.push({ tag: s.t, count: s.c, zh: [], series: [], gloss: s.g, byGloss: true })
  }
  return out
}
