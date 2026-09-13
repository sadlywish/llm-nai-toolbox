import { describe, expect, it } from 'vitest'
import {
  NUMBER_RULES,
  RESTORABLE_KEYS,
  defaultAppConfig,
  mergeConfig,
  validateConfig,
  type AppConfig,
} from '@shared/config'
import { DEFAULT_TEXTS } from '@shared/defaultTexts'
import { DEFAULT_CHAR_PROMPT_ORDER, DEFAULT_PROMPT_ORDER } from '@shared/fields'

describe('defaultAppConfig', () => {
  it('每次返回新对象 —— 配置会被就地修改，共享一个对象会连带改掉别处', () => {
    const a = defaultAppConfig()
    a.maxTokens = 1
    expect(defaultAppConfig().maxTokens).toBe(16000)
  })

  it('带默认文案的项取自随包文件', () => {
    const cfg = defaultAppConfig()
    expect(cfg.systemPrompt).toBe(DEFAULT_TEXTS.systemPrompt)
    expect(cfg.naiCharSystemPrompt).toBe(DEFAULT_TEXTS.naiCharSystemPrompt)
    expect(cfg.tailInjection).toBe(DEFAULT_TEXTS.tailInjection)
    expect(cfg.quality).toBe(DEFAULT_TEXTS.quality)
    expect(cfg.negativePrompt).toBe(DEFAULT_TEXTS.negativePrompt)
  })

  it('两个顺序串取 fields.ts 的默认值', () => {
    expect(defaultAppConfig().promptOrder).toBe(DEFAULT_PROMPT_ORDER)
    expect(defaultAppConfig().naiCharPromptOrder).toBe(DEFAULT_CHAR_PROMPT_ORDER)
  })

  it('默认配置本身通过校验', () => {
    expect(validateConfig(defaultAppConfig())).toEqual({})
  })

  it('数值项与 NUMBER_RULES 的键一一对应', () => {
    const cfg = defaultAppConfig()
    const numericKeys = (Object.keys(cfg) as (keyof AppConfig)[]).filter((k) => typeof cfg[k] === 'number')
    expect(Object.keys(NUMBER_RULES).sort()).toEqual([...numericKeys].sort())
  })
})

describe('mergeConfig', () => {
  it('不是对象时整份取默认值', () => {
    expect(mergeConfig(null)).toEqual(defaultAppConfig())
    expect(mergeConfig([1, 2])).toEqual(defaultAppConfig())
    expect(mergeConfig('{}')).toEqual(defaultAppConfig())
  })

  it('缺的项补默认值，已有的项原样保留', () => {
    const cfg = mergeConfig({ model: 'claude-opus-5', maxTokens: 32000 })
    expect(cfg.model).toBe('claude-opus-5')
    expect(cfg.maxTokens).toBe(32000)
    expect(cfg.apiBaseUrl).toBe(defaultAppConfig().apiBaseUrl)
  })

  it('默认文案不回退：存的是空串，读出来就是空串', () => {
    const cfg = mergeConfig({ systemPrompt: '', quality: '', negativePrompt: '', tailInjection: '' })
    expect(cfg.systemPrompt).toBe('')
    expect(cfg.quality).toBe('')
    expect(cfg.negativePrompt).toBe('')
    expect(cfg.tailInjection).toBe('')
  })

  it('类型不对的项回到默认值', () => {
    const cfg = mergeConfig({ maxTokens: '32000', autoSkipSearch: 'yes', proxy: 7890 })
    expect(cfg.maxTokens).toBe(16000)
    expect(cfg.autoSkipSearch).toBe(true)
    expect(cfg.proxy).toBe('')
  })

  it('NaN 与 Infinity 不算数字', () => {
    expect(mergeConfig({ maxTokens: Number.NaN }).maxTokens).toBe(16000)
    expect(mergeConfig({ maxTokens: Number.POSITIVE_INFINITY }).maxTokens).toBe(16000)
  })

  it('不认识的键丢弃', () => {
    expect('enableNltags' in mergeConfig({ enableNltags: true })).toBe(false)
  })

  it('枚举值不在范围内回到默认值', () => {
    const cfg = mergeConfig({ apiType: 'gemini', thinkingFormat: 'auto', thinkingEffort: 'ultra' })
    expect(cfg.apiType).toBe('claude')
    expect(cfg.thinkingFormat).toBe('adaptive')
    expect(cfg.thinkingEffort).toBe('high')
  })

  it('数值违反规则回到默认值 —— 超时 0 秒会让每个请求立刻被自己取消', () => {
    const cfg = mergeConfig({ requestTimeoutSec: 0, tagBrowsePageChars: 100 })
    expect(cfg.requestTimeoutSec).toBe(120)
    expect(cfg.tagBrowsePageChars).toBe(12000)
  })

  it('手改坏的字段顺序回到默认值', () => {
    const cfg = mergeConfig({
      promptOrder: 'count, style',
      naiCharPromptOrder: 'count, count, character, appearance, tags, nltags',
    })
    expect(cfg.promptOrder).toBe(DEFAULT_PROMPT_ORDER)
    expect(cfg.naiCharPromptOrder).toBe(DEFAULT_CHAR_PROMPT_ORDER)
  })

  it('合法的自定义顺序保留', () => {
    const order = 'quality, count, style, character, artist, appearance, tags, environment, series, nltags'
    expect(mergeConfig({ promptOrder: order }).promptOrder).toBe(order)
  })
})

describe('validateConfig', () => {
  const withPatch = (patch: Partial<AppConfig>): AppConfig => ({ ...defaultAppConfig(), ...patch })

  it('数值：下限、上限、整数', () => {
    expect(validateConfig(withPatch({ maxTokens: 0 })).maxTokens).toBeDefined()
    expect(validateConfig(withPatch({ maxTokens: 1.5 })).maxTokens).toBeDefined()
    expect(validateConfig(withPatch({ tagBrowsePageChars: 40001 })).tagBrowsePageChars).toBeDefined()
    expect(validateConfig(withPatch({ tagQueryGeneralMax: 0 })).tagQueryGeneralMax).toBeUndefined()
    expect(validateConfig(withPatch({ requestTimeoutSec: 0.5 })).requestTimeoutSec).toBeDefined()
  })

  it('字段顺序必须恰好包含全部字段', () => {
    expect(validateConfig(withPatch({ promptOrder: 'count' })).promptOrder).toContain('缺少')
    expect(validateConfig(withPatch({ naiCharPromptOrder: 'count, artist' })).naiCharPromptOrder).toBeDefined()
  })

  it('代理地址写错时报出原因', () => {
    expect(validateConfig(withPatch({ proxy: '127.0.0.1' })).proxy).toContain('主机:端口')
  })

  it('API 地址必须是 http(s) 地址', () => {
    expect(validateConfig(withPatch({ apiBaseUrl: '' })).apiBaseUrl).toBeDefined()
    expect(validateConfig(withPatch({ apiBaseUrl: 'api.anthropic.com' })).apiBaseUrl).toBeDefined()
    expect(validateConfig(withPatch({ apiBaseUrl: 'https://proxy.local/v1' })).apiBaseUrl).toBeUndefined()
  })

  it('模型名不能为空白', () => {
    expect(validateConfig(withPatch({ model: '  ' })).model).toBeDefined()
  })
})

describe('RESTORABLE_KEYS', () => {
  it('只含带随包默认值的五个文本项与两个顺序串（规格 §14.2）', () => {
    expect([...RESTORABLE_KEYS].sort()).toEqual(
      [
        'naiCharPromptOrder',
        'naiCharSystemPrompt',
        'negativePrompt',
        'promptOrder',
        'quality',
        'systemPrompt',
        'tailInjection',
      ].sort(),
    )
  })
})
