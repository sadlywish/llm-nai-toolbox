import { longestBlock, totalTokens } from '@shared/blockMetrics'
import type { FieldSpec } from '@shared/fields'
import type { Workspace } from '@shared/workspace'
import { tokenLimitFor } from './t5'

export interface TokenBudget {
  total: number
  limit: number
  over: boolean
  /** 只在超限时给出：整图与全部启用角色里 token 最多的那个块，点名让人知道该砍哪块 */
  longest: { where: string; tokens: number } | null
}

interface Longest {
  where: string
  tokens: number
}

/** 整图与全部启用角色里 token 最多的那个块；超限时点名让人知道该砍哪块 */
function longestAcross(
  ws: Workspace,
  mainSpecs: readonly FieldSpec[],
  charSpecs: readonly FieldSpec[],
): Longest | null {
  const candidates: Longest[] = []
  const main = longestBlock(ws.main, mainSpecs)
  if (main !== null) candidates.push({ where: main.name, tokens: main.tokens })
  ws.characters.forEach((c, i) => {
    if (!c.enabled) return
    const b = longestBlock(c.fields, charSpecs)
    if (b !== null) candidates.push({ where: `角色 ${i + 1} · ${b.name}`, tokens: b.tokens })
  })
  return candidates.reduce<Longest | null>((a, b) => (a === null || b.tokens > a.tokens ? b : a), null)
}

/**
 * 提示词 token 预算。口径与画师串工具箱一致：正向 + 全部启用角色（NAI 的上限就是这两者合计）。
 * 提示词面板显示与生成前检查共用这一份，两边各算一遍迟早对不上。
 */
export function tokenBudget(ws: Workspace, mainSpecs: readonly FieldSpec[], charSpecs: readonly FieldSpec[]): TokenBudget {
  const total =
    totalTokens(ws.main, mainSpecs) +
    ws.characters.filter((c) => c.enabled).reduce((n, c) => n + totalTokens(c.fields, charSpecs), 0)
  const limit = tokenLimitFor(ws.params.model)
  const over = total > limit
  const longest = over ? longestAcross(ws, mainSpecs, charSpecs) : null
  return { total, limit, over, longest }
}
