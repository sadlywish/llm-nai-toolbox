import { describe, expect, it } from 'vitest'
import type { TagEntry } from '@shared/tagdb/search'
import { buildIndex } from '@shared/tagdb/search'
import type { Category, TagdbCategories } from '../../src/main/tagdb/loader'
import { buildCompletionIndex } from '../../src/main/tagdb/loader'
import { lookupTag } from '../../src/main/tagdb/lookup'

const e = (tag: string, count: number, extra: Partial<TagEntry> = {}): TagEntry => ({
  tag, count, zh: [], zhFull: [], zhShort: [], zhNick: [],
  ja: [], en: [], other: [], series: [], ...extra,
})
const cat = (entries: TagEntry[]): Category => ({ entries, index: buildIndex(entries), completionIndex: buildCompletionIndex(entries) })

const CATS: TagdbCategories = {
  artists: cat([e('wlop', 9000, { zh: ['王凌'] })]),
  characters: cat([e('hatsune_miku', 100000, { zh: ['初音未来'], zhFull: ['初音未来', '初音ミク'] })]),
  series: cat([e('arknights', 50000, { zh: ['明日方舟'] })]),
  general: cat([e('long_hair', 950000, { zh: ['长发'] })]),
}

describe('lookupTag', () => {
  it('按精确名命中并给出分类、中文别名、帖子数', () => {
    expect(lookupTag(CATS, 'long_hair')).toEqual({ tag: 'long_hair', category: 'general', zh: ['长发'], count: 950000 })
    expect(lookupTag(CATS, 'arknights')?.category).toBe('series')
    expect(lookupTag(CATS, 'wlop')?.category).toBe('artist')
  })

  it('空格写法、大小写、artist: 与 @ 前缀都归一后再查', () => {
    expect(lookupTag(CATS, 'Long Hair')?.tag).toBe('long_hair')
    expect(lookupTag(CATS, 'artist:wlop')?.tag).toBe('wlop')
    expect(lookupTag(CATS, '@wlop')?.tag).toBe('wlop')
  })

  it('中文别名合并 zh 与 zhFull 并去重，保持先后', () => {
    expect(lookupTag(CATS, 'hatsune miku')?.zh).toEqual(['初音未来', '初音ミク'])
  })

  it('查不到、空串返回 null', () => {
    expect(lookupTag(CATS, 'no_such_tag')).toBeNull()
    expect(lookupTag(CATS, '   ')).toBeNull()
  })
})
