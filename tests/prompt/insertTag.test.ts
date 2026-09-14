import { describe, expect, it } from 'vitest'
import { cleanCursorWord, formatWikiTag, insertTagAt } from '@renderer/prompt/insertTag'

describe('formatWikiTag', () => {
  it('画师加 artist: 前缀、下划线换空格，已有前缀或 @ 不重复', () => {
    expect(formatWikiTag('manzai_sugar', true)).toBe('artist:manzai sugar')
    expect(formatWikiTag('artist:wlop', true)).toBe('artist:wlop')
    expect(formatWikiTag('@wlop', true)).toBe('artist:wlop')
  })

  it('标签只把下划线换空格', () => {
    expect(formatWikiTag('long_hair', false)).toBe('long hair')
    expect(formatWikiTag('hatsune_miku_(cosplay)', false)).toBe('hatsune miku (cosplay)')
  })
})

describe('insertTagAt', () => {
  it('空字段直接写入', () => {
    expect(insertTagAt('', 0, 'smile')).toEqual({ text: 'smile', cursor: 5 })
  })

  it('末尾：补「, 」', () => {
    expect(insertTagAt('a, b', 4, 'smile')).toEqual({ text: 'a, b, smile', cursor: 11 })
  })

  it('光标在标签上：插到该标签之后，不劈开它', () => {
    expect(insertTagAt('a, b', 0, 'smile')).toEqual({ text: 'a, smile, b', cursor: 8 })
    expect(insertTagAt('long hair, smile', 3, 'x')).toEqual({ text: 'long hair, x, smile', cursor: 12 })
  })

  it('逗号后已有空格或只有逗号时不重复补逗号', () => {
    expect(insertTagAt('a, ', 3, 'smile')).toEqual({ text: 'a, smile', cursor: 8 })
    expect(insertTagAt('a,', 2, 'smile')).toEqual({ text: 'a, smile', cursor: 8 })
  })

  it('权重组里的标签：插在该标签之后、组内', () => {
    expect(insertTagAt('1.2::a, b::', 6, 'smile')).toEqual({ text: '1.2::a, smile, b::', cursor: 13 })
  })

  it('位置越界时夹到文本范围内', () => {
    expect(insertTagAt('a', 99, 'b')).toEqual({ text: 'a, b', cursor: 4 })
  })
})

describe('cleanCursorWord', () => {
  it('去掉花括号与方括号强调、首尾空白；圆括号是 tag 名的一部分，保留', () => {
    expect(cleanCursorWord(' {{long hair}} ')).toBe('long hair')
    expect(cleanCursorWord('[smile]')).toBe('smile')
    expect(cleanCursorWord('hatsune miku (cosplay)')).toBe('hatsune miku (cosplay)')
  })

  it('纯数字（权重值）不算词', () => {
    expect(cleanCursorWord('1.2')).toBe('')
    expect(cleanCursorWord('-0.5')).toBe('')
  })

  it('保留 artist: 前缀（判定画师源要用）', () => {
    expect(cleanCursorWord('artist:wlop')).toBe('artist:wlop')
  })
})
