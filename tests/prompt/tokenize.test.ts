import { describe, expect, it } from 'vitest'
import { matchNumberBefore, parsePrompt } from '@renderer/prompt/tokenize'

describe('matchNumberBefore', () => {
  it('识别紧贴在下标之前的小数', () => {
    expect(matchNumberBefore('1.2::x', 3)).toEqual({ start: 0, value: 1.2 })
  })

  it('前面不是数字时返回 null', () => {
    expect(matchNumberBefore('wlop::', 4)).toBeNull()
  })

  it('数字与下标之间有空格时返回 null', () => {
    expect(matchNumberBefore('as109 ::', 6)).toBeNull()
  })

  it('识别标签末尾的数字', () => {
    expect(matchNumberBefore('as109::', 5)).toEqual({ start: 2, value: 109 })
  })

  it('识别负数', () => {
    expect(matchNumberBefore(', -1.5::x', 6)).toEqual({ start: 2, value: -1.5 })
  })

  it('多个小数点时取以下标结尾的最长合法数字', () => {
    expect(matchNumberBefore('1.2.3::', 5)).toEqual({ start: 2, value: 2.3 })
  })
})

describe('parsePrompt — 加权段扫描', () => {
  it('没有权重语法时不产生任何段', () => {
    expect(parsePrompt('1girl, blue sky').spans).toEqual([])
  })

  it('解析单个闭合的加权段', () => {
    const { spans } = parsePrompt('1girl, 1.05::artist:wlop::, blue sky')
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({
      start: 7,
      end: 26,
      depth: 0,
      weight: 1.05,
      numStart: 7,
      numEnd: 11,
      contentStart: 13,
      contentEnd: 24,
      closeStart: 24,
      closed: true,
    })
  })

  it('内容区间正好是被加权的文本', () => {
    const text = '1girl, 1.05::artist:wlop::, blue sky'
    const s = parsePrompt(text).spans[0]
    expect(text.slice(s.contentStart, s.contentEnd)).toBe('artist:wlop')
  })

  it('解析嵌套加权段并标出深度', () => {
    const { spans } = parsePrompt('1.5::a, 1.2::b ::, c::')
    expect(spans).toHaveLength(2)
    expect(spans[0]).toMatchObject({ start: 0, end: 22, depth: 0, weight: 1.5, closed: true })
    expect(spans[1]).toMatchObject({ start: 8, end: 17, depth: 1, weight: 1.2, closed: true })
  })

  it('数字前不是分隔符时不开新段，而是闭合当前段', () => {
    // as109 末尾的 109 是标签的一部分，不是新权重
    const { spans } = parsePrompt('1.2::as109::')
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({ weight: 1.2, closed: true, contentEnd: 10 })
  })

  it('数字与 :: 之间有空格时正常闭合', () => {
    const { spans } = parsePrompt('1.2::as109 ::')
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({ weight: 1.2, closed: true, contentEnd: 11 })
  })

  it('未闭合的段延伸到文本末尾', () => {
    const text = '1.2::artist:wlop'
    const s = parsePrompt(text).spans[0]
    expect(s.closed).toBe(false)
    expect(s.closeStart).toBeNull()
    expect(s.end).toBe(text.length)
    expect(s.contentEnd).toBe(text.length)
  })

  it('artist: 里的单个冒号不会被误认为分隔符', () => {
    expect(parsePrompt('artist:wlop, artist:as109').spans).toEqual([])
  })
})
