import { parsePrompt, type WeightSpan } from './tokenize'

export const WEIGHT_STEP = 0.05
export const MIN_WEIGHT = 0.05

export interface AdjustResult {
  text: string
  selectionStart: number
  selectionEnd: number
  /** false 表示本次按键没有产生任何改动（例如已在下限） */
  changed: boolean
}

/**
 * 权重数字的显示形式。
 *
 * 先 toFixed(2) 再 parseFloat：0.05 的连续累加会攒出
 * 1.0500000000000003 这种尾巴，直接 String() 会把它写进提示词。
 */
export function formatWeight(w: number): string {
  return String(parseFloat(w.toFixed(2)))
}

function roundWeight(w: number): number {
  return parseFloat(w.toFixed(2))
}

/** 逗号（半角/全角）与 `::` 都算单元边界 */
function isUnitBoundaryComma(ch: string | undefined): boolean {
  return ch === ',' || ch === '，'
}

/**
 * 光标所在的单元，两端空白已去掉。
 *
 * 边界除了逗号还必须包含 `::`：否则光标落在多标签加权组
 * （`1.3::artist:a, artist:b::`）的第一个标签上时，回扫会越过 `1.3::`
 * 把权重前缀本身吞进单元，包裹之后组内其余标签的权重会被静默改掉。
 *
 * 只用于「光标不落在任何已有权重段内」的兜底分支（见 adjustWeight）：
 * 权重段内部按逗号切出的子单元不代表整个权重内容，拿它去跟权重段做
 * 精确匹配曾经是「多标签权重组内退化成新建嵌套」这个 bug 的根源。
 */
export function unitRangeAt(text: string, pos: number): { start: number; end: number } {
  // 光标恰好卡在一对 `::` 的两个冒号中间时，先归一到这对冒号之前。
  // `::` 是一个两字符的分隔符，光标停在它正中间在语义上仍属于这个加权段；
  // 不归一的话单元会跨过半个分隔符，包裹结果把 `::` 劈开成畸形文本。
  if (text[pos - 1] === ':' && text[pos] === ':') pos--

  let start = pos
  while (
    start > 0 &&
    !isUnitBoundaryComma(text[start - 1]) &&
    !(text[start - 1] === ':' && text[start - 2] === ':')
  ) {
    start--
  }
  let end = pos
  while (
    end < text.length &&
    !isUnitBoundaryComma(text[end]) &&
    !(text[end] === ':' && text[end + 1] === ':')
  ) {
    end++
  }
  while (start < end && /\s/.test(text[start])) start++
  while (end > start && /\s/.test(text[end - 1])) end--
  return { start, end }
}

/**
 * 包含光标位置、范围最小（嵌套最深）的已闭合权重段。
 *
 * 「落在权重段内」两端都算数——数字本身、开头 `::`、内容、结尾 `::`
 * 全部包含在 [span.start, span.end] 里，所以用 <= / >= 而不是严格
 * 不等号。嵌套权重段互相包含、同深度的权重段互不重叠（NAI 权重语法
 * 只有这两种关系，不会出现交叉），所以包含同一光标位置的权重段必然
 * 落在一条从外到内的链上，取其中 depth 最大的即为最内层。
 */
function findInnermostSpanAt(spans: WeightSpan[], pos: number): WeightSpan | undefined {
  let best: WeightSpan | undefined
  for (const s of spans) {
    if (!s.closed) continue
    if (pos < s.start || pos > s.end) continue
    if (!best || s.depth > best.depth) best = s
  }
  return best
}

/**
 * Ctrl+↑↓ 的权重调整。
 *
 * 判定顺序：
 * 1. 无选区，光标落在某个已闭合权重段内（含数字、含两对 `::`）
 *    → 改这个权重段的数字，嵌套时取最内层，不新建。
 * 2. 有选区，且选区恰好与某个权重段的整段边界重合
 *    → 同样是「改数字」而不是「新建」。这一支有两个各自独立成立的理由，
 *    **删掉任何一个理由都不足以删掉这一支**：
 *    (a) 它就是对的：用户手动整段选中 `0.8::a, b::` 再按 Ctrl+↑，
 *        意图显然是「把这个权重调上去」，而不是再套一层；
 *    (b) 编辑器每次调整后会把新权重段整段选中，下一次按键把这个选区
 *        原样传回来。少了这一支，连按 Ctrl+↑ 会层层嵌套成
 *        `1.05::1.05::…::::`，而不是把数字累加上去。
 *    所以将来即使编辑器改成不回灌选区（理由 b 消失），这一支也必须保留。
 * 3. 有选区，且不满足 2（哪怕选区整个落在某权重段内部）
 *    → 新建一层，包住选区本身。这是用户特意留的
 *    「选中之后我就是要在这里再加一层」的出口。
 * 4. 无选区，且光标不落在任何权重段内 → 维持旧行为：
 *    对光标所在的逗号/`::` 分隔单元新建权重。
 *
 * 「改数字」之后：改完等于 1 时脱去包裹（并去掉当初为「数字结尾」补的
 * 那个空格）；「新建」时内容以数字结尾要在内容与结束 `::` 之间补一个
 * 空格，避免生成出会被误解析的 `1.05::as109::`（见 tokenize.ts 的说明）。
 */
export function adjustWeight(
  text: string,
  selStart: number,
  selEnd: number,
  delta: number,
): AdjustResult {
  const unchanged: AdjustResult = {
    text,
    selectionStart: selStart,
    selectionEnd: selEnd,
    changed: false,
  }

  const selRange =
    selStart !== selEnd
      ? { start: Math.min(selStart, selEnd), end: Math.max(selStart, selEnd) }
      : null

  const { spans } = parsePrompt(text)

  const hit = selRange
    ? spans.find((s) => s.closed && s.start === selRange.start && s.end === selRange.end)
    : findInnermostSpanAt(spans, selStart)

  if (hit) {
    // 负权重上按 Ctrl+↓ 若继续走下面的 clamp，会从 -1.5 跳到 0.05，
    // 方向正好反了。负区间不是本工具的目标场景，按键直接不生效。
    if (hit.weight < 0) return unchanged

    const next = Math.max(MIN_WEIGHT, roundWeight(hit.weight + delta))

    if (next === hit.weight) return unchanged

    if (next === 1) {
      const bare = text.slice(hit.contentStart, hit.contentEnd).replace(/\s+$/, '')
      return {
        text: text.slice(0, hit.start) + bare + text.slice(hit.end),
        selectionStart: hit.start,
        selectionEnd: hit.start + bare.length,
        changed: true,
      }
    }

    const num = formatWeight(next)
    return {
      text: text.slice(0, hit.numStart) + num + text.slice(hit.numEnd),
      selectionStart: hit.start,
      selectionEnd: hit.end + (num.length - (hit.numEnd - hit.numStart)),
      changed: true,
    }
  }

  const target = selRange ?? unitRangeAt(text, selStart)
  if (target.start >= target.end) return unchanged

  const inner = text.slice(target.start, target.end)
  const next = Math.max(MIN_WEIGHT, roundWeight(1 + delta))
  const pad = /\d$/.test(inner) ? ' ' : ''
  const wrapped = `${formatWeight(next)}::${inner}${pad}::`

  return {
    text: text.slice(0, target.start) + wrapped + text.slice(target.end),
    selectionStart: target.start,
    selectionEnd: target.start + wrapped.length,
    changed: true,
  }
}
