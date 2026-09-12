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

/**
 * 段内文本的净化：分隔符与换行都不许出现在字段值里。
 *
 * 换行和分隔符同罪 —— 分块文档必须是**单行**，所有按字符位置算的逻辑都靠这条
 * （见下面「位置的几何」）。`isWellFormed` 只数分隔符、看不见换行，所以拦截
 * 必须在写入前做，而不是事后校验。`stripSeparators` 单独保留、契约不变——
 * 这只是它多出来的一个兄弟，服务需要连换行一起挡的调用点（`serializeFields`
 * 与渲染端 `guardFilter` 的粘贴/换行剥离分支）。
 */
export function sanitizeFieldText(s: string): string {
  return stripSeparators(s).replace(/[\r\n]/g, '')
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
    .map((spec) => BLOCK_SEP + sanitizeFieldText(values[spec.name] ?? ''))
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

/**
 * ── 位置的几何 ────────────────────────────────────────────
 * 各段的闭区间 [from_i, to_i] 互不相交且首尾相接，铺满 1..doc.length：
 *   from_{i+1} === to_i + 1，中间隔着分隔符那一格；
 *   因此 sepAt_{i+1} === to_i —— **同一个位置既是第 i 段内容的末尾，
 *   也是第 i+1 段的分隔符位**。
 * 1..doc.length 的每个位置都唯一属于某一段。
 * **唯一不属于任何段的是位置 0**（它在第 0 段的徽章之前）。
 *
 * 这条事实被 clampToBlock（blockNav.ts）与 guardFilter（editor/blockExtension.ts）
 * 共同依赖。两处都曾因误读它而出过 Critical：前者把「段末尾」当成「分隔符上」
 * 推走了合法落点，后者漏掉了「起点为 0 的插入」。改动任何一处之前先读这段。
 */
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
