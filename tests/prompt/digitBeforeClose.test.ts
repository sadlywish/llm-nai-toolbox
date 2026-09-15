import { describe, expect, it } from 'vitest'
import { findDigitBeforeClose } from '@renderer/prompt/digitBeforeClose'

const marked = (text: string): string[] => findDigitBeforeClose(text).map((h) => text.slice(h.from, h.to))

describe('findDigitBeforeClose', () => {
  it('标签末尾的数字紧贴 :: 被标出，只标数字不含 ::', () => {
    const text = '1.2::artist:as109::'
    expect(findDigitBeforeClose(text)).toEqual([
      expect.objectContaining({ from: 14, to: 17 }),
    ])
    expect(marked(text)).toEqual(['109'])
  })

  it('下划线后的数字、小数、负数同样标出', () => {
    expect(marked('0.8::artist:void_0::')).toEqual(['0'])
    expect(marked('0.8::model_v1.5::')).toEqual(['1.5'])
    expect(marked('0.8::sci-1::')).toEqual(['-1'])
  })

  it('数字前是空格、空格再往前是标签文字，也标出', () => {
    expect(marked('1.1::year 2024::')).toEqual(['2024'])
    expect(marked('year  2024::')).toEqual(['2024'])
    expect(marked('1.1::year\t2024::')).toEqual(['2024'])
  })

  it('正常的权重数字不标：字段开头、分隔符之后、分隔符加空格之后', () => {
    expect(marked('1.2::smile::')).toEqual([])
    expect(marked('1girl, 1.2::smile::')).toEqual([])
    expect(marked('1girl,1.2::smile::')).toEqual([])
    expect(marked('{ 1.2::x::}')).toEqual([])
    expect(marked('[1.2::x::]')).toEqual([])
    expect(marked('a | 1.2::x::')).toEqual([])
    expect(marked('a\n1.2::x::')).toEqual([])
    expect(marked('  1.2::x::')).toEqual([])
    expect(marked('1.2::0.8::x::::')).toEqual([])
  })

  it('数字与 :: 之间隔了空格、或不以数字结尾，都不标', () => {
    expect(marked('1.2::artist:as109 ::')).toEqual([])
    expect(marked('1.1::year 2024 ::')).toEqual([])
    expect(marked('1.5::worst quality::')).toEqual([])
    expect(marked('0.9::artist:sho_(sho_lwlw)::')).toEqual([])
  })

  it('一段里多处命中按位置升序返回', () => {
    expect(marked('1.2::as109::, 0.8::void_0::, 1.1::year 2024::')).toEqual(['109', '0', '2024'])
  })

  it('提示文字带出命中的数字', () => {
    const [hit] = findDigitBeforeClose('1.2::artist:as109::')
    expect(hit.message).toBe('「109::」会被识别为新加权段的起始。若这是标签末尾的数字，请在数字与 :: 之间加一个空格。')
  })
})
