import { describe, expect, it } from 'vitest'
import { POST_BATCH_SIZE, chunkIds, collectPostIds, idsTag } from '@renderer/danbooru/postBatch'
import { parseDText } from '@shared/dtext'

describe('collectPostIds', () => {
  it('收集正文各处（段落、列表、引用、样式里）的 !post，去重并保持先后', () => {
    const doc = parseDText(
      [
        '!post #3 and !post #1',
        '',
        '* item !post #2',
        '* [b]bold !post #3[/b]',
        '',
        '[quote]',
        'quoted !post #4',
        '[/quote]',
      ].join('\n'),
    )
    expect(collectPostIds(doc)).toEqual([3, 1, 2, 4])
  })

  it('没有内嵌图时返回空数组', () => {
    expect(collectPostIds(parseDText('plain text, [[long hair]]'))).toEqual([])
  })
})

describe('chunkIds', () => {
  it('按批大小切开，最后一批可以不满', () => {
    const ids = Array.from({ length: 205 }, (_, i) => i + 1)
    const chunks = chunkIds(ids, POST_BATCH_SIZE)
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 5])
    expect(chunks.flat()).toEqual(ids)
  })

  it('空数组不产生批次', () => {
    expect(chunkIds([], 100)).toEqual([])
  })
})

describe('idsTag', () => {
  it('拼成 Danbooru 的 id 列表元标签', () => {
    expect(idsTag([5691392, 7714836])).toBe('id:5691392,7714836')
  })
})
