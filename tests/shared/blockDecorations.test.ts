import { describe, expect, it } from 'vitest'
import { MAIN_FIELDS } from '@shared/fields'
import { emptyValues, parseDocument, serializeFields } from '@shared/blockDoc'
import { buildBlockLayout } from '@shared/blockDecorations'
import { buildPrompt } from '@shared/prompt'

const TRIO = MAIN_FIELDS.slice(0, 3)
// ␟1girl␟␟skadi   下标： 0 1..5 6 7 8..12
const DOC = serializeFields({ count: '1girl', style: '', character: 'skadi' }, TRIO)

describe('buildBlockLayout', () => {
  it('每段一项，区间与分隔符位置取自段结构', () => {
    const { fields } = buildBlockLayout(DOC, TRIO, 1)
    expect(fields.map((f) => [f.sepAt, f.from, f.to])).toEqual([
      [0, 1, 6],
      [6, 7, 7],
      [7, 8, 13],
    ])
    expect(fields.map((f) => f.field)).toEqual(['count', 'style', 'character'])
    expect(fields.map((f) => f.empty)).toEqual([false, true, false])
  })

  it('色相与徽章文字取自字段', () => {
    const { fields } = buildBlockLayout(DOC, TRIO, 1)
    expect(fields.map((f) => f.hue)).toEqual(TRIO.map((s) => s.hue))
    expect(fields.map((f) => f.label)).toEqual(TRIO.map((s) => s.label))
  })

  it('光标所在段 active，且只有一个；光标在空段时落在空段上', () => {
    const active = (cursor: number) =>
      buildBlockLayout(DOC, TRIO, cursor).fields.filter((f) => f.active).map((f) => f.field)
    expect(active(3)).toEqual(['count'])
    expect(active(6)).toEqual(['count'])
    expect(active(7)).toEqual(['style'])
    expect(active(10)).toEqual(['character'])
  })

  it('只含空白的段不是空段（有框），但不进拼接结果（后面没有逗号）', () => {
    const doc = serializeFields({ count: '  ', style: '', character: 'a' }, TRIO)
    const [count, style, character] = buildBlockLayout(doc, TRIO, 1).fields
    expect(count).toMatchObject({ empty: false, joined: false })
    expect(style).toMatchObject({ empty: true, joined: false })
    expect(character).toMatchObject({ empty: false, joined: true })
  })

  it('标签单位是文档坐标', () => {
    const doc = serializeFields({ count: '', style: 'long hair, silver hair', character: '' }, TRIO)
    const style = buildBlockLayout(doc, TRIO, 1).fields[1]
    expect(style.tags.map((t) => doc.slice(t.from, t.to))).toEqual(['long hair,', 'silver hair'])
  })

  it('只有 tags 形态的字段切标签单位，nltags 是自然语言、照常在空格处折', () => {
    const doc = serializeFields({ ...emptyValues(MAIN_FIELDS), nltags: 'a b, c', tags: 'a b, c' }, MAIN_FIELDS)
    const { fields } = buildBlockLayout(doc, MAIN_FIELDS, 1)
    expect(fields.find((f) => f.field === 'nltags')!.tags).toEqual([])
    expect(fields.find((f) => f.field === 'tags')!.tags).toHaveLength(2)
  })

  it('全角逗号命中带出来，坐标是文档坐标', () => {
    const doc = serializeFields({ count: 'a，b', style: '', character: '' }, TRIO)
    const { commaHits } = buildBlockLayout(doc, TRIO, 1)
    expect(commaHits).toHaveLength(1)
    expect(doc.slice(commaHits[0].from, commaHits[0].to)).toBe('，')
  })

  it('性质：按版面拼出编辑器里看得见的文字，与 buildPrompt 的结果一致', () => {
    // 编辑器里看得见的：非空段的内容；joined 的段后面一个 ` ,`；块与块之间的空格。
    // 徽章与空框没有文字。比较时把空白压成一个，因为块间空格与 trim 掉的空白在屏幕上
    // 与拼接结果里的数量不同，那不是「看到的与发出去的不一致」。
    const pool = ['', '', '  ', '1girl', 'solo,', ' a, b ', '多 吗', 'x,,', ',']
    let seed = 3
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
    for (let round = 0; round < 500; round++) {
      const values = emptyValues(MAIN_FIELDS)
      for (const spec of MAIN_FIELDS) values[spec.name] = pool[Math.floor(rand() * pool.length)]
      const doc = serializeFields(values, MAIN_FIELDS)
      const shown = buildBlockLayout(doc, MAIN_FIELDS, 1)
        .fields.map((f) => (f.empty ? ' ' : doc.slice(f.from, f.to) + (f.joined ? ' , ' : ' ')))
        .join('')
      expect(squash(shown)).toBe(squash(buildPrompt(parseDocument(doc, MAIN_FIELDS), MAIN_FIELDS)))
    }
  })
})
