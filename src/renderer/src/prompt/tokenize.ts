/**
 * NAI 提示词的权重语法解析。
 *
 * 语法：`<数字>::<内容>::`，可嵌套。「数字」必须紧贴 `::`（中间无空格），
 * 且其前一个字符必须是分隔符——这条「前面是分隔符」的约束是整个解析的关键：
 * 它把「独立的权重数字」和「标签末尾的数字」区分开。
 *
 *   1.2::x::      → 1.2 前面是字符串开头  → 开启加权段
 *   1.2::as109::  → 109 前面是字母 s      → 不开新段，视为闭合（并在 Task 6 报错）
 *
 * 没有这条约束的话，`1.2::as109::` 会被解析成「外层未闭合 + 内层未闭合」的一团乱麻，
 * 高亮和 Ctrl+↑↓ 全都会跟着错位。
 */

/** 一个权重段 `<数字>::<内容>::` */
export interface WeightSpan {
  /** 段起始（数字的第一个字符） */
  start: number
  /** 段结束（闭合 `::` 之后）；未闭合时为文本长度 */
  end: number
  /** 嵌套深度，最外层为 0 */
  depth: number
  /** 权重数值 */
  weight: number
  /** 数字文本的 [numStart, numEnd)；numEnd 即开启 `::` 的下标 */
  numStart: number
  numEnd: number
  /** 内容的 [contentStart, contentEnd)；未闭合时 contentEnd 为文本长度 */
  contentStart: number
  contentEnd: number
  /** 闭合 `::` 的起始下标；未闭合为 null */
  closeStart: number | null
  closed: boolean
}

export type DiagnosticCode = 'unclosed' | 'digit-before-close' | 'stray-close'

export interface PromptDiagnostic {
  from: number
  to: number
  severity: 'error' | 'warning'
  code: DiagnosticCode
  message: string
}

/** 提示词里的画师词，例如 `artist:wlop` 或 `@wlop` */
export interface ArtistSpan {
  /** 含前缀在内的 [start, end) */
  start: number
  end: number
  /** 去掉前缀后的画师名 */
  name: string
}

export interface ParseResult {
  spans: WeightSpan[]
  diagnostics: PromptDiagnostic[]
  artists: ArtistSpan[]
}

/**
 * 数字前出现这些字符时，该数字才被当作权重的起始。
 *
 * `\u001F` 是本工程分块文档的段分隔符（见 shared/blockDoc.ts 的 BLOCK_SEP），
 * 源工程没有它。不加进来的话，整篇文档喂给 parsePrompt 时紧跟分隔符的
 * `1.2::x` 不会开权重段，高亮与 Ctrl+↑↓ 会全线错位。
 */
const DELIMITERS = new Set([',', '，', '{', '[', '(', '|', ':', ' ', '\t', '\n', '\r', '\u001F'])

function isDelimiter(ch: string | undefined): boolean {
  // undefined 表示字符串开头，同样算分隔位
  return ch === undefined || DELIMITERS.has(ch)
}

const NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)$/

/**
 * 匹配紧贴在 index 之前结束的数字。
 *
 * 向后扫描而不是对 `text.slice(0, index)` 跑正则：后者对每个 `::` 都要
 * 复制一次前缀，长提示词上是平方级开销。
 */
export function matchNumberBefore(
  text: string,
  index: number,
): { start: number; value: number } | null {
  let runStart = index
  while (runStart > 0 && /[0-9.]/.test(text[runStart - 1])) runStart--
  if (runStart > 0 && text[runStart - 1] === '-') runStart--
  if (runStart === index) return null

  // 从最长开始截，取第一个合法的——`1.2.3` 这类写法取到 `2.3`
  for (let s = runStart; s < index; s++) {
    const literal = text.slice(s, index)
    if (!NUMBER_RE.test(literal)) continue
    const value = parseFloat(literal)
    if (Number.isFinite(value)) return { start: s, value }
  }
  return null
}

export function parsePrompt(text: string): ParseResult {
  const spans: WeightSpan[] = []
  const diagnostics: PromptDiagnostic[] = []
  const stack: WeightSpan[] = []

  let i = 0
  while (i < text.length) {
    if (text[i] !== ':' || text[i + 1] !== ':') {
      i++
      continue
    }

    const num = matchNumberBefore(text, i)
    const opensNew = num !== null && isDelimiter(text[num.start - 1])

    if (num !== null && opensNew) {
      const span: WeightSpan = {
        start: num.start,
        end: text.length,
        depth: stack.length,
        weight: num.value,
        numStart: num.start,
        numEnd: i,
        contentStart: i + 2,
        contentEnd: text.length,
        closeStart: null,
        closed: false,
      }
      spans.push(span)
      stack.push(span)
      i += 2
      continue
    }

    if (num !== null) {
      // 数字紧贴 :: 但前面不是分隔符：这是标签末尾的数字。
      // NAI 会把它当成新加权段的起始，导致后面整段解析错位。
      diagnostics.push({
        from: num.start,
        to: i,
        severity: 'error',
        code: 'digit-before-close',
        message:
          `「${text.slice(num.start, i)}::」会被识别为新加权段的起始。` +
          '若这是标签末尾的数字，请在数字与 :: 之间加一个空格。',
      })
    }

    const open = stack.pop()
    if (open) {
      open.contentEnd = i
      open.closeStart = i
      open.end = i + 2
      open.closed = true
    } else {
      diagnostics.push({
        from: i,
        to: i + 2,
        severity: 'warning',
        code: 'stray-close',
        message: '这个 :: 没有与之配对的加权段起始。',
      })
    }
    i += 2
  }

  for (const span of stack) {
    diagnostics.push({
      from: span.start,
      to: text.length,
      severity: 'error',
      code: 'unclosed',
      message: '加权段没有闭合的 ::，作用范围会一直延伸到提示词末尾。',
    })
  }

  diagnostics.sort((a, b) => a.from - b.from)
  return { spans, diagnostics, artists: findArtistSpans(text) }
}

/**
 * 前缀必须落在词首：字符串开头，或逗号/空白/括号/竖线/冒号之后。
 * 冒号必须在内——`1.2::artist:wlop ::` 里画师词紧跟在 `::` 后面，
 * 漏掉它会让权重段内的画师词全部识别不到。
 *
 * 词身允许中间出现空格——Danbooru 的画师名本身可能含空格（`greem bang`、
 * `manzai sugar`），排除掉 `\s` 会把一个画师名劈成两半。但排除 `:`、`@`、
 * 括号、竖线、逗号、换行：`::` 与逗号必须能正常截断词。结尾的空格单独裁掉
 * （见下）——`artist:manzai sugar ::` 不能把 `::` 前那个空格也涂上色，
 * 更不能把 `::` 本身吃进去。
 *
 * 词首单独用 lookbehind 区分两种前缀：`artist:` 后词首只要不是空白就行，
 * `@` 后词首必须是字母——颜文字 `@_@` 的 `_` 直接被这条规则挡掉；`@w@`
 * 里的 `w` 满足这条规则，但紧跟着的第二个 `@` 会被下面「词后紧跟 @ 就
 * 整体作废」的检查挡掉，避免把颜文字截断成 `@w` 半截着色。
 */
const ARTIST_RE =
  /(?:^|[,，\s{[(|:])(artist:|@)((?:(?<=@)[A-Za-z]|(?<=artist:)[^\s,，{}[\]()|:@])[^,，{}[\]()|:@\t\n\r]*)/g

export function findArtistSpans(text: string): ArtistSpan[] {
  const out: ArtistSpan[] = []
  // 每次调用都新建正则：全局正则带可变的 lastIndex，复用会串状态
  const re = new RegExp(ARTIST_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const [whole, prefix, rawName] = m
    // @w@ 这类颜文字：词身在第二个 @ 处已经停止匹配（@ 被排除在字符集外），
    // 但那个 @ 仍紧贴在词后——说明这不是一个孤立的画师 handle，整体作废
    if (text[re.lastIndex] === '@') continue
    const name = rawName.replace(/ +$/, '')
    const start = m.index + whole.length - prefix.length - rawName.length
    out.push({ start, end: start + prefix.length + name.length, name })
  }
  return out
}
