import { BLOCK_SEP, blockRanges } from './blockDoc'
import type { FieldSpec } from './fields'

/**
 * 光标所在段的下标。
 *
 * 判据是「pos 之前有几个分隔符」减一。段末尾（下一个分隔符**之前**）
 * 仍算本段——光标停在 `1girl` 后面时用户的意图是继续写 count，
 * 不是已经进了下一段。
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
 * 把落在分隔符上的位置推进该段内容里。
 *
 * 鼠标点在徽章上时 CodeMirror 给出的位置就是分隔符本身，不推的话
 * 接下来第一个字符会插在分隔符前面，落进上一段。
 */
export function clampToBlock(
  doc: string,
  specs: readonly FieldSpec[],
  pos: number,
): number {
  for (const range of blockRanges(doc, specs)) {
    if (pos === range.sepAt) return range.from
  }
  return pos
}
