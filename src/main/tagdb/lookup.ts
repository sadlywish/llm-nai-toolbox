import type { CompletionPrefer } from '@shared/blockCompletion'
import type { TagLookup } from '@shared/ipc'
import type { TagEntry } from '@shared/tagdb/search'
import type { Category, TagdbCategories } from './loader'

/** 查找顺序：一般 → 角色 → 作品 → 画师。Danbooru 的 tag 名跨分类唯一，顺序只在本地数据异常重名时起作用，偏向标签源 */
const ORDER: ReadonlyArray<[keyof TagdbCategories, CompletionPrefer]> = [
  ['general', 'general'],
  ['characters', 'character'],
  ['series', 'series'],
  ['artists', 'artist'],
]

/** 每个分类按 tag 名建一次 Map，懒建、随分类对象回收 */
const byName = new WeakMap<Category, Map<string, TagEntry>>()

function mapOf(c: Category): Map<string, TagEntry> {
  let m = byName.get(c)
  if (!m) {
    m = new Map(c.entries.map((entry) => [entry.tag, entry]))
    byName.set(c, m)
  }
  return m
}

/** 用户写法 → 本地库的 tag 键：去 artist:/@ 前缀、小写、空白折成下划线 */
function keyOf(raw: string): string {
  return raw
    .trim()
    .replace(/^artist:/i, '')
    .replace(/^@/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
}

/** WIKI 栏词条头与画师/标签判定用：本地库里这个 tag 的分类、中文别名与帖子数；没收录返回 null */
export function lookupTag(cats: TagdbCategories, raw: string): TagLookup | null {
  const key = keyOf(raw)
  if (key === '') return null
  for (const [name, category] of ORDER) {
    const entry = mapOf(cats[name]).get(key)
    if (entry) {
      return { tag: entry.tag, category, zh: [...new Set([...entry.zh, ...entry.zhFull])], count: entry.count }
    }
  }
  return null
}
