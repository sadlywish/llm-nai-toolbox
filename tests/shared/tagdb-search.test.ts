import { describe, expect, it } from 'vitest'
import type { TagEntry } from '@shared/tagdb/search'
import {
  buildIndex,
  collectNames,
  getCandidates,
  matchEntry,
  normalize,
  searchCategory,
} from '@shared/tagdb/search'

/** 造条目。真实数据里 zhFull/zhShort/zhNick 不存在，由加载器补空数组，这里照做 */
function entry(tag: string, count: number, extra: Partial<TagEntry> = {}): TagEntry {
  return {
    tag, count,
    zh: [], zhFull: [], zhShort: [], zhNick: [],
    ja: [], en: [], other: [], series: [],
    ...extra,
  }
}

const ENTRIES: TagEntry[] = [
  entry('hatsune_miku', 100000, { zh: ['初音未来'], ja: ['初音ミク'], en: ['hatsune miku'] }),
  entry('kasane_teto', 20000, { zh: ['重音teto'], en: ['kasane teto'] }),
  entry('skadi_(arknights)', 30000, { zh: ['斯卡蒂'], series: ['arknights'] }),
  entry('blue_hair', 500000, { zh: ['蓝发'], en: ['blue hair'] }),
]
const IDX = buildIndex(ENTRIES)

describe('normalize', () => {
  it('把日文新字体/繁体归一到简体', () => {
    // 「戦」→「战」在 CJK 变体表里
    expect(normalize('戦')).toBe(normalize('战'))
  })

  it('大小写归一，且空格/下划线/括号一律删掉（不是互换）', () => {
    expect(normalize('Blue Hair')).toBe(normalize('blue_hair'))
    expect(normalize('skadi (arknights)')).toBe('skadiarknights')
  })
})

describe('searchCategory', () => {
  it('英文 tag 名精确命中，分数最高', () => {
    const r = searchCategory(ENTRIES, 'hatsune_miku', '角色', IDX)
    expect(r.matches[0].tag).toBe('hatsune_miku')
    expect(r.matches[0].score).toBeGreaterThanOrEqual(0.95)
  })

  it('中文别名能命中', () => {
    const r = searchCategory(ENTRIES, '初音未来', '角色', IDX)
    expect(r.matches[0].tag).toBe('hatsune_miku')
  })

  it('日文别名能命中', () => {
    const r = searchCategory(ENTRIES, '初音ミク', '角色', IDX)
    expect(r.matches[0].tag).toBe('hatsune_miku')
  })

  it('拼写错一个字母仍能命中（Levenshtein 那一层）', () => {
    const r = searchCategory(ENTRIES, 'hatsune_mika', '角色', IDX)
    expect(r.matches[0].tag).toBe('hatsune_miku')
  })

  it('返回值带上 count 与 series，供界面显示', () => {
    const r = searchCategory(ENTRIES, 'skadi', '角色', IDX)
    expect(r.matches[0].tag).toBe('skadi_(arknights)')
    expect(r.matches[0].count).toBe(30000)
    expect(r.matches[0].series).toEqual(['arknights'])
  })

  it('查询词与库里毫无关系时不硬凑高分', () => {
    const r = searchCategory(ENTRIES, 'zzzzzzzzqqqq', '概念', IDX)
    expect(r.matches.length === 0 || r.matches[0].score < 0.5).toBe(true)
  })

  it('query 与 type 原样回填在结果上', () => {
    const r = searchCategory(ENTRIES, 'blue hair', '概念', IDX)
    expect(r.query).toBe('blue hair')
    expect(r.type).toBe('概念')
  })

  it('不传索引也能工作 —— 退化成全表扫描，结果一致', () => {
    const withIdx = searchCategory(ENTRIES, '初音未来', '角色', IDX)
    const noIdx = searchCategory(ENTRIES, '初音未来', '角色')
    expect(noIdx.matches[0].tag).toBe(withIdx.matches[0].tag)
  })
})

describe('buildIndex / getCandidates', () => {
  it('索引覆盖全部条目', () => {
    expect(IDX.entries).toHaveLength(ENTRIES.length)
  })

  it('倒排表非空', () => {
    expect(IDX.trigrams.size).toBeGreaterThan(0)
  })

  it('getCandidates 预筛出的下标都能在 entries 里取到条目', () => {
    const cand = getCandidates(IDX, '初音未来')
    expect(cand).not.toBeNull()
    for (const i of cand!) expect(ENTRIES[i]).toBeDefined()
  })
})

describe('matchEntry', () => {
  it('tag 名精确命中给高分', () => {
    const e = ENTRIES.find((x) => x.tag === 'hatsune_miku')!
    expect(matchEntry('hatsune_miku', e).score).toBeGreaterThanOrEqual(0.95)
  })

  it('毫不相关时给低分', () => {
    const e = ENTRIES.find((x) => x.tag === 'hatsune_miku')!
    expect(matchEntry('zzzzqqqq', e).score).toBeLessThan(0.5)
  })
})

describe('collectNames', () => {
  it('把 tag 与各语言别名一并收集，供打分与索引共用', () => {
    const e = ENTRIES.find((x) => x.tag === 'hatsune_miku')!
    const names = collectNames(e)
    expect(names).toContain('hatsune_miku')
    expect(names.some((n) => n.includes('初音'))).toBe(true)
  })
})
