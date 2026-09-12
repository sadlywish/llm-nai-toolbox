import { describe, expect, it } from 'vitest'
import { MAIN_FIELDS } from '@shared/fields'
import { emptyValues, serializeFields } from '@shared/blockDoc'
import {
  blockCommaHits,
  checkTokenLimit,
  longestBlock,
  tokensPerBlock,
  totalTokens,
} from '@shared/blockMetrics'

const TRIO = MAIN_FIELDS.slice(0, 3) // count(tags) / style(tags) / character(tags)
const NL = MAIN_FIELDS.filter((s) => s.name === 'nltags')

describe('token 计数', () => {
  it('每块各算各的，条目数等于字段数', () => {
    const rows = tokensPerBlock({ count: '1girl, solo', style: '', character: 'skadi' }, TRIO)
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.name)).toEqual(['count', 'style', 'character'])
  })

  it('空块是 0', () => {
    const rows = tokensPerBlock(emptyValues(TRIO), TRIO)
    expect(rows.every((r) => r.tokens === 0)).toBe(true)
  })

  it('合计等于各块之和', () => {
    const values = { count: '1girl, solo, portrait', style: 'flat color', character: 'skadi' }
    const rows = tokensPerBlock(values, TRIO)
    expect(totalTokens(values, TRIO)).toBe(rows.reduce((n, r) => n + r.tokens, 0))
  })

  it('最长块是 token 最多的那一块', () => {
    const values = { count: '1girl', style: '', character: 'a, b, c, d, e, f, g, h' }
    expect(longestBlock(values, TRIO)?.name).toBe('character')
  })

  it('全空时没有最长块', () => {
    expect(longestBlock(emptyValues(TRIO), TRIO)).toBeNull()
  })
})

describe('checkTokenLimit', () => {
  it('没超限返回 null', () => {
    expect(checkTokenLimit({ count: '1girl' }, TRIO, 'nai-diffusion-5-full')).toBeNull()
  })

  it('超限时带回合计、上限与最长块', () => {
    const long = Array.from({ length: 600 }, (_, i) => `tag${i}`).join(', ')
    const hit = checkTokenLimit({ count: '1girl', character: long }, TRIO, 'nai-diffusion-5-full')
    expect(hit).not.toBeNull()
    expect(hit!.limit).toBe(1471)
    expect(hit!.longest.name).toBe('character')
    expect(hit!.total).toBeGreaterThan(1471)
  })

  it('认不出的模型按 512 保守处理', () => {
    const mid = Array.from({ length: 300 }, (_, i) => `tag${i}`).join(', ')
    const hit = checkTokenLimit({ character: mid }, TRIO, '某中转自定义模型')
    expect(hit?.limit).toBe(512)
  })
})

describe('blockCommaHits', () => {
  it('命中位置是文档坐标，不是段内坐标', () => {
    const doc = serializeFields({ count: 'a，b', style: '', character: '' }, TRIO)
    const hits = blockCommaHits(doc, TRIO)
    expect(hits).toHaveLength(1)
    expect(hits[0].field).toBe('count')
    // ␟ a ， b  →  ，在下标 2
    expect(hits[0].from).toBe(2)
    expect(doc.slice(hits[0].from, hits[0].to)).toBe('，')
  })

  it('顿号同样命中', () => {
    const doc = serializeFields({ count: 'a、b' }, TRIO)
    expect(blockCommaHits(doc, TRIO).map((h) => h.char)).toEqual(['、'])
  })

  it('nltags 是自然语言，中文逗号不标', () => {
    const doc = serializeFields({ nltags: '她站在树林中，阳光洒下。' }, NL)
    expect(blockCommaHits(doc, NL)).toEqual([])
  })

  it('多段各自命中，互不串位', () => {
    const doc = serializeFields({ count: 'a，b', style: 'c、d', character: '' }, TRIO)
    const hits = blockCommaHits(doc, TRIO)
    expect(hits.map((h) => h.field)).toEqual(['count', 'style'])
    for (const h of hits) expect(doc.slice(h.from, h.to)).toBe(h.char)
  })
})
