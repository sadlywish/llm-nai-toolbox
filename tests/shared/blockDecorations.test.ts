import { describe, expect, it } from 'vitest'
import { MAIN_FIELDS } from '@shared/fields'
import { serializeFields } from '@shared/blockDoc'
import { buildBlockDecorations } from '@shared/blockDecorations'
import type { DecoKind } from '@shared/blockDecorations'

const TRIO = MAIN_FIELDS.slice(0, 3)
// ␟1girl␟␟skadi
const DOC = serializeFields({ count: '1girl', style: '', character: 'skadi' }, TRIO)

const kinds = (doc: string, cursor: number, kind: DecoKind) =>
  buildBlockDecorations(doc, TRIO, cursor).filter((d) => d.kind === kind)

describe('buildBlockDecorations', () => {
  it('每段一个徽章，落在该段的分隔符上', () => {
    const badges = kinds(DOC, 1, 'badge')
    expect(badges).toHaveLength(3)
    expect(badges.map((b) => b.from)).toEqual([0, 6, 7])
    expect(badges.every((b) => b.to === b.from + 1)).toBe(true)
    expect(badges.map((b) => b.label)).toEqual(['count', 'style', 'character'])
  })

  it('每段一个块装饰，区间等于该段内容范围', () => {
    const blocks = kinds(DOC, 1, 'block')
    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toMatchObject({ from: 1, to: 6, field: 'count' })
    expect(blocks[2]).toMatchObject({ from: 8, to: 13, field: 'character' })
  })

  it('空段额外带一个 blank 标记，非空段没有', () => {
    const blanks = kinds(DOC, 1, 'blank')
    expect(blanks.map((b) => b.field)).toEqual(['style'])
  })

  it('光标所在段带 active 标记，且只有一个', () => {
    expect(kinds(DOC, 3, 'active').map((d) => d.field)).toEqual(['count'])
    expect(kinds(DOC, 10, 'active').map((d) => d.field)).toEqual(['character'])
  })

  it('光标在空段时 active 落在空段上', () => {
    expect(kinds(DOC, 7, 'active').map((d) => d.field)).toEqual(['style'])
  })

  it('色相取自字段，同名字段同色', () => {
    const badges = kinds(DOC, 1, 'badge')
    expect(badges[0].hue).toBe(MAIN_FIELDS[0].hue)
    expect(badges[2].hue).toBe(MAIN_FIELDS[2].hue)
  })

  it('全角逗号命中被带出来，坐标是文档坐标', () => {
    const doc = serializeFields({ count: 'a，b', style: '', character: '' }, TRIO)
    const hits = buildBlockDecorations(doc, TRIO, 1).filter((d) => d.kind === 'comma')
    expect(hits).toHaveLength(1)
    expect(doc.slice(hits[0].from, hits[0].to)).toBe('，')
  })

  it('区间按 from 升序排好，CodeMirror 要求装饰有序', () => {
    const decos = buildBlockDecorations(DOC, TRIO, 3)
    const froms = decos.map((d) => d.from)
    expect([...froms].sort((a, b) => a - b)).toEqual(froms)
  })
})
