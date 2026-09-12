import { findArtistSpans } from '@renderer/prompt/tokenize'
import { unitRangeAt } from '@renderer/prompt/weight'
import { blockRanges } from './blockDoc'
import { fieldIndexAt } from './blockNav'
import type { CompletionKind, FieldSpec } from './fields'

/**
 * 补全时优先搜哪一类标签。
 *
 * 这是 `fields.ts` 的 `CompletionKind` 的别名，不是新枚举 —— 字段的取值域只有
 * 一个事实来源。这里另起一个名字，是因为在补全这一侧它的语义是「偏好哪一类」，
 * 而在 `FieldSpec` 那一侧它的语义是「这个字段补什么」。
 */
export type CompletionPrefer = CompletionKind

export interface CompletionTarget {
  /** 要被替换的文档区间起点 */
  from: number
  to: number
  /** 送去检索的查询词 */
  query: string
  prefer: CompletionPrefer
}

/**
 * 算出光标处该补全哪个词、偏好哪一类。
 *
 * ⚠️ 分词函数只能吃**段内文本**。把整篇文档喂给 `findArtistSpans` /
 * `unitRangeAt`，分隔符会被当成普通字符，词边界全错。所以这里先取段、
 * 切片、在段内算，再把区间加回段起点 —— 与 blockWeight.ts 同一套做法。
 *
 * 返回 null 表示此处不该补全：字段的 `completion` 为 null（`nltags` 是
 * 自然语言、角色的 `count` 是枚举），或者光标处压根没有词（包括位置 0——
 * 那里不属于任何段，见 blockDoc.ts 的「位置的几何」）。
 */
export function completionTargetAt(
  doc: string,
  specs: readonly FieldSpec[],
  pos: number,
): CompletionTarget | null {
  const idx = fieldIndexAt(doc, pos)
  const range = blockRanges(doc, specs)[idx]
  const spec = specs[idx]
  if (range === undefined || spec === undefined) return null
  if (spec.completion === null) return null
  if (pos < range.from || pos > range.to) return null

  const text = doc.slice(range.from, range.to)
  const local = pos - range.from

  // 画师前缀词优先：只替换前缀之后的名字，前缀本身留着。
  // 这一支也覆盖「在非 artist 字段里写 @wlop」的情形 —— 写了前缀就是要画师。
  const artistHit = findArtistSpans(text).find((s) => local >= s.start && local <= s.end)
  if (artistHit) {
    if (artistHit.name.length === 0) return null
    const from = artistHit.end - artistHit.name.length
    return {
      from: range.from + from,
      to: range.from + artistHit.end,
      query: artistHit.name,
      prefer: 'artist',
    }
  }

  const unit = unitRangeAt(text, local)
  const query = text.slice(unit.start, unit.end)
  if (query.trim().length === 0) return null

  return {
    from: range.from + unit.start,
    to: range.from + unit.end,
    query,
    prefer: spec.completion,
  }
}
