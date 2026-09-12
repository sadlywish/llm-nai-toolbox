import { blockRanges } from './blockDoc'
import { blockCommaHits } from './blockMetrics'
import { fieldIndexAt } from './blockNav'
import type { FieldSpec } from './fields'

export type DecoKind =
  /** 分隔符位置的字段徽章，替换成一个 widget */
  | 'badge'
  /** 段内容底色与描边 */
  | 'block'
  /** 空段的淡色变体，与 block 叠加 */
  | 'blank'
  /** 光标所在段的提亮，与 block 叠加 */
  | 'active'
  /** 全角逗号标红 */
  | 'comma'

export interface DecoSpec {
  from: number
  to: number
  kind: DecoKind
  field: string
  hue: number
  /** 徽章文字。非 badge 项与 field 相同，调试时好认 */
  label: string
}

/**
 * 算出该画哪些装饰。
 *
 * 返回**按 from 升序**的普通对象数组，不碰 CodeMirror——CodeMirror 的
 * Decoration 得在浏览器环境构造，掺进来这段就没法在 node 里测了。
 * 调用方负责把 kind 映射成具体的 Decoration。
 */
export function buildBlockDecorations(
  doc: string,
  specs: readonly FieldSpec[],
  cursor: number,
): DecoSpec[] {
  const activeIndex = fieldIndexAt(doc, cursor)
  const out: DecoSpec[] = []

  for (const range of blockRanges(doc, specs)) {
    const spec = specs[range.index]
    const base = { field: spec.name, hue: spec.hue, label: spec.label }

    out.push({ from: range.sepAt, to: range.sepAt + 1, kind: 'badge', ...base })
    out.push({ from: range.from, to: range.to, kind: 'block', ...base })
    if (range.from === range.to) {
      out.push({ from: range.from, to: range.to, kind: 'blank', ...base })
    }
    if (range.index === activeIndex) {
      out.push({ from: range.from, to: range.to, kind: 'active', ...base })
    }
  }

  for (const hit of blockCommaHits(doc, specs)) {
    const spec = specs.find((s) => s.name === hit.field)
    out.push({
      from: hit.from,
      to: hit.to,
      kind: 'comma',
      field: hit.field,
      hue: spec ? spec.hue : 0,
      label: hit.char,
    })
  }

  // CodeMirror 的 RangeSetBuilder 要求按 from 升序喂入，乱序会当场抛错。
  // 稳定排序：同一 from 上 badge/block/blank/active 的先后由 push 顺序保证。
  out.sort((a, b) => a.from - b.from)
  return out
}
