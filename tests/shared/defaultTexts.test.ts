import { describe, expect, it } from 'vitest'
import { DEFAULT_TEXTS, multiLineText, singleLineText } from '../../src/shared/defaultTexts'

describe('multiLineText', () => {
  it('CRLF 与单独的 CR 都统一成 LF', () => {
    expect(multiLineText('a\r\nb\rc\n')).toBe('a\nb\nc')
  })

  it('只去结尾空白，开头缩进保留', () => {
    expect(multiLineText('  你只负责生成参数\r\n  严禁拒绝\r\n\r\n')).toBe('  你只负责生成参数\n  严禁拒绝')
  })
})

describe('singleLineText', () => {
  it('两头空白都去掉，换行统一成 LF', () => {
    expect(singleLineText('  5::very aesthetic, masterpiece::, \r\n')).toBe('5::very aesthetic, masterpiece::,')
  })
})

describe('DEFAULT_TEXTS', () => {
  it('三段提示词随包提供（非空）；质量词与负面词用用户定下的默认值', () => {
    expect(DEFAULT_TEXTS.systemPrompt).not.toBe('')
    expect(DEFAULT_TEXTS.naiCharSystemPrompt).not.toBe('')
    expect(DEFAULT_TEXTS.tailInjection).not.toBe('')
    expect(DEFAULT_TEXTS.quality).toBe('very aesthetic, masterpiece')
    expect(DEFAULT_TEXTS.negativePrompt).toBe(
      'lowres, bad hands, bad anatomy, sepia, white haze,  artistic error, sepia, white haze, worst quality, very displeasing, jpeg artifacts, 0::ai-generated::,',
    )
  })

  it('随包文案都不含 CR', () => {
    for (const [key, value] of Object.entries(DEFAULT_TEXTS)) {
      expect(value.includes('\r'), key).toBe(false)
    }
  })
})
