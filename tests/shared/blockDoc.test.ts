import { describe, expect, it } from 'vitest'
import type { FieldSpec } from '@shared/fields'
import { CHARACTER_FIELDS, MAIN_FIELDS } from '@shared/fields'
import {
  BLOCK_SEP,
  blockRanges,
  emptyValues,
  isWellFormed,
  parseDocument,
  serializeFields,
  stripSeparators,
} from '@shared/blockDoc'

/** 三字段小样，边界情况用它比用十字段清楚 */
const TRIO: readonly FieldSpec[] = MAIN_FIELDS.slice(0, 3)

describe('serializeFields', () => {
  it('每段前一个分隔符，段数等于字段数', () => {
    const doc = serializeFields({ count: '1girl', style: '', character: 'skadi' }, TRIO)
    expect(doc).toBe(`${BLOCK_SEP}1girl${BLOCK_SEP}${BLOCK_SEP}skadi`)
  })

  it('缺失的字段当空串处理', () => {
    const doc = serializeFields({ count: '1girl' }, TRIO)
    expect(doc).toBe(`${BLOCK_SEP}1girl${BLOCK_SEP}${BLOCK_SEP}`)
  })

  it('值里混进分隔符会被剥掉，不许污染段结构', () => {
    const doc = serializeFields({ count: `a${BLOCK_SEP}b` }, TRIO)
    expect(doc.split(BLOCK_SEP)).toHaveLength(TRIO.length + 1)
    expect(parseDocument(doc, TRIO).count).toBe('ab')
  })
})

describe('往返一致性', () => {
  it('十字段满内容往返逐字相等', () => {
    const values = {
      count: '1girl, rating:sensitive, portrait',
      style: '',
      character: 'skadi (arknights)',
      artist: '0.4::artist:houkisei::, 0.6::artist:modare::',
      appearance: 'grey hair, red eyes',
      tags: 'looking at viewer, upper body',
      environment: 'forest, dappled sunlight',
      series: 'arknights',
      nltags: '斜上方侧面视角的胸部以上特写肖像。',
      quality: 'best quality, amazing quality',
    }
    expect(parseDocument(serializeFields(values, MAIN_FIELDS), MAIN_FIELDS)).toEqual(values)
  })

  it('全空往返仍是全空，段数不变', () => {
    const values = emptyValues(MAIN_FIELDS)
    const doc = serializeFields(values, MAIN_FIELDS)
    expect(doc).toHaveLength(MAIN_FIELDS.length)
    expect(parseDocument(doc, MAIN_FIELDS)).toEqual(values)
  })

  it('角色五字段用同一套函数，段数是 5 不是 10', () => {
    const doc = serializeFields({ count: 'girl' }, CHARACTER_FIELDS)
    expect(doc.split(BLOCK_SEP)).toHaveLength(CHARACTER_FIELDS.length + 1)
    expect(Object.keys(parseDocument(doc, CHARACTER_FIELDS))).toHaveLength(5)
  })
})

describe('isWellFormed / parseDocument', () => {
  it('段数不对判为损坏', () => {
    expect(isWellFormed(`${BLOCK_SEP}a${BLOCK_SEP}b`, TRIO)).toBe(false)
  })

  it('首段非空判为损坏——分隔符之前不该有内容', () => {
    expect(isWellFormed(`x${BLOCK_SEP}a${BLOCK_SEP}b${BLOCK_SEP}c`, TRIO)).toBe(false)
  })

  it('损坏文档抛错而不是静默修补', () => {
    expect(() => parseDocument(`${BLOCK_SEP}a`, TRIO)).toThrow(/分块文档结构损坏/)
  })
})

describe('blockRanges', () => {
  it('区间首尾相接覆盖全文', () => {
    const doc = serializeFields({ count: '1girl', style: '', character: 'skadi' }, TRIO)
    const ranges = blockRanges(doc, TRIO)
    expect(ranges).toHaveLength(3)
    expect(ranges[0]).toEqual({ index: 0, name: 'count', sepAt: 0, from: 1, to: 6 })
    expect(ranges[1]).toEqual({ index: 1, name: 'style', sepAt: 6, from: 7, to: 7 })
    expect(ranges[2]).toEqual({ index: 2, name: 'character', sepAt: 7, from: 8, to: 13 })
    expect(ranges[ranges.length - 1].to).toBe(doc.length)
  })

  it('空块的 from 与 to 相等', () => {
    const doc = serializeFields(emptyValues(TRIO), TRIO)
    for (const r of blockRanges(doc, TRIO)) expect(r.from).toBe(r.to)
  })
})
