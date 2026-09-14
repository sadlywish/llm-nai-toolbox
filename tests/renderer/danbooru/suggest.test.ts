import { describe, expect, it } from 'vitest'
import type { DanbooruArtistSearchItem } from '@shared/danbooru'
import type { CompletionItem } from '@shared/ipc'
import { looksLikeLinkQuery, mergeArtistSuggestions, mergeTagSuggestions } from '@renderer/danbooru/suggest'

const local = (tag: string, count: number, zh: string[] = []): CompletionItem => ({ tag, count, zh, series: [] })
const remote = (name: string): DanbooruArtistSearchItem => ({ name, otherNames: [], urls: [] })

describe('looksLikeLinkQuery（移植自工具箱）', () => {
  it('协议头、www.、域名+路径算链接', () => {
    expect(looksLikeLinkQuery('https://x.com/a')).toBe(true)
    expect(looksLikeLinkQuery('www.pixiv.net')).toBe(true)
    expect(looksLikeLinkQuery('pixiv.net/users/123')).toBe(true)
  })

  it('普通画师名、空串不算', () => {
    expect(looksLikeLinkQuery('wlop')).toBe(false)
    expect(looksLikeLinkQuery('as109')).toBe(false)
    expect(looksLikeLinkQuery('  ')).toBe(false)
  })
})

describe('mergeArtistSuggestions', () => {
  it('本地名字在前、带中文别名与帖子数；D 站别名/链接两路按归一名去重并累积命中维度', () => {
    const out = mergeArtistSuggestions(
      [local('wlop', 1562, ['王凌'])],
      [remote('wlop'), remote('ghostblade_artist')],
      [remote('ghostblade_artist')],
    )
    expect(out).toEqual([
      { tag: 'wlop', label: 'wlop', zh: ['王凌'], count: 1562, matchedBy: ['name', 'alias'] },
      { tag: 'ghostblade_artist', label: 'ghostblade artist', zh: [], count: null, matchedBy: ['alias', 'url'] },
    ])
  })

  it('去重键忽略大小写与空格/下划线差异', () => {
    const out = mergeArtistSuggestions([local('manzai_sugar', 10)], [remote('Manzai Sugar')], [])
    expect(out).toHaveLength(1)
    expect(out[0].matchedBy).toEqual(['name', 'alias'])
  })
})

describe('mergeTagSuggestions', () => {
  it('多个分类的本地结果合并、按帖子数降序、去重、截断', () => {
    const out = mergeTagSuggestions(
      [
        [local('twintails', 1200000, ['双马尾']), local('twin_braids', 98000)],
        [local('twintails', 1200000, ['双马尾'])],
        [local('twin_drills', 31000)],
      ],
      2,
    )
    expect(out).toEqual([
      { tag: 'twintails', label: 'twintails', zh: ['双马尾'], count: 1200000, matchedBy: [] },
      { tag: 'twin_braids', label: 'twin braids', zh: [], count: 98000, matchedBy: [] },
    ])
  })
})
