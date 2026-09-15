import { normalizeTag, type DanbooruArtistSearchItem } from '@shared/danbooru'
import type { CompletionItem } from '@shared/ipc'

/**
 * WIKI 栏搜索框的联想（规格 R4）：标签源只查本地库；画师源 = 本地库画师 + D 站别名 + D 站主页链接三路合并。
 * looksLikeLinkQuery 移植自画师串工具箱 danbooru/artistSearch.ts：链接那一路只在查询词像链接时才发。
 */
export function looksLikeLinkQuery(query: string): boolean {
  const q = query.trim()
  if (q === '') return false
  if (q.includes('://')) return true
  if (q.startsWith('www.')) return true
  return q.includes('.') && q.includes('/')
}

export type ArtistMatchDimension = 'name' | 'alias' | 'url'

export interface WikiSuggestion {
  /** 选中后查询用的规范名（下划线） */
  tag: string
  /** 展示用：下划线换空格 */
  label: string
  zh: string[]
  /** 帖子数；只有本地库给得出，D 站检索那两路没有 */
  count: number | null
  /** 画师源才有：命中的是名称/别名/链接；标签源恒为空 */
  matchedBy: ArtistMatchDimension[]
  /** 工具附带的中文释义；只有释义补充行带（显示在标签名后面） */
  gloss?: string
  /** 按中文释义补充进来的行，行尾标「释义」 */
  byGloss?: boolean
}

const keyOf = (tag: string): string => normalizeTag(tag).toLowerCase()
const labelOf = (tag: string): string => tag.replace(/_/g, ' ')

export function mergeArtistSuggestions(
  local: CompletionItem[],
  alias: DanbooruArtistSearchItem[],
  url: DanbooruArtistSearchItem[],
): WikiSuggestion[] {
  const byKey = new Map<string, WikiSuggestion>()
  const upsert = (tag: string, zh: string[], count: number | null, dim: ArtistMatchDimension): void => {
    const key = keyOf(tag)
    const existing = byKey.get(key)
    if (existing) {
      if (!existing.matchedBy.includes(dim)) existing.matchedBy.push(dim)
      return
    }
    byKey.set(key, { tag: normalizeTag(tag), label: labelOf(normalizeTag(tag)), zh, count, matchedBy: [dim] })
  }
  // 本地名字先入榜：秒出、带中文别名，本来就该排在前面
  for (const it of local) upsert(it.tag, it.zh, it.count, 'name')
  for (const it of alias) upsert(it.name, [], null, 'alias')
  for (const it of url) upsert(it.name, [], null, 'url')
  return [...byKey.values()]
}

export function mergeTagSuggestions(groups: CompletionItem[][], limit: number): WikiSuggestion[] {
  const byKey = new Map<string, CompletionItem>()
  const glossRows: CompletionItem[] = []
  for (const group of groups) {
    for (const it of group) {
      if (it.byGloss) {
        glossRows.push(it)
        continue
      }
      const key = keyOf(it.tag)
      if (!byKey.has(key)) byKey.set(key, it)
    }
  }
  const out: WikiSuggestion[] = [...byKey.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((it) => ({ tag: it.tag, label: labelOf(it.tag), zh: it.zh, count: it.count, matchedBy: [] }))
  // 释义行只补剩余名额：它们是名字与别名都没命中时的兜底，不该挤掉本地结果
  const seen = new Set(out.map((s) => keyOf(s.tag)))
  for (const it of glossRows) {
    if (out.length >= limit) break
    const key = keyOf(it.tag)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ tag: it.tag, label: labelOf(it.tag), zh: [], count: it.count, matchedBy: [], gloss: it.gloss, byGloss: true })
  }
  return out
}
