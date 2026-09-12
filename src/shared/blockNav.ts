import { BLOCK_SEP, blockRanges } from './blockDoc'
import type { FieldSpec } from './fields'

/**
 * 光标所在段的下标。
 *
 * 判据是「pos 之前有几个分隔符」减一。段末尾（下一个分隔符**之前**）
 * 仍算本段——光标停在 `1girl` 后面时用户的意图是继续写 count，
 * 不是已经进了下一段。
 *
 * ⚠️ 位置 0 会被 Math.max(0, count - 1) 兜底夹成第 0 段，那是**夹逼而非真实归属**
 *（见 blockDoc.ts 的「位置的几何」：0 不属于任何段）。消费方不得据此认为
 * 0 在第 0 段内 —— 正是这类「函数 A 的兜底被函数 B 当成事实」的误读催生了
 * clampToBlock 那个 Critical。
 */
export function fieldIndexAt(doc: string, pos: number): number {
  let count = 0
  const limit = Math.max(0, Math.min(pos, doc.length))
  for (let i = 0; i < limit; i++) {
    if (doc[i] === BLOCK_SEP) count++
  }
  return Math.max(0, count - 1)
}

/**
 * `move` = 把光标挪到 `to`，不改文档；
 * `block` = 什么都不做；
 * `null` = 交给默认行为。
 */
export type EditGuard = { kind: 'move'; to: number } | { kind: 'block' } | null

/**
 * 段首退格。
 *
 * 默认行为会删掉分隔符、把两段并成一段——那正是「块边界删不穿」要防的事。
 * 改成把光标挪到上一段末尾：用户想接着往回删就再按一次，删的是上一段的内容。
 */
export function resolveBackspace(doc: string, pos: number): EditGuard {
  if (pos <= 0) return { kind: 'block' }
  if (doc[pos - 1] !== BLOCK_SEP) return null
  // pos-1 === 0 是第一段的分隔符，它前面没有段可去
  if (pos - 1 === 0) return { kind: 'block' }
  return { kind: 'move', to: pos - 1 }
}

/** 段尾按 Delete。对称处理：挪到下一段开头 */
export function resolveDelete(doc: string, pos: number): EditGuard {
  if (pos >= doc.length) return { kind: 'block' }
  if (doc[pos] !== BLOCK_SEP) return null
  return { kind: 'move', to: pos + 1 }
}

/** 改动范围是否包含分隔符。包含即跨段，必须拒绝 */
export function changeTouchesSeparator(
  doc: string,
  from: number,
  to: number,
): boolean {
  return doc.slice(from, to).includes(BLOCK_SEP)
}

/**
 * 把落在「不属于任何段」的位置推进第 0 段。
 *
 * 见 blockDoc.ts 的「位置的几何」：1..doc.length 每个位置都唯一属于某一段，
 * 只有 0 不属于任何段。不能按 pos === sepAt 推 —— sepAt_i 同时是 to_{i-1}，
 * 推走就等于没收了「上一段末尾」这个合法落点（曾是 Critical：段首退格、
 * 空段落点、非末段末尾点选全部失灵）。
 */
export function clampToBlock(
  doc: string,
  _specs: readonly FieldSpec[],
  pos: number,
): number {
  // _specs 保留不删：签名一改调用点与测试都要跟着动，而后续若要按段做更细的
  // 落点修正（例如 enum 段禁止落点）还会用上。
  return pos === 0 ? 1 : pos
}

/**
 * 光标停在 `pos` 时，应不应该把它关联到**前一个**字符（assoc = -1）。
 *
 * 段的几何（见 blockDoc.ts 的「位置的几何」）决定了 `to_i === sepAt_{i+1}`：
 * 同一个位置既是第 i 段内容的末尾，也是第 i+1 段的分隔符位。但第 i+1 段的
 * **内容起点**是 `sepAt_{i+1} + 1`，是另一个位置 —— 所以这个位置不存在
 * 「下一段开头」这层含义，它只能是「第 i 段的末尾」。
 *
 * 不显式关联到前一个字符的话，CodeMirror 会向后解析（分隔符被 replace 藏掉，
 * 零宽度），把光标画在后一段框的左边缘，表现为「光标从后一个标签往前移，
 * 却显示在后一个标签的头部」。
 *
 * 空段除外：空段 `from === to`，同一位置还兼着「本段内容起点」，
 * 关联到前一个字符会把光标画到上一段去。
 */
export function prefersBackwardAssoc(
  doc: string,
  specs: readonly FieldSpec[],
  pos: number,
): boolean {
  for (const range of blockRanges(doc, specs)) {
    // 空段：同一位置有多重含义，不能一律往前靠
    if (range.from === range.to) continue
    if (pos === range.to) return true
  }
  return false
}
