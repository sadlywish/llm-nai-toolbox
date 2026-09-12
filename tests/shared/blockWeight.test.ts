import { describe, expect, it } from 'vitest'
import { CHARACTER_FIELDS, MAIN_FIELDS } from '@shared/fields'
import { blockRanges, serializeFields } from '@shared/blockDoc'
import { adjustWeightInBlock } from '@shared/blockWeight'

const TRIO = MAIN_FIELDS.slice(0, 3) // count / style / character
const STEP = 0.05

/** 取某字段内容的文档坐标区间，测试里不手算下标 */
function rangeOf(doc: string, name: string) {
  const hit = blockRanges(doc, TRIO).find((r) => r.name === name)
  if (hit === undefined) throw new Error(`没有字段 ${name}`)
  return hit
}

describe('adjustWeightInBlock', () => {
  it('无权重时给光标所在单元加一层，改动范围正好是本段', () => {
    const doc = serializeFields({ count: '1girl', style: '', character: 'artist:wlop' }, TRIO)
    const r = rangeOf(doc, 'character')
    const edit = adjustWeightInBlock(doc, TRIO, r.from + 4, r.from + 4, STEP)

    expect(edit).not.toBeNull()
    expect(edit!.from).toBe(r.from)
    expect(edit!.to).toBe(r.to)
    expect(edit!.insert).toContain('artist:wlop')
    expect(parseFloat(edit!.insert.split('::')[0])).toBeCloseTo(1.05, 5)
  })

  it('已有权重时数字累加，不再套一层', () => {
    const doc = serializeFields({ count: '', style: '', character: '1.05::artist:wlop::' }, TRIO)
    const r = rangeOf(doc, 'character')
    const edit = adjustWeightInBlock(doc, TRIO, r.from + 10, r.from + 10, STEP)

    expect(edit).not.toBeNull()
    expect(parseFloat(edit!.insert.split('::')[0])).toBeCloseTo(1.1, 5)
    expect(edit!.insert.split('::')).toHaveLength(3)
  })

  it('Ctrl+↓ 调回 1 时脱去包裹，留下裸标签', () => {
    const doc = serializeFields({ count: '', style: '', character: '1.05::artist:wlop::' }, TRIO)
    const r = rangeOf(doc, 'character')
    const edit = adjustWeightInBlock(doc, TRIO, r.from + 10, r.from + 10, -STEP)

    // 权重回到 1 等于没有权重，adjustWeight 会整段脱去 `1::…::` 包裹
    expect(edit).not.toBeNull()
    expect(edit!.insert).toBe('artist:wlop')
  })

  it('改动与选区坐标都不越出本段', () => {
    const doc = serializeFields({ count: '1girl', style: '', character: 'artist:wlop' }, TRIO)
    const r = rangeOf(doc, 'character')
    const edit = adjustWeightInBlock(doc, TRIO, r.from + 4, r.from + 4, STEP)!

    expect(edit.from).toBeGreaterThanOrEqual(r.from)
    expect(edit.to).toBeLessThanOrEqual(r.to)
    expect(edit.anchor).toBeGreaterThanOrEqual(edit.from)
    expect(edit.head).toBeLessThanOrEqual(edit.from + edit.insert.length)
  })

  it('选区跨段一律不处理——权重语法不可能跨越分隔符', () => {
    const doc = serializeFields({ count: '1girl', style: '', character: 'artist:wlop' }, TRIO)
    const count = rangeOf(doc, 'count')
    const character = rangeOf(doc, 'character')
    expect(adjustWeightInBlock(doc, TRIO, count.from, character.to, STEP)).toBeNull()
  })

  it('空段里按键什么都不发生', () => {
    const doc = serializeFields({ count: '1girl', style: '', character: 'artist:wlop' }, TRIO)
    const r = rangeOf(doc, 'style')
    expect(adjustWeightInBlock(doc, TRIO, r.from, r.from, STEP)).toBeNull()
  })

  it('角色字段集同样适用，坐标按五段算', () => {
    const doc = serializeFields({ appearance: 'artist:wlop' }, CHARACTER_FIELDS)
    const hit = blockRanges(doc, CHARACTER_FIELDS).find((r) => r.name === 'appearance')!
    const edit = adjustWeightInBlock(doc, CHARACTER_FIELDS, hit.from + 2, hit.from + 2, STEP)
    expect(edit).not.toBeNull()
    expect(edit!.from).toBe(hit.from)
    expect(edit!.to).toBe(hit.to)
  })
})
