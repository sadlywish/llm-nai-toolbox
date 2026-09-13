import { describe, expect, it } from 'vitest'
import { displayUnits, tagSpans } from '@shared/tagWrap'

const texts = (text: string) => tagSpans(text).map((s) => text.slice(s.from, s.to))

describe('tagSpans', () => {
  it('一个单位 = 标签连同紧跟它的逗号，逗号后的空格不算进去', () => {
    expect(texts('long hair, silver hair')).toEqual(['long hair,', 'silver hair'])
  })

  it('逗号后紧跟字符时要补折行点，跟空格时不补', () => {
    expect(tagSpans('1girl,solo').map((s) => s.needsBreak)).toEqual([true, false])
    expect(tagSpans('1girl, solo').map((s) => s.needsBreak)).toEqual([false, false])
  })

  it('段末的逗号不补折行点 —— 否则后面的拼接逗号能被折到行首', () => {
    const spans = tagSpans('best quality,')
    expect(texts('best quality,')).toEqual(['best quality,'])
    expect(spans[0].needsBreak).toBe(false)
  })

  it('连着的逗号并进前一个单位，中间只有空白的「空标签」不单独成单位', () => {
    expect(texts('a, , b')).toEqual(['a, ,', 'b'])
  })

  it('逗号前的空白与逗号一起并进单位', () => {
    expect(texts('a ,b')).toEqual(['a ,', 'b'])
    expect(tagSpans('a ,b')[0].needsBreak).toBe(true)
  })

  it('首尾空白不进单位', () => {
    const spans = tagSpans('  a  ')
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({ from: 2, to: 3 })
  })

  it('全角逗号与顿号不是分隔 —— NAI 把它们当普通文字', () => {
    expect(texts('a，b、c, d')).toEqual(['a，b、c,', 'd'])
  })

  it('段首的逗号不属于任何单位', () => {
    expect(texts(',solo')).toEqual(['solo'])
  })

  it('只有空白或逗号时没有单位', () => {
    expect(tagSpans('')).toEqual([])
    expect(tagSpans('   ')).toEqual([])
    expect(tagSpans(' , ,')).toEqual([])
  })

  it('宽度按单位内全部字符计，含逗号', () => {
    expect(tagSpans('多a,b')[0].units).toBe(4)
  })

  it('性质：单位有序不重叠；每个非空白非逗号字符恰好属于一个单位；逗号被吃干净；needsBreak 与定义一致', () => {
    const alphabet = ['a', 'b', ' ', ' ', ',', '多', '，', '　', '(', '_']
    let seed = 7
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let round = 0; round < 2000; round++) {
      const len = Math.floor(rand() * 16)
      let text = ''
      for (let i = 0; i < len; i++) text += alphabet[Math.floor(rand() * alphabet.length)]
      const spans = tagSpans(text)
      const owner = new Array<number>(text.length).fill(-1)
      spans.forEach((s, k) => {
        if (k > 0) expect(s.from).toBeGreaterThanOrEqual(spans[k - 1].to)
        expect(/[\s,]/.test(text[s.from])).toBe(false)
        // 单位后面不能还剩「空白* 逗号」没吃掉
        expect(/^\s*,/.test(text.slice(s.to))).toBe(false)
        expect(s.needsBreak).toBe(text[s.to - 1] === ',' && s.to < text.length && !/\s/.test(text[s.to]))
        for (let i = s.from; i < s.to; i++) owner[i] = k
      })
      for (let i = 0; i < text.length; i++) {
        if (!/[\s,]/.test(text[i])) expect(owner[i], `${JSON.stringify(text)} 第 ${i} 字`).not.toBe(-1)
      }
    }
  })
})

describe('displayUnits', () => {
  it('半角按 1、CJK 等宽字符按 2', () => {
    expect(displayUnits('ab')).toBe(2)
    expect(displayUnits('多a')).toBe(3)
    expect(displayUnits('，')).toBe(2)
    expect(displayUnits('　')).toBe(2)
    expect(displayUnits('ｍ')).toBe(2)
  })
})
