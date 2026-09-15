import { formatWeight } from './weight'
import { findArtistSpans } from './tokenize'

/** 老 NAI 的一层 `{}` 相当于 ×1.05，`[]` 相当于 ÷1.05 */
const NAI_BRACE_FACTOR = 1.05

export interface NormalizeResult {
  text: string
  /** 转换掉的权重组数量（`{}` / `[]` / `(x:1.2)` 合计） */
  weights: number
  /** 换成 artist: 前缀的 @ 标记数量 */
  artists: number
  /** 还原成普通圆括号的 webui 转义（`\(` 与 `\)` 各算一处） */
  escapes: number
}

/**
 * 把老式权重语法与 `@` 画师标记转成本工具（NAI 新版）的写法。
 *
 * 规则由用户拍板：
 * - `{x}` → `1.05::x::`，`[x]` → `0.95::x::`（基数 1.05，按老 NAI 而非 webui 的 1.1）
 * - `(x:1.3)` → `1.3::x::`
 * - **裸 `(x)` 一律不动**。Danbooru 的角色 tag 大量长成 `daiwa scarlet (umamusume)`，
 *   把它当权重转掉会静默毁掉 tag；而这两种形态在文本上无法可靠区分，
 *   所以宁可少转、让用户自己改那几个 `(masterpiece)`。
 * - `@wlop` → `artist:wlop`
 * - webui 的转义 `\(` `\)` → 普通 `(` `)`：NAI 的圆括号本来就是普通字符，反斜杠会原样
 *   进提示词成了污染。转义的括号不当权重语法，也不参与配对。只还原圆括号——
 *   `{}` `[]` 在 NAI 里是加减权语法，把 `\{` 还原出来反而改了语义。
 */
export function normalizeWeights(text: string): NormalizeResult {
  const counters = { weights: 0, artists: 0, escapes: 0 }
  const withArtists = replaceAtMarks(text, counters)
  return { text: convertGroups(withArtists, counters).text, ...counters }
}

interface Counters {
  weights: number
  artists: number
  escapes: number
}

/** `@wlop` → `artist:wlop`。借 findArtistSpans 认词，不自己再写一套匹配规则 */
function replaceAtMarks(text: string, counters: Counters): string {
  const spans = findArtistSpans(text).filter((s) => text[s.start] === '@')
  let out = text
  // 从后往前替换，前面尚未处理的下标不会被打乱
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i]
    out = `${out.slice(0, s.start)}artist:${s.name}${out.slice(s.end)}`
    counters.artists++
  }
  return out
}

/**
 * 转换的中间结果。
 *
 * `single.factor` 存的是**已经四舍五入过的**系数，也就是文本里真正写着的那个数。
 * 于是嵌套是「按写出来的数逐层再乘」：`[[x]]` = 0.95 再 ÷1.05 → 0.9，而不是
 * 精确的 (1/1.05)² = 0.907 → 0.91。这是用户拍板选的简单转换——好处是每一层的
 * 数字都能跟上一层的输出对上，也落在本工具 0.05 步进的权重网格上。
 */
interface Converted {
  text: string
  /** 整串恰好是本函数生成的一个权重段时，它的精确系数与内容；否则 null */
  single: { factor: number; content: string } | null
}

function convertGroups(text: string, counters: Counters): Converted {
  let out = ''
  let groups = 0
  let emittedPlain = false
  let lastGroup: { factor: number; content: string } | null = null
  let i = 0

  const emitGroup = (factor: number, inner: Converted): void => {
    counters.weights++
    // 内层整串就是一个段时折叠成一次乘法：不折叠的话 `{{x}}` 会变成
    // `1.05::1.05::x::::`，语义等价但没法看
    const g = inner.single
      ? { factor: factor * inner.single.factor, content: inner.single.content }
      : { factor, content: inner.text }
    const shown = formatWeight(g.factor)
    out += `${shown}::${g.content}::`
    // 存回四舍五入后的值，外层再乘时用的就是这里写出去的那个数
    lastGroup = { factor: Number(shown), content: g.content }
    groups++
  }

  while (i < text.length) {
    const ch = text[i]

    if (isEscapedParen(text, i)) {
      out += text[i + 1]
      counters.escapes++
      emittedPlain = true
      i += 2
      continue
    }

    if (ch === '{' || ch === '[') {
      const end = matchBracket(text, i)
      // 不闭合就原样输出这个字符：这是用户自己写坏的语法，
      // 由编辑器的诊断去提示，转换动作不该顺手「修」掉
      if (end < 0) {
        out += ch
        emittedPlain = true
        i++
        continue
      }
      emitGroup(
        ch === '{' ? NAI_BRACE_FACTOR : 1 / NAI_BRACE_FACTOR,
        convertGroups(text.slice(i + 1, end), counters),
      )
      i = end + 1
      continue
    }

    if (ch === '(') {
      const end = matchBracket(text, i)
      if (end < 0) {
        out += ch
        emittedPlain = true
        i++
        continue
      }
      const body = text.slice(i + 1, end)
      const explicit = /^([\s\S]*):(-?\d+(?:\.\d+)?)$/.exec(body)
      if (explicit) {
        emitGroup(Number(explicit[2]), convertGroups(explicit[1], counters))
      } else {
        // 裸括号原样留下，但内部照样要转——里面可能还有 {} 或 @
        out += `(${convertGroups(body, counters).text})`
        emittedPlain = true
      }
      i = end + 1
      continue
    }

    out += ch
    emittedPlain = true
    i++
  }

  return { text: out, single: groups === 1 && !emittedPlain ? lastGroup : null }
}

const PAIRS: Record<string, string> = { '{': '}', '[': ']', '(': ')' }

/** 从 open 处找配对的闭括号（计嵌套）；找不到返回 -1 */
function matchBracket(text: string, open: number): number {
  const o = text[open]
  const c = PAIRS[o]
  let depth = 0
  for (let i = open; i < text.length; i++) {
    // 转义的圆括号是普通字符：连同反斜杠跳过，不计入嵌套
    if (isEscapedParen(text, i)) {
      i++
      continue
    }
    if (text[i] === o) depth++
    else if (text[i] === c) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** i 处是不是 webui 转义的圆括号 `\(` 或 `\)` */
function isEscapedParen(text: string, i: number): boolean {
  return text[i] === '\\' && (text[i + 1] === '(' || text[i + 1] === ')')
}
