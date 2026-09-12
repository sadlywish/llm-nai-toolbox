import { describe, expect, it } from 'vitest'
import { CHARACTER_FIELDS, MAIN_FIELDS, fieldByName } from '@shared/fields'
import { blockRanges, serializeFields } from '@shared/blockDoc'
import { completionTargetAt } from '@shared/blockCompletion'

const rangeOf = (doc: string, specs: readonly { name: string }[], name: string) => {
  const hit = blockRanges(doc, specs as never).find((r) => r.name === name)
  if (hit === undefined) throw new Error(`没有字段 ${name}`)
  return hit
}

describe('completionTargetAt', () => {
  it('普通标签段：按逗号分隔的单元取词', () => {
    const doc = serializeFields({ tags: 'looking at viewer, upper body' }, MAIN_FIELDS)
    const r = rangeOf(doc, MAIN_FIELDS, 'tags')
    // 光标停在 'upper body' 中间
    const t = completionTargetAt(doc, MAIN_FIELDS, r.from + 'looking at viewer, upp'.length)
    expect(t).not.toBeNull()
    expect(t!.query.trim()).toBe('upper body')
    expect(doc.slice(t!.from, t!.to).trim()).toBe('upper body')
  })

  it('区间是文档坐标，不是段内坐标', () => {
    const doc = serializeFields({ count: '1girl', tags: 'solo' }, MAIN_FIELDS)
    const r = rangeOf(doc, MAIN_FIELDS, 'tags')
    const t = completionTargetAt(doc, MAIN_FIELDS, r.from + 2)!
    expect(t.from).toBeGreaterThanOrEqual(r.from)
    expect(t.to).toBeLessThanOrEqual(r.to)
    expect(doc.slice(t.from, t.to)).toBe('solo')
  })

  it('artist: 前缀词内只取前缀之后的名字，前缀本身不参与替换', () => {
    const doc = serializeFields({ artist: '0.6::artist:greem bang::' }, MAIN_FIELDS)
    const r = rangeOf(doc, MAIN_FIELDS, 'artist')
    const inner = '0.6::artist:greem b'.length
    const t = completionTargetAt(doc, MAIN_FIELDS, r.from + inner)!
    expect(t.query).toBe('greem bang')
    expect(doc.slice(t.from, t.to)).toBe('greem bang')
    expect(t.prefer).toBe('artist')
  })

  it('@ 前缀同样识别为画师词', () => {
    const doc = serializeFields({ tags: '@wlop' }, MAIN_FIELDS)
    const r = rangeOf(doc, MAIN_FIELDS, 'tags')
    const t = completionTargetAt(doc, MAIN_FIELDS, r.from + 4)!
    expect(t.query).toBe('wlop')
    expect(t.prefer).toBe('artist')
  })

  it('prefer 取所在字段的 completion —— character 段偏角色类', () => {
    const doc = serializeFields({ character: 'skadi' }, MAIN_FIELDS)
    const r = rangeOf(doc, MAIN_FIELDS, 'character')
    expect(completionTargetAt(doc, MAIN_FIELDS, r.from + 3)!.prefer).toBe('character')
  })

  it('series 段偏作品类', () => {
    const doc = serializeFields({ series: 'arknights' }, MAIN_FIELDS)
    const r = rangeOf(doc, MAIN_FIELDS, 'series')
    expect(completionTargetAt(doc, MAIN_FIELDS, r.from + 3)!.prefer).toBe('series')
  })

  it('artist 段没有前缀词时仍偏画师类', () => {
    const doc = serializeFields({ artist: 'wlop' }, MAIN_FIELDS)
    const r = rangeOf(doc, MAIN_FIELDS, 'artist')
    expect(completionTargetAt(doc, MAIN_FIELDS, r.from + 2)!.prefer).toBe('artist')
  })

  it('nltags 段不补全 —— 那里写的是自然语言', () => {
    const doc = serializeFields({ nltags: '她站在树林中' }, MAIN_FIELDS)
    const r = rangeOf(doc, MAIN_FIELDS, 'nltags')
    expect(completionTargetAt(doc, MAIN_FIELDS, r.from + 3)).toBeNull()
    expect(fieldByName(MAIN_FIELDS, 'nltags')!.completion).toBeNull()
  })

  it('角色的 count 是枚举，不补全', () => {
    const doc = serializeFields({ count: 'girl' }, CHARACTER_FIELDS)
    const r = rangeOf(doc, CHARACTER_FIELDS, 'count')
    expect(completionTargetAt(doc, CHARACTER_FIELDS, r.from + 2)).toBeNull()
  })

  it('空段没有词可补', () => {
    const doc = serializeFields({}, MAIN_FIELDS)
    const r = rangeOf(doc, MAIN_FIELDS, 'tags')
    expect(completionTargetAt(doc, MAIN_FIELDS, r.from)).toBeNull()
  })

  it('角色字段集同样工作，段数按五段算', () => {
    const doc = serializeFields({ appearance: 'grey hair' }, CHARACTER_FIELDS)
    const r = rangeOf(doc, CHARACTER_FIELDS, 'appearance')
    const t = completionTargetAt(doc, CHARACTER_FIELDS, r.from + 5)!
    expect(t.prefer).toBe('general')
    expect(doc.slice(t.from, t.to)).toBe('grey hair')
  })

  it('位置 0 不属于任何段 —— 那里只有分隔符，返回 null', () => {
    const doc = serializeFields({ tags: 'solo' }, MAIN_FIELDS)
    expect(completionTargetAt(doc, MAIN_FIELDS, 0)).toBeNull()
  })
})
