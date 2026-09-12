/**
 * 找出全角逗号与顿号的位置。
 *
 * **只用于 input 为 'tags' 的字段**。标签串里 `，` 与 `、` 都不是分隔符——
 * NAI 会把它们当普通文字，于是 `artist:a，artist:b` 被读成一个无意义的长
 * 短语而不是两个画师。不报错、不崩溃，只是出来的图跟预期不一样。
 *
 * nltags 字段不做这个提示：那里写的是自然语言中文描述，句子里的中文逗号
 * 完全合法，标红只会变成满屏噪音。哪些字段要标由 FieldSpec.flagFullWidthComma
 * 决定，不在这个函数里判断。
 */
export interface CommaHit {
  from: number
  to: number
  char: string
}

/** 全角逗号 U+FF0C 与顿号 U+3001。中文输入法下这两个都极易误打出来 */
const FULL_WIDTH_COMMAS = new Set(['，', '、'])

export function findFullWidthCommas(text: string): CommaHit[] {
  const out: CommaHit[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (FULL_WIDTH_COMMAS.has(ch)) out.push({ from: i, to: i + 1, char: ch })
  }
  return out
}

export function fullWidthCommaMessage(char: string): string {
  return `「${char}」不是分隔符，NAI 会把它当普通文字，前后两个 TAG 会被粘成一个。改成半角逗号 ,`
}
