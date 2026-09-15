import { findDigitBeforeClose } from '@renderer/prompt/digitBeforeClose'
import { findFullWidthCommas } from '@renderer/prompt/fullWidthComma'
import { estimateT5Tokens, tokenLimitFor } from '@renderer/prompt/t5'
import type { FieldValues } from './blockDoc'
import { blockRanges, parseDocument } from './blockDoc'
import type { FieldSpec } from './fields'

export interface BlockTokens {
  index: number
  name: string
  tokens: number
}

export function tokensPerBlock(
  values: FieldValues,
  specs: readonly FieldSpec[],
): BlockTokens[] {
  return specs.map((spec, index) => ({
    index,
    name: spec.name,
    tokens: estimateT5Tokens(values[spec.name] ?? ''),
  }))
}

/**
 * ⚠️ 这是**各段独立估算之和**，不等于拼接后的真实 token 数 —— 漏掉了
 * buildPrompt 用来连接各段的 " , "（整图 10 段约少 9 token，角色 5 段约少 4）。
 * 方向是低估，与 t5.ts「宁可高估、漏报超限才是真问题」的原则相反。
 * 后续计划应改成「先拼接、再整篇估算」。
 */
export function totalTokens(
  values: FieldValues,
  specs: readonly FieldSpec[],
): number {
  return tokensPerBlock(values, specs).reduce((n, row) => n + row.tokens, 0)
}

/** 全空时返回 null——「最长的块是 count，0 token」是句废话，不该显示 */
export function longestBlock(
  values: FieldValues,
  specs: readonly FieldSpec[],
): BlockTokens | null {
  let best: BlockTokens | null = null
  for (const row of tokensPerBlock(values, specs)) {
    if (row.tokens > 0 && (best === null || row.tokens > best.tokens)) best = row
  }
  return best
}

export interface OverLimit {
  total: number
  limit: number
  longest: BlockTokens
}

/**
 * 超限检查。带回最长块是为了让提示能指着说「砍这块」——
 * 只报「超了 200 token」，用户还得自己一块块数。
 */
export function checkTokenLimit(
  values: FieldValues,
  specs: readonly FieldSpec[],
  model: string,
): OverLimit | null {
  const total = totalTokens(values, specs)
  const limit = tokenLimitFor(model)
  if (total <= limit) return null
  const longest = longestBlock(values, specs)
  if (longest === null) return null
  return { total, limit, longest }
}

export interface DocCommaHit {
  from: number
  to: number
  char: string
  /** 命中所在字段名，供提示文案指名道姓 */
  field: string
}

/**
 * 全角逗号命中，坐标已换算成**文档坐标**。
 *
 * 段内坐标直接拿去画装饰会整体左移一个分隔符再加上前面所有段的长度，
 * 表现是「标红标在别的块上」。
 */
export function blockCommaHits(
  doc: string,
  specs: readonly FieldSpec[],
): DocCommaHit[] {
  const values = parseDocument(doc, specs)
  const out: DocCommaHit[] = []
  for (const range of blockRanges(doc, specs)) {
    const spec = specs[range.index]
    if (!spec.flagFullWidthComma) continue
    for (const hit of findFullWidthCommas(values[spec.name])) {
      out.push({
        from: range.from + hit.from,
        to: range.from + hit.to,
        char: hit.char,
        field: spec.name,
      })
    }
  }
  return out
}

export interface DocDigitHit {
  from: number
  to: number
  message: string
  field: string
}

/** 标签末尾数字紧贴 `::` 的命中，文档坐标（理由同 blockCommaHits）。所有字段都查，见 digitBeforeClose.ts */
export function blockDigitHits(doc: string, specs: readonly FieldSpec[]): DocDigitHit[] {
  const values = parseDocument(doc, specs)
  const out: DocDigitHit[] = []
  for (const range of blockRanges(doc, specs)) {
    const spec = specs[range.index]
    for (const hit of findDigitBeforeClose(values[spec.name])) {
      out.push({ from: range.from + hit.from, to: range.from + hit.to, message: hit.message, field: spec.name })
    }
  }
  return out
}
