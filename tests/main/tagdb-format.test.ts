import { describe, expect, it } from 'vitest'
import { defaultAppConfig } from '../../src/shared/config'
import type { SearchMatch, SearchResult, TagEntry } from '../../src/shared/tagdb/search'
import { displayMapFromConfig, formatSearchResults } from '../../src/main/tagdb/format'
import { parseGlossDb } from '../../src/main/tagdb/gloss'

const seriesDb: TagEntry[] = [
  { tag: 'fate_(series)', count: 1, zh: ['Fate系列'], zhFull: [], zhShort: [], zhNick: [], ja: [], en: [], other: [], series: [] },
]
const m = (tag: string, score: number, extra: Partial<SearchMatch> = {}): SearchMatch => ({
  tag, score, count: 10, zh: [], series: [], wiki: '', ...extra,
})
const display = (over: Partial<ReturnType<typeof defaultAppConfig>> = {}) =>
  displayMapFromConfig({ ...defaultAppConfig(), ...over })

describe('displayMapFromConfig', () => {
  it('四类各取各的配置项，wikiLength 共用', () => {
    const d = display({ tagQueryArtistMax: 7, tagQueryCharacterSeries: false, tagQueryWikiLength: 99 })
    expect(d['画师']).toEqual({ max: 7, aliases: true, wiki: false, wikiLength: 99 })
    expect(d['角色'].series).toBe(false)
    expect(d['概念'].wiki).toBe(true)
  })
})

describe('formatSearchResults', () => {
  it('无匹配', () => {
    const r: SearchResult[] = [{ query: 'x', type: '概念', matches: [] }]
    expect(formatSearchResults(r, seriesDb, display())).toBe('[概念] 查询: "x"\n  无匹配结果')
  })

  it('标签转成 NovelAI 写法；作品取中文名；中文名一行', () => {
    const r: SearchResult[] = [
      { query: 'saber', type: '角色', matches: [m('saber_(fate)', 0.99, { series: ['fate_(series)'], zh: ['阿尔托莉雅'] })] },
    ]
    expect(formatSearchResults(r, seriesDb, display())).toBe(
      '[角色] 查询: "saber"\n  1. saber (fate) (匹配度: 0.99, 图片数: 10, 作品: Fate系列)\n     中文名: 阿尔托莉雅',
    )
  })

  it('关掉别名就不给中文名；关掉作品就不给作品', () => {
    const r: SearchResult[] = [
      { query: 'saber', type: '角色', matches: [m('saber_(fate)', 0.99, { series: ['fate_(series)'], zh: ['阿尔托莉雅'] })] },
    ]
    const text = formatSearchResults(r, seriesDb, display({ tagQueryCharacterAliases: false, tagQueryCharacterSeries: false }))
    expect(text).not.toContain('中文名')
    expect(text).not.toContain('作品')
  })

  it('释义：gloss 优先并按 wikiLength 截断，带辨析；没有 gloss 时用 wiki 摘要', () => {
    const gloss = parseGlossDb({ from_above: { g: '一二三四五六七', vs: [['from_below', '仰视']] } })
    const r: SearchResult[] = [
      { query: '俯视', type: '概念', matches: [m('from_above', 1), m('blue_hair', 0.9, { wiki: 'Hair  that is\nblue.' })] },
    ]
    const text = formatSearchResults(r, seriesDb, display({ tagQueryWikiLength: 5 }), gloss)
    expect(text).toContain('     释义: 一二三四五…')
    expect(text).toContain('     区别: from_below=仰视')
    expect(text).toContain('     wiki: Hair')
  })

  it('关掉 wiki 开关的类别既不给释义也不给 wiki 摘要', () => {
    const gloss = parseGlossDb({ saber: { g: '剑士职阶' } })
    const r: SearchResult[] = [{ query: 'saber', type: '角色', matches: [m('saber', 1, { wiki: 'Saber class servant' })] }]
    const text = formatSearchResults(r, seriesDb, display(), gloss)
    expect(text).not.toContain('释义')
    expect(text).not.toContain('wiki')
  })

  it('按 max 截断并注明省略条数；max 为 0 时仍有 60 条硬上限', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => m(`t${i}`, 0.9))
    const five = formatSearchResults([{ query: 'q', type: '概念', matches: many(7) }], seriesDb, display())
    expect(five.match(/^ {2}\d+\. /gm)).toHaveLength(5)
    expect(five).toContain('（另有 2 条同等匹配结果未列出）')
    const hard = formatSearchResults(
      [{ query: 'q', type: '画师', matches: many(65) }],
      seriesDb,
      display({ tagQueryArtistMax: 0 }),
    )
    expect(hard.match(/^ {2}\d+\. /gm)).toHaveLength(60)
    expect(hard).toContain('（另有 5 条同等匹配结果未列出）')
  })

  it('总字符数超过 60000 时丢掉靠后的整块并说明', () => {
    const big = (q: string): SearchResult => ({ query: q, type: '角色', matches: [m('x', 1, { zh: ['字'.repeat(25000)] })] })
    const text = formatSearchResults([big('a'), big('b'), big('c')], seriesDb, display())
    expect(text).toContain('[角色] 查询: "b"')
    expect(text).not.toContain('[角色] 查询: "c"')
    expect(text).toContain('[已达返回上限] 还有 1 条查询的结果未列出')
  })
})
