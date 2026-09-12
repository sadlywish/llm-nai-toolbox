import type { FieldSpec } from './fields'

/**
 * 段分隔符。用 U+001F（UNIT SEPARATOR）——它是控制字符，
 * 提示词里不可能出现，也不会被任何输入法打出来。
 *
 * 文档形状：分隔符 + 第 0 段 + 分隔符 + 第 1 段 + …
 * **每段前面各一个**，不是段与段之间。这样第 0 段也有自己的分隔符可以
 * 挂徽章，十个段十个徽章，不必给首段开特例。
 */
export const BLOCK_SEP = '\u001F'

export type FieldValues = Record<string, string>

/** 剥掉分隔符。任何要写进文档的外来文本都得先过这一道 */
export function stripSeparators(text: string): string {
  return text.split(BLOCK_SEP).join('')
}

export function emptyValues(specs: readonly FieldSpec[]): FieldValues {
  const out: FieldValues = {}
  for (const spec of specs) out[spec.name] = ''
  return out
}

export function serializeFields(
  values: FieldValues,
  specs: readonly FieldSpec[],
): string {
  return specs
    .map((spec) => BLOCK_SEP + stripSeparators(values[spec.name] ?? ''))
    .join('')
}

export function isWellFormed(doc: string, specs: readonly FieldSpec[]): boolean {
  const parts = doc.split(BLOCK_SEP)
  return parts.length === specs.length + 1 && parts[0] === ''
}

/**
 * 抛错而不是静默修补：段结构由 transaction filter 守着，走到这里还不对
 * 就是 filter 漏了，属于要当场看见的 bug。静默补齐会让真正的破绽一直藏着。
 */
export function parseDocument(
  doc: string,
  specs: readonly FieldSpec[],
): FieldValues {
  if (!isWellFormed(doc, specs)) {
    const got = doc.split(BLOCK_SEP).length - 1
    throw new Error(`分块文档结构损坏：期望 ${specs.length} 段，实际 ${got} 段`)
  }
  const parts = doc.split(BLOCK_SEP)
  const out: FieldValues = {}
  specs.forEach((spec, i) => {
    out[spec.name] = parts[i + 1]
  })
  return out
}

export interface BlockRange {
  index: number
  name: string
  /** 该段前面那个分隔符的下标 */
  sepAt: number
  /** 内容起点（分隔符之后） */
  from: number
  /** 内容终点（不含）。空段时等于 from */
  to: number
}

export function blockRanges(
  doc: string,
  specs: readonly FieldSpec[],
): BlockRange[] {
  const values = parseDocument(doc, specs)
  const out: BlockRange[] = []
  let pos = 0
  specs.forEach((spec, index) => {
    const sepAt = pos
    const from = sepAt + 1
    const to = from + values[spec.name].length
    out.push({ index, name: spec.name, sepAt, from, to })
    pos = to
  })
  return out
}
