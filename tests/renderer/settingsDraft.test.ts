import { describe, expect, it } from 'vitest'
import { NUMBER_RULES, defaultAppConfig, type NumericKey } from '@shared/config'
import { flattenLineBreaks, isSettingsDirty, numericTextFrom } from '@renderer/settingsDraft'

const NO_SECRETS = ['', '', '']

function clean() {
  const saved = defaultAppConfig()
  return { saved, state: { draft: saved, numericText: numericTextFrom(saved), secrets: NO_SECRETS } }
}

describe('numericTextFrom', () => {
  it('每个数值项都有原文，且就是存下的值', () => {
    const cfg = { ...defaultAppConfig(), maxTokens: 12345 }
    const text = numericTextFrom(cfg)
    expect(Object.keys(text).sort()).toEqual(Object.keys(NUMBER_RULES).sort())
    expect(text.maxTokens).toBe('12345')
  })
})

describe('isSettingsDirty', () => {
  it('草稿、原文、密钥框都和已保存一致：没改', () => {
    const { saved, state } = clean()
    expect(isSettingsDirty(state, saved)).toBe(false)
  })

  it('草稿是内容相同的新对象（保存后的快照）：没改', () => {
    const { saved, state } = clean()
    expect(isSettingsDirty({ ...state, draft: { ...saved } }, saved)).toBe(false)
  })

  it('改了任一字符串项：算改过', () => {
    const { saved, state } = clean()
    expect(isSettingsDirty({ ...state, draft: { ...saved, quality: saved.quality + 'x' } }, saved)).toBe(true)
  })

  it('改了开关项：算改过', () => {
    const { saved, state } = clean()
    expect(isSettingsDirty({ ...state, draft: { ...saved, thinkingEnabled: !saved.thinkingEnabled } }, saved)).toBe(true)
  })

  it('配置里最后一项被改也能发现（不是只看前几项）', () => {
    const { saved, state } = clean()
    const keys = Object.keys(saved) as (keyof typeof saved)[]
    const last = keys[keys.length - 1]
    const changed = { ...saved, [last]: typeof saved[last] === 'number' ? (saved[last] as number) + 1 : typeof saved[last] === 'boolean' ? !saved[last] : `${String(saved[last])}x` }
    expect(isSettingsDirty({ ...state, draft: changed }, saved)).toBe(true)
  })

  it('数值框里是半截输入（草稿还攥着旧值）：算改过', () => {
    const { saved, state } = clean()
    const key: NumericKey = 'maxTokens'
    expect(isSettingsDirty({ ...state, numericText: { ...state.numericText, [key]: '1e' } }, saved)).toBe(true)
  })

  it('任一密钥框有输入：算改过', () => {
    const { saved, state } = clean()
    expect(isSettingsDirty({ ...state, secrets: ['', '', 'k'] }, saved)).toBe(true)
    expect(isSettingsDirty({ ...state, secrets: ['k', '', ''] }, saved)).toBe(true)
  })
})

describe('flattenLineBreaks', () => {
  it('LF、CRLF、单独的 CR 各换成一个空格', () => {
    expect(flattenLineBreaks('a\nb\r\nc\rd')).toBe('a b c d')
  })

  it('没有换行时原样返回', () => {
    expect(flattenLineBreaks('very aesthetic,  masterpiece')).toBe('very aesthetic,  masterpiece')
  })
})
