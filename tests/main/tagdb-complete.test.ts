import { describe, expect, it } from 'vitest'
import type { TagEntry } from '@shared/tagdb/search'
import { buildIndex } from '@shared/tagdb/search'
import type { Category, TagdbCategories } from '../../src/main/tagdb/loader'
import { buildCompletionIndex } from '../../src/main/tagdb/loader'
import { completeFrom, fullMatchEnabled } from '../../src/main/tagdb/complete'

const e = (tag: string, count: number, extra: Partial<TagEntry> = {}): TagEntry => ({
  tag, count, zh: [], zhFull: [], zhShort: [], zhNick: [],
  ja: [], en: [], other: [], series: [], ...extra,
})
const cat = (entries: TagEntry[]): Category => ({
  entries,
  index: buildIndex(entries),
  completionIndex: buildCompletionIndex(entries),
})

/** 六十个都以 blue_thing 开头的通用标签，用来验「全量返回、不截断」 */
const MANY = cat(Array.from({ length: 60 }, (_, i) => e(`blue_thing_${i}`, 100000 - i * 100)))

const CATS: TagdbCategories = {
  artists: cat([e('wlop', 9000), e('wlop_(fanart)', 100)]),
  characters: cat([
    e('hatsune_miku', 100000, { zh: ['初音未来'] }),
    e('cos_hatsune', 300, { zh: ['cos初音'] }),
  ]),
  series: cat([e('arknights', 50000, { zh: ['明日方舟'] })]),
  general: cat([
    e('long_hair', 950000, { zh: ['长发'] }),
    e('blue_hair', 800000, { zh: ['蓝发'] }),
    e('blue_eyes', 700000, { zh: ['蓝眼'] }),
    e('dress', 500000, { zh: ['连衣裙'] }),
    e('red_dress', 120000, { zh: ['红裙'] }),
    e('sundress', 60000, { zh: ['背心裙'] }),
  ]),
}

describe('fullMatchEnabled：档 2 的门槛', () => {
  it('非 CJK 要 3 个字符起', () => {
    expect(fullMatchEnabled('dr')).toBe(false)
    expect(fullMatchEnabled('dre')).toBe(true)
  })

  it('含 CJK 的 2 个字符就够 —— CJK 名字建了 bigram', () => {
    expect(fullMatchEnabled('初')).toBe(false)
    expect(fullMatchEnabled('初音')).toBe(true)
  })
})

describe('completeFrom：类别路由', () => {
  it('prefer=artist 只在画师类里搜', () => {
    expect(completeFrom(CATS, 'wlop', 'artist').map((i) => i.tag)).toEqual([
      'wlop', 'wlop_(fanart)',
    ])
  })

  it('prefer=character 只在角色类里搜', () => {
    expect(completeFrom(CATS, '初音', 'character')[0].tag).toBe('hatsune_miku')
  })

  it('prefer=series 只在作品类里搜', () => {
    expect(completeFrom(CATS, '明日方舟', 'series')[0].tag).toBe('arknights')
  })

  it('类别之间不串 —— general 里搜不出画师', () => {
    expect(completeFrom(CATS, 'wlop', 'general')).toEqual([])
  })
})

describe('completeFrom：档 1 词首命中', () => {
  it('名字开头命中', () => {
    expect(completeFrom(CATS, 'blue', 'general').map((i) => i.tag)).toEqual([
      'blue_hair', 'blue_eyes',
    ])
  })

  it('第二个词的开头也命中 —— 这是词首匹配和整名前缀的关键区别', () => {
    expect(completeFrom(CATS, 'hair', 'general').map((i) => i.tag)).toEqual([
      'long_hair', 'blue_hair',
    ])
  })

  it('下划线与空格等价 —— 用户打空格也能命中', () => {
    expect(completeFrom(CATS, 'blue h', 'general').map((i) => i.tag)).toEqual(['blue_hair'])
    expect(completeFrom(CATS, 'blue_h', 'general').map((i) => i.tag)).toEqual(['blue_hair'])
  })

  it('括号后的词也算词首', () => {
    expect(completeFrom(CATS, 'fan', 'artist').map((i) => i.tag)).toEqual(['wlop_(fanart)'])
  })

  it('译名也参与匹配', () => {
    expect(completeFrom(CATS, '蓝发', 'general').map((i) => i.tag)).toEqual(['blue_hair'])
  })

  it('不分大小写', () => {
    expect(completeFrom(CATS, 'BLUE', 'general').map((i) => i.tag)).toEqual([
      'blue_hair', 'blue_eyes',
    ])
  })

  it('一个条目多个名字同时命中时只出一次', () => {
    const dup = cat([e('blue_hair', 5000, { en: ['blue hair'], zh: ['blue hair'] })])
    expect(completeFrom({ ...CATS, general: dup }, 'blue', 'general')).toHaveLength(1)
  })
})

describe('completeFrom：档 2 完整检索捞回词中间的子串', () => {
  it('查 ress 能命中 red_dress 与 sundress —— 词首档一个都给不了', () => {
    // 实测分数：dress=1、red_dress=0.98、sundress=0.98
    expect(completeFrom(CATS, 'ress', 'general').map((i) => i.tag)).toEqual([
      'dress', 'red_dress', 'sundress',
    ])
  })

  it('词首命中排在档 2 命中之前，哪怕档 2 的图数更高', () => {
    // dres 的词首命中：dress(500000)、red_dress(120000)；
    // sundress(60000) 只能靠档 2，所以排最后
    expect(completeFrom(CATS, 'dres', 'general').map((i) => i.tag)).toEqual([
      'dress', 'red_dress', 'sundress',
    ])
  })

  it('同一条目不会因为两档都命中而出现两次', () => {
    const items = completeFrom(CATS, 'dress', 'general')
    expect(new Set(items.map((i) => i.tag)).size).toBe(items.length)
  })

  it('门槛不过时只有词首档 —— 2 个拉丁字符捞不回子串', () => {
    // 'dr' 只有 2 个字符，档 2 不开；dress 与 red_dress 是词首命中
    expect(completeFrom(CATS, 'dr', 'general').map((i) => i.tag)).toEqual([
      'dress', 'red_dress',
    ])
  })

  it('档 2 不做拼写纠错 —— trigram 预筛先把错字筛掉了', () => {
    // bleu 的 trigram 是 ble/leu，blue_hair 索引的是 blu/lue/ueh…，交集为空
    expect(completeFrom(CATS, 'bleu', 'general')).toEqual([])
  })
})

describe('completeFrom：单字符查询只有词首档', () => {
  it('单个拉丁字符给出所有词首命中，按图数降序', () => {
    expect(completeFrom(CATS, 'b', 'general').map((i) => i.tag)).toEqual([
      'blue_hair', 'blue_eyes',
    ])
  })

  it('单字符要并起所有以它开头的桶 —— 桶键是两个字符的', () => {
    const spread = cat([e('ba', 300), e('bz_thing', 200), e('cat', 100)])
    expect(completeFrom({ ...CATS, general: spread }, 'b', 'general').map((i) => i.tag)).toEqual([
      'ba', 'bz_thing',
    ])
  })

  it('单字符不认词中间', () => {
    // long_hair 里的 'o' 在词中间；'d' 在 dress/red_dress 的词首
    expect(completeFrom(CATS, 'o', 'general')).toEqual([])
    expect(completeFrom(CATS, 'd', 'general').map((i) => i.tag)).toEqual(['dress', 'red_dress'])
  })
})

describe('completeFrom：CJK', () => {
  it('单个 CJK 字符就已经是任意位置匹配 —— CJK 字符本身不是 a-z，每个位置都算词首', () => {
    expect(completeFrom(CATS, '发', 'general').map((i) => i.tag)).toEqual([
      'long_hair', 'blue_hair',
    ])
  })

  it('CJK 紧跟在拉丁字母之后也能命中 —— 字母/非字母的边界就是词首', () => {
    // 'cos初音' 里 初 的前一个字符是 s，但 s 是字母而 初 不是，边界成立
    expect(completeFrom(CATS, '初音', 'character').map((i) => i.tag)).toEqual([
      'hatsune_miku', 'cos_hatsune',
    ])
  })
})

describe('completeFrom：排序与全量返回', () => {
  it('折叠后与查询完全相等的排最前，哪怕图数低得多', () => {
    const exact = cat([e('hair_ornament', 900000), e('hair', 10)])
    expect(completeFrom({ ...CATS, general: exact }, 'hair', 'general').map((i) => i.tag)).toEqual([
      'hair', 'hair_ornament',
    ])
  })

  it('别名与查询完全相等也算 exact', () => {
    const exact = cat([e('hair_ornament', 900000), e('kamikazari', 10, { en: ['hair'] })])
    expect(completeFrom({ ...CATS, general: exact }, 'hair', 'general')[0].tag).toBe('kamikazari')
  })

  it('默认不截断 —— 六十个都命中就给六十个', () => {
    expect(completeFrom({ ...CATS, general: MANY }, 'blue', 'general')).toHaveLength(60)
  })

  it('传了 limit 才截断，截的是排序后的前 N', () => {
    const items = completeFrom({ ...CATS, general: MANY }, 'blue', 'general', 3)
    expect(items.map((i) => i.count)).toEqual([100000, 99900, 99800])
  })

  it('limit 大于命中数时不补齐，按实际给', () => {
    expect(completeFrom(CATS, 'blue', 'general', 999)).toHaveLength(2)
  })
})

describe('completeFrom：边界', () => {
  it('空查询词返回空，不去搜', () => {
    expect(completeFrom(CATS, '   ', 'general')).toEqual([])
  })

  it('折叠后只剩下划线的查询不当成「全都命中」', () => {
    expect(completeFrom(CATS, '_', 'general')).toEqual([])
  })

  it('毫无关系的查询词不硬凑候选', () => {
    expect(completeFrom(CATS, 'zzzzqqqq', 'general')).toEqual([])
  })

  it('返回项带上 count / zh / series，供下拉显示', () => {
    const item = completeFrom(CATS, 'blue h', 'general')[0]
    expect(item.count).toBe(800000)
    expect(item.zh).toEqual(['蓝发'])
    expect(item.series).toEqual([])
  })

  it('返回项不带 score —— 分档与分数是内部排序用的，不出接口', () => {
    expect(completeFrom(CATS, 'blue', 'general')[0]).not.toHaveProperty('score')
  })
})
