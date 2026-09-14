import { describe, expect, it, vi } from 'vitest'
import {
  NUMBER_RULES,
  RESTORABLE_KEYS,
  defaultAppConfig,
  extraParamsError,
  mergeConfig,
  parseExtraParams,
  validateConfig,
  type AppConfig,
} from '@shared/config'
import { DEFAULT_TEXTS } from '@shared/defaultTexts'
import { DEFAULT_CHAR_PROMPT_ORDER, DEFAULT_PROMPT_ORDER } from '@shared/fields'

// 「默认文案不回退」类断言要求 DEFAULT_TEXTS 各项非空，否则与「取自默认值」
// 的路径写出同一个空串，测不出区分力。随包文案可能被改动（包括清空），
// 这里 mock 成固定的短串，断言不随文案内容漂移。
vi.mock('../../src/shared/defaultTexts', () => ({
  DEFAULT_TEXTS: {
    systemPrompt: 'SYS',
    naiCharSystemPrompt: 'CHR',
    tailInjection: 'TAIL',
    quality: 'Q',
    negativePrompt: 'NEG',
  },
}))

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

  it('用户定下的默认值（V5 角色上限、出图节奏、工具循环、标签查询）', () => {
    expect(defaultAppConfig()).toMatchObject({
      naiMaxCharacters: 22,
      naiTimeoutSec: 120,
      taskIntervalMs: 500,
      historyDays: 30,
      maxToolRounds: 10,
      tagBrowsePageChars: 12000,
      autoSkipSearch: false,
      tagManualEnabled: true,
      tagQueryCharacterMax: 0,
      tagQueryCharacterAliases: true,
      tagQueryCharacterWiki: true,
      tagQueryCharacterSeries: true,
      tagQueryCharacterAppearance: true,
      tagQueryCharacterClothing: false,
      tagQueryArtistMax: 0,
      tagQueryArtistAliases: true,
      tagQueryArtistWiki: false,
      tagQueryGeneralMax: 5,
      tagQueryGeneralAliases: true,
      tagQueryGeneralWiki: true,
      tagQuerySeriesMax: 5,
      tagQuerySeriesAliases: true,
      tagQuerySeriesWiki: false,
      tagQueryWikiLength: 300,
    })
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
    expect(cfg.autoSkipSearch).toBe(defaultAppConfig().autoSkipSearch)
    expect(cfg.proxy).toBe('')
  })

  it('NaN 与 Infinity 不算数字', () => {
    expect(mergeConfig({ maxTokens: Number.NaN }).maxTokens).toBe(16000)
    expect(mergeConfig({ maxTokens: Number.POSITIVE_INFINITY }).maxTokens).toBe(16000)
  })

  it('不认识的键丢弃', () => {
    expect('enableNltags' in mergeConfig({ enableNltags: true })).toBe(false)
    // 已废弃的角色默认负面词：旧配置里存着的值读进来就丢掉
    expect('naiCharDefaultNegative' in mergeConfig({ naiCharDefaultNegative: 'lowres' })).toBe(false)
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

describe('NovelAI 设置项', () => {
  it('默认值（间隔与历史天数按用户配置）', () => {
    const c = defaultAppConfig()
    expect([c.naiBaseUrl, c.saveDir, c.imageFormat, c.naiTimeoutSec, c.retryCount, c.taskIntervalMs, c.historyDays]).toEqual([
      'https://image.novelai.net',
      '',
      'png',
      120,
      2,
      500,
      30,
    ])
  })

  it('图片格式不在范围内回到 png', () => {
    expect(mergeConfig({ imageFormat: 'jpg' }).imageFormat).toBe('png')
    expect(mergeConfig({ imageFormat: 'webp' }).imageFormat).toBe('webp')
  })

  it('接口地址必须是 http(s)', () => {
    expect(validateConfig({ ...defaultAppConfig(), naiBaseUrl: 'image.novelai.net' }).naiBaseUrl).toBe('要写成 http:// 或 https:// 开头的地址')
    expect(validateConfig(defaultAppConfig()).naiBaseUrl).toBeUndefined()
  })

  it('数值规则：重试次数与任务间隔可为 0，超时与历史天数至少 1', () => {
    const errs = validateConfig({ ...defaultAppConfig(), retryCount: 0, taskIntervalMs: 0, naiTimeoutSec: 0, historyDays: 0 })
    expect(errs.retryCount).toBeUndefined()
    expect(errs.taskIntervalMs).toBeUndefined()
    expect(errs.naiTimeoutSec).toBe('不能小于 1')
    expect(errs.historyDays).toBe('不能小于 1')
    expect(validateConfig({ ...defaultAppConfig(), retryCount: -1 }).retryCount).toBe('不能小于 0')
  })
})

describe('OpenAI 兼容接口的思维链与附加参数', () => {
  it('默认值：reasoning_effort 写法、high、不发预算、没有附加参数', () => {
    const cfg = defaultAppConfig()
    expect(cfg.openaiReasoningDialect).toBe('reasoning_effort')
    expect(cfg.openaiReasoningEffort).toBe('high')
    expect(cfg.openaiReasoningBudget).toBe(0)
    expect(cfg.openaiExtraParams).toBe('')
  })

  it('extraParamsError：留空合法；要是 JSON 对象；不许覆盖应用自己组装的键', () => {
    expect(extraParamsError('  ')).toBeNull()
    expect(extraParamsError('{"top_p": 0.9}')).toBeNull()
    expect(extraParamsError('{top_p: 0.9}')).toBe('不是合法的 JSON')
    expect(extraParamsError('[1]')).toBe('要写成 JSON 对象，例如 {"top_p": 0.9}')
    expect(extraParamsError('{"model": "x", "stream": true, "top_p": 1}')).toBe('不能包含 model、stream：这些由应用自己填')
  })

  it('parseExtraParams：合法时给对象，留空或不合法时给空对象', () => {
    expect(parseExtraParams('{"thinking": {"type": "enabled"}}')).toEqual({ thinking: { type: 'enabled' } })
    expect(parseExtraParams('')).toEqual({})
    expect(parseExtraParams('{bad')).toEqual({})
  })

  it('validateConfig 报附加参数的错；预算允许 0、不许负数', () => {
    expect(validateConfig({ ...defaultAppConfig(), openaiExtraParams: '[1]' }).openaiExtraParams).toBeDefined()
    expect(validateConfig({ ...defaultAppConfig(), openaiReasoningBudget: 0 }).openaiReasoningBudget).toBeUndefined()
    expect(validateConfig({ ...defaultAppConfig(), openaiReasoningBudget: -1 }).openaiReasoningBudget).toBe('不能小于 0')
  })

  it('mergeConfig：写法与力度不在枚举里、附加参数不合法时回默认值；合法值原样保留', () => {
    const bad = mergeConfig({ openaiReasoningDialect: 'x', openaiReasoningEffort: 'ultra', openaiExtraParams: '{bad' })
    expect(bad.openaiReasoningDialect).toBe('reasoning_effort')
    expect(bad.openaiReasoningEffort).toBe('high')
    expect(bad.openaiExtraParams).toBe('')
    const good = mergeConfig({ openaiReasoningDialect: 'thinking_object', openaiReasoningEffort: 'max', openaiExtraParams: '{"top_p": 1}' })
    expect([good.openaiReasoningDialect, good.openaiReasoningEffort, good.openaiExtraParams]).toEqual([
      'thinking_object',
      'max',
      '{"top_p": 1}',
    ])
  })
})
