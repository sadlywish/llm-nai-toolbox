import { adjustWeight } from '@renderer/prompt/weight'
import { blockRanges } from './blockDoc'
import { fieldIndexAt } from './blockNav'
import type { FieldSpec } from './fields'

export interface WeightEdit {
  /** 要替换的文档区间起点，恒等于所在段的内容起点 */
  from: number
  to: number
  insert: string
  /** 替换后的选区，已换算成文档坐标 */
  anchor: number
  head: number
}

/**
 * 在光标所在段内调整权重。
 *
 * `adjustWeight` 是对「一整篇提示词」设计的纯函数，这里喂给它的是**单段内容**，
 * 拿回结果再把段内坐标加回段起点。只替换本段区间——整篇替换会覆盖分隔符，
 * 被段结构守卫整笔拒掉，表现是「按 Ctrl+↑ 毫无反应」。
 *
 * 返回 null 表示本次按键不产生改动；调用方仍应消费掉这次按键，
 * 否则它会冒泡成「把光标移到上一行」。
 */
export function adjustWeightInBlock(
  doc: string,
  specs: readonly FieldSpec[],
  selFrom: number,
  selTo: number,
  delta: number,
): WeightEdit | null {
  const range = blockRanges(doc, specs)[fieldIndexAt(doc, selFrom)]
  if (range === undefined) return null
  // 选区必须整个落在本段内。跨段加权没有意义，也不可能生成合法语法
  if (selFrom < range.from || selTo > range.to) return null

  const text = doc.slice(range.from, range.to)
  const result = adjustWeight(text, selFrom - range.from, selTo - range.from, delta)
  if (!result.changed) return null

  return {
    from: range.from,
    to: range.to,
    insert: result.text,
    anchor: range.from + result.selectionStart,
    head: range.from + result.selectionEnd,
  }
}
