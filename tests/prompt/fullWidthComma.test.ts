import { describe, expect, it } from 'vitest'
import { findFullWidthCommas, fullWidthCommaMessage } from '@renderer/prompt/fullWidthComma'

describe('findFullWidthCommas', () => {
  it('全角逗号被标出，半角逗号不被标出', () => {
    expect(findFullWidthCommas('artist:a，artist:b')).toEqual([{ from: 8, to: 9, char: '，' }])
    expect(findFullWidthCommas('artist:a, artist:b')).toEqual([])
  })

  it('顿号同样标出——中文输入法下同样极易误打', () => {
    expect(findFullWidthCommas('a、b')).toEqual([{ from: 1, to: 2, char: '、' }])
  })

  it('多个命中按位置升序返回', () => {
    expect(findFullWidthCommas('a，b、c').map((h) => h.from)).toEqual([1, 3])
  })

  it('没有命中时返回空数组', () => {
    expect(findFullWidthCommas('0.6::artist:wlop::, 1girl')).toEqual([])
  })

  it('句号、冒号等其他全角标点不误报——只管分隔符这一类', () => {
    expect(findFullWidthCommas('a。b：c；d')).toEqual([])
  })

  it('空串安全', () => {
    expect(findFullWidthCommas('')).toEqual([])
  })

  it('提示文案里带上具体是哪个字符', () => {
    expect(fullWidthCommaMessage('，')).toContain('「，」')
    expect(fullWidthCommaMessage('、')).toContain('「、」')
  })
})
