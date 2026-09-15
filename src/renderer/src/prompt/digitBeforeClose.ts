import { isDelimiter, matchNumberBefore } from './tokenize'

/**
 * 找出「标签末尾的数字紧贴 `::`」的位置（照画师串工具箱 tokenize.ts 的 digit-before-close）。
 *
 * NAI 把紧贴 `::` 的数字读成新加权段的起始，`1.2::artist:as109::` 里的 `109::`
 * 会开一个权重 109 的段，后面整段权重跟着错位。不报错，只是出来的图不对。
 *
 * 两种写法都算：
 *   · 数字前一个字符不是分隔符：`as109::`、`void_0::`（工具箱原有的规则）
 *   · 数字前是空格，空格再往前是标签文字：`year 2024::`。工具箱把空格后的数字一律
 *     当作正常权重，这里按用户要求（2026-09-15）也报。空格往前是分隔符或字段开头
 *     的仍是正常权重：`1girl, 1.2::smile::`、`{ 1.2::x::}`
 *
 * 所有文字字段都查：这个写法在自然语言里同样会被误读，不像全角逗号只对标签串有意义。
 * 只提示，不改写。
 */
export interface DigitHit {
  /** 数字的 [from, to)，不含后面的 `::` */
  from: number
  to: number
  message: string
}

export function findDigitBeforeClose(text: string): DigitHit[] {
  const out: DigitHit[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] !== ':' || text[i + 1] !== ':') {
      i++
      continue
    }
    const num = matchNumberBefore(text, i)
    if (num !== null && endsTag(text, num.start)) {
      const literal = text.slice(num.start, i)
      out.push({
        from: num.start,
        to: i,
        message: `「${literal}::」会被识别为新加权段的起始。若这是标签末尾的数字，请在数字与 :: 之间加一个空格。`,
      })
    }
    // 与 parsePrompt 同样整对跳过，`::::` 按两个 `::` 算
    i += 2
  }
  return out
}

/** 从 start 开始的数字是不是接在标签文字后面 */
function endsTag(text: string, start: number): boolean {
  const prev = text[start - 1]
  if (!isDelimiter(prev)) return true
  if (prev !== ' ' && prev !== '\t') return false
  let j = start - 1
  while (j > 0 && (text[j - 1] === ' ' || text[j - 1] === '\t')) j--
  return j > 0 && !isDelimiter(text[j - 1])
}
