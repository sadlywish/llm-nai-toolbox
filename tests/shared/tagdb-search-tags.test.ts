import { describe, expect, it } from 'vitest'
import { buildIndex, searchTags, type SearchCategories, type TagEntry } from '../../src/shared/tagdb/search'

const e = (tag: string, count: number, extra: Partial<TagEntry> = {}): TagEntry => ({
  tag, count, zh: [], zhFull: [], zhShort: [], zhNick: [], ja: [], en: [], other: [], series: [], ...extra,
})

function cats(): SearchCategories {
  const mk = (entries: TagEntry[]) => ({ entries, index: buildIndex(entries) })
  return {
    artists: mk([e('wlop', 9000, { en: ['wlop'] })]),
    characters: mk([
      e('saber_(fate)', 100, { series: ['fate_(series)'] }),
      e('saber_(kancolle)', 900, { series: ['kantai_collection'] }),
      e('hatsune_miku', 5000, { zh: ['初音未来'] }),
    ]),
    series: mk([
      e('fate_(series)', 3000, { zh: ['Fate系列'] }),
      e('kantai_collection', 4000, { zh: ['舰队Collection'] }),
    ]),
    general: mk([e('blue_hair', 800, { zh: ['蓝发'] }), e('from_above', 300, { zh: ['俯视'] })]),
  }
}

describe('searchTags', () => {
  it('四类各查各的库，type 标对', () => {
    const r = searchTags(cats(), undefined, ['wlop'], [{ name: '初音未来' }], ['蓝发'], ['Fate系列'])
    expect(r.map((x) => x.type)).toEqual(['画师', '角色', '概念', '作品'])
    expect(r.map((x) => x.matches[0]?.tag)).toEqual(['wlop', 'hatsune_miku', 'blue_hair', 'fate_(series)'])
  })

  it('同名角色：不带作品提示时按分数与图数混排；带作品提示时作品对得上的排第一', () => {
    const noHint = searchTags(cats(), undefined, [], [{ name: 'saber' }])
    expect(noHint[0].matches.map((m) => m.tag)).toEqual(['saber_(kancolle)', 'saber_(fate)'])
    const withHint = searchTags(cats(), undefined, [], [{ name: 'saber', series: 'fate' }])
    expect(withHint[0].matches[0].tag).toBe('saber_(fate)')
    expect(withHint[0].matches[0].score).toBe(1)
  })

  it('作品提示的三种调整各自生效：角色作品对上加分、对不上扣分、标签括号里的作品名加分；作品名也能按中文别名认', () => {
    const mk = (entries: TagEntry[]) => ({ entries, index: buildIndex(entries) })
    // 基础分：archer_(fate_grand_order) 0.96、arche 0.88、archr 0.96，都没到 1.0，加减分看得出来
    const hinted: SearchCategories = {
      artists: mk([]),
      characters: mk([
        e('archer_(fate_grand_order)', 10),
        e('arche', 20, { series: ['fate'] }),
        e('archr', 30, { series: ['kantai_collection'] }),
      ]),
      series: mk([e('fate', 3000, { zh: ['命运'] }), e('kantai_collection', 4000)]),
      general: mk([]),
    }
    const scores = (series?: string) =>
      Object.fromEntries(
        searchTags(hinted, undefined, [], [series ? { name: 'archer', series } : { name: 'archer' }])[0].matches.map((m) => [
          m.tag,
          m.score,
        ]),
      )
    expect(scores()).toEqual({ 'archer_(fate_grand_order)': 0.96, arche: 0.88, archr: 0.96 })
    expect(scores('fate')).toEqual({ 'archer_(fate_grand_order)': 1, arche: 0.93, archr: 0.93 })
    expect(scores('命运')).toEqual({ 'archer_(fate_grand_order)': 1, arche: 0.93, archr: 0.93 })
  })

  it('分类内没有高置信结果时，按标签原名在全部类别里精确回退并改正 type', () => {
    const [r] = searchTags(cats(), undefined, ['blue hair'])
    expect(r.type).toBe('概念')
    expect(r.matches).toHaveLength(1)
    expect(r.matches[0]).toMatchObject({ tag: 'blue_hair', score: 1 })
  })

  it('入参形状不可信：null、数字、空名字混进来不抛错', () => {
    const r = searchTags(cats(), undefined, [null, 42], ['初音未来', { name: '' }], [undefined])
    expect(r.map((x) => x.query)).toEqual(['42', '初音未来'])
    expect(r[1].matches[0].tag).toBe('hatsune_miku')
  })

  it('wiki 原文从 wikiMap 原样带出', () => {
    const [r] = searchTags(cats(), new Map([['hatsune_miku', 'Vocaloid 歌手']]), [], ['初音未来'])
    expect(r.matches[0].wiki).toBe('Vocaloid 歌手')
  })
})
