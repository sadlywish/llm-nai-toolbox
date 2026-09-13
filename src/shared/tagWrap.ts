/**
 * 标签级折行的切分。
 *
 * tags 形态的字段里，「一个标签连同紧跟它的逗号」是一个不可拆的单位，只在逗号之后折行
 * —— `very long hair` 不会被拆成行尾的 `very` 与下一行的 `long hair`。
 * 渲染端据此给每个单位包一层 `white-space: nowrap`（见 editor/blockExtension.ts）。
 *
 * 只认半角逗号：全角逗号与顿号在 NAI 眼里是普通文字（见 prompt/fullWidthComma.ts），
 * 不是分隔，把它们当边界会让一个错误写法看起来像两个标签。
 */
export interface TagSpan {
  /** 段内坐标，[from, to)。from 是标签首字，to 在它后面那串逗号之后 */
  from: number
  to: number
  /** 显示宽度，以一个半角字符为 1。CJK 等宽字符按 2 计 */
  units: number
  /**
   * 逗号后面紧跟着非空白字符（`1girl,solo`）。这里按 Unicode 断行规则没有折行机会，
   * 渲染端要补一个。逗号后跟空格时为 false —— 空格之后本来就能折，再补一个会在空格
   * **之前**多出折点，把空格带到行首。
   */
  needsBreak: boolean
}

/** CJK 等宽字符的码位范围（谚文字母、CJK 符号到彝文、谚文音节、兼容表意、竖排与全角形式） */
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/

/**
 * 按等宽字体估的显示宽度。宁可高估：高估只会让一个长标签提前退回「允许在内部断开」，
 * 低估则会让它撑出横向滚动条。
 */
export function displayUnits(text: string): number {
  let units = 0
  for (const ch of text) units += WIDE.test(ch) ? 2 : 1
  return units
}

export function tagSpans(text: string): TagSpan[] {
  const out: TagSpan[] = []
  const re = /[^,]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const body = m[0].trim()
    // 两个逗号之间只有空白：不是标签，它的逗号已经并进前一个单位
    if (body === '') continue
    const from = m.index + (m[0].length - m[0].trimStart().length)
    // 连同后面的逗号一起，含 `tag ,` 与 `tag, ,` 这类连着的逗号
    const commas = /^(\s*,)+/.exec(text.slice(from + body.length))
    const to = from + body.length + (commas === null ? 0 : commas[0].length)
    out.push({
      from,
      to,
      units: displayUnits(text.slice(from, to)),
      needsBreak: commas !== null && to < text.length && !/\s/.test(text[to]),
    })
  }
  return out
}
