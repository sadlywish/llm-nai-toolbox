import { describe, expect, it } from 'vitest'
import { CHARACTER_FIELDS, MAIN_FIELDS } from '../../src/shared/fields'
import { createCharacter, emptyWorkspace } from '../../src/shared/workspace'
import { tokenBudget } from '../../src/renderer/src/prompt/tokenBudget'

// 'abcd' 按 T5 估算恰好 1 token，拼 N 个就是 N token
const words = (n: number): string => Array.from({ length: n }, () => 'abcd').join(' ')

describe('tokenBudget', () => {
  it('合计正向与参与本轮的角色；上限按模型取', () => {
    const ws = emptyWorkspace()
    ws.params.model = 'nai-diffusion-4-5-full'
    ws.main.tags = words(10)
    const on = createCharacter()
    on.fields.tags = words(5)
    const off = createCharacter()
    off.enabled = false
    off.fields.tags = words(900)
    ws.characters = [on, off]
    const b = tokenBudget(ws, MAIN_FIELDS, CHARACTER_FIELDS)
    expect([b.limit, b.over, b.longest]).toEqual([512, false, null])
    expect(b.total).toBeGreaterThanOrEqual(15)
    expect(b.total).toBeLessThan(40)
  })

  it('超限时点出最长的块：整图的写字段名，角色的写「角色 N · 字段」', () => {
    const ws = emptyWorkspace()
    ws.params.model = 'nai-diffusion-4-5-full'
    ws.main.tags = words(300)
    const c = createCharacter()
    c.fields.appearance = words(400)
    ws.characters = [createCharacter(), c]
    const b = tokenBudget(ws, MAIN_FIELDS, CHARACTER_FIELDS)
    expect(b.over).toBe(true)
    expect(b.longest?.where).toBe('角色 2 · appearance')
  })

  it('V5 模型上限 1471', () => {
    const ws = emptyWorkspace()
    ws.main.tags = words(600)
    expect(tokenBudget(ws, MAIN_FIELDS, CHARACTER_FIELDS)).toMatchObject({ limit: 1471, over: false })
  })
})
