import { blockRanges } from './blockDoc'
import { blockCommaHits, blockDigitHits, type DocCommaHit, type DocDigitHit } from './blockMetrics'
import { fieldIndexAt } from './blockNav'
import type { FieldSpec } from './fields'
import { joinsPrompt } from './prompt'
import { tagSpans, type TagSpan } from './tagWrap'

/** 分块编辑器里一段的版面 */
export interface FieldLayout {
  index: number
  field: string
  label: string
  hue: number
  /** 该段前面那个分隔符的下标。空段的整块画在它上面 */
  sepAt: number
  /** 内容范围 [from, to) */
  from: number
  to: number
  empty: boolean
  /** 光标在这一段 */
  active: boolean
  /** 会进拼接结果：块后面要画不可编辑的 ` ,`。判据与 buildPrompt 共用 */
  joined: boolean
  /** 标签级折行单位，**文档坐标**。只有 tags 形态的非空段才有 */
  tags: TagSpan[]
}

export interface BlockLayout {
  fields: FieldLayout[]
  /** 全角逗号命中，文档坐标 */
  commaHits: DocCommaHit[]
  /** 标签末尾数字紧贴 :: 的命中，文档坐标 */
  digitHits: DocDigitHit[]
}

/**
 * 算出分块编辑器每段画成什么样。
 *
 * 返回普通对象，不碰 CodeMirror —— Decoration 得在浏览器环境构造，
 * 掺进来这段就没法在 node 里测了。怎么映射成 Decoration 见 editor/blockExtension.ts。
 * 只有「哪些标签比一整行还宽」取决于实际宽度，留给渲染端判断。
 */
export function buildBlockLayout(
  doc: string,
  specs: readonly FieldSpec[],
  cursor: number,
): BlockLayout {
  const activeIndex = fieldIndexAt(doc, cursor)
  const fields = blockRanges(doc, specs).map((range): FieldLayout => {
    const spec = specs[range.index]
    const value = doc.slice(range.from, range.to)
    return {
      index: range.index,
      field: spec.name,
      label: spec.label,
      hue: spec.hue,
      sepAt: range.sepAt,
      from: range.from,
      to: range.to,
      empty: range.from === range.to,
      active: range.index === activeIndex,
      joined: joinsPrompt(value),
      tags:
        spec.input === 'tags'
          ? tagSpans(value).map((t) => ({ ...t, from: range.from + t.from, to: range.from + t.to }))
          : [],
    }
  })
  return { fields, commaHits: blockCommaHits(doc, specs), digitHits: blockDigitHits(doc, specs) }
}
