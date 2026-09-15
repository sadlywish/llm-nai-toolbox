import { DEFAULT_TEXTS } from './defaultTexts'
import {
  CHARACTER_FIELDS,
  DEFAULT_CHAR_PROMPT_ORDER,
  DEFAULT_PROMPT_ORDER,
  MAIN_FIELDS,
  fieldOrderError,
} from './fields'
import { parseProxyRules } from './proxy'

export type ApiType = 'claude' | 'openai'
export type ThinkingFormat = 'adaptive' | 'budget'
export type ThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const API_TYPES: readonly ApiType[] = ['claude', 'openai']
export const THINKING_FORMATS: readonly ThinkingFormat[] = ['adaptive', 'budget']
export const THINKING_EFFORTS: readonly ThinkingEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export type ImageFormat = 'png' | 'webp'
export const IMAGE_FORMATS: readonly ImageFormat[] = ['png', 'webp']

/**
 * OpenAI 兼容接口的思维链参数写法。各家各不相同（2026-09 核对各家文档）：
 * - reasoning_effort：OpenAI 官方、Gemini、xAI、vLLM 等，顶层 `reasoning_effort`
 * - reasoning_object：OpenRouter，`reasoning: { effort }` 或 `reasoning: { max_tokens }`
 * - thinking_object：DeepSeek、智谱、Kimi，`thinking: { type: "enabled" }`
 * - enable_thinking：通义千问，`enable_thinking: true`，预算另用 `thinking_budget`
 * 具体请求体由 main/llm/thinking.ts 生成。
 */
export type OpenAIReasoningDialect = 'reasoning_effort' | 'reasoning_object' | 'thinking_object' | 'enable_thinking'
export type OpenAIReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const OPENAI_REASONING_DIALECTS: readonly OpenAIReasoningDialect[] = [
  'reasoning_effort',
  'reasoning_object',
  'thinking_object',
  'enable_thinking',
]
/** 原样发给端点，不在应用里降档：各家各模型支持的档位不同，由端点决定收不收 */
export const OPENAI_REASONING_EFFORTS: readonly OpenAIReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** 附加请求参数里不许出现的键：它们由应用自己组装，被覆盖掉整轮就跑不起来 */
export const RESERVED_REQUEST_KEYS: readonly string[] = ['model', 'messages', 'tools', 'stream']

/**
 * 应用配置（config.json）。**不含任何密钥**——API Key 在 secrets.json。
 *
 * 分组照规格 §14，默认值照 koishi 插件 src/config.ts。
 */
export interface AppConfig {
  // ── LLM API ──
  apiType: ApiType
  apiBaseUrl: string
  model: string
  maxTokens: number
  /** LLM 单次请求超时（秒） */
  requestTimeoutSec: number
  /** OpenAI 兼容接口的附加请求参数（JSON 对象文本），原样合并进请求体，同名字段以它为准 */
  openaiExtraParams: string

  // ── 思维链 ──
  thinkingEnabled: boolean
  thinkingFormat: ThinkingFormat
  thinkingEffort: ThinkingEffort
  thinkingBudgetTokens: number
  /** 以下三项只对 OpenAI 兼容接口生效；Claude 接口用上面四项 */
  openaiReasoningDialect: OpenAIReasoningDialect
  openaiReasoningEffort: OpenAIReasoningEffort
  /** 0 = 不发预算。只有 reasoning_object 与 enable_thinking 两种写法使用 */
  openaiReasoningBudget: number

  // ── NovelAI ──
  /** 出图接口地址，路径固定 /ai/generate-image */
  naiBaseUrl: string
  /** 图片保存根目录，按日期分子目录。空串 = 未设置，点「生成」时提示去设置 */
  saveDir: string
  imageFormat: ImageFormat
  /** NovelAI 单次请求超时（秒） */
  naiTimeoutSec: number
  /** 网络错误、超时、其他 HTTP 错误的按张重试次数；429 与 Token 问题不重试 */
  retryCount: number
  /** 相邻两张之间的间隔（毫秒） */
  taskIntervalMs: number
  /** 历史竖栏读最近几天的记录 */
  historyDays: number

  // ── 提示词 ──
  systemPrompt: string
  /** 多角色附加：追加在内置多角色说明之后 */
  naiCharSystemPrompt: string
  quality: string
  negativePrompt: string
  promptOrder: string
  naiCharPromptOrder: string
  tailInjectionEnabled: boolean
  tailInjection: string

  // ── 多角色与分辨率 ──
  naiMaxCharacters: number
  /** 宽高比换算宽高时的总像素上限 */
  naiMaxPixels: number

  // ── 工具循环 ──
  maxToolRounds: number
  autoSkipSearch: boolean
  tagBrowsePageChars: number
  tagManualEnabled: boolean

  // ── 标签查询返回 ──
  tagQueryCharacterMax: number
  tagQueryCharacterAliases: boolean
  tagQueryCharacterWiki: boolean
  tagQueryCharacterSeries: boolean
  tagQueryCharacterAppearance: boolean
  tagQueryCharacterClothing: boolean
  tagQueryArtistMax: number
  tagQueryArtistAliases: boolean
  tagQueryArtistWiki: boolean
  tagQueryGeneralMax: number
  tagQueryGeneralAliases: boolean
  tagQueryGeneralWiki: boolean
  tagQuerySeriesMax: number
  tagQuerySeriesAliases: boolean
  tagQuerySeriesWiki: boolean
  tagQueryWikiLength: number

  // ── Danbooru ──
  /** Danbooru 用户名；与 API Key 同时填了才以登录身份请求（翻页上限、限流更宽），否则匿名 */
  danbooruLogin: string

  // ── 网络 ──
  proxy: string
}

/** 每次都新建对象：配置会被就地修改，共享一个对象会让改一处连带改掉别处 */
export function defaultAppConfig(): AppConfig {
  return {
    apiType: 'claude',
    apiBaseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-5',
    maxTokens: 16000,
    requestTimeoutSec: 120,
    openaiExtraParams: '',

    thinkingEnabled: false,
    thinkingFormat: 'adaptive',
    thinkingEffort: 'high',
    thinkingBudgetTokens: 10000,
    openaiReasoningDialect: 'reasoning_effort',
    openaiReasoningEffort: 'high',
    openaiReasoningBudget: 0,

    naiBaseUrl: 'https://image.novelai.net',
    saveDir: '',
    imageFormat: 'png',
    naiTimeoutSec: 120,
    retryCount: 2,
    taskIntervalMs: 500,
    historyDays: 30,

    systemPrompt: DEFAULT_TEXTS.systemPrompt,
    naiCharSystemPrompt: DEFAULT_TEXTS.naiCharSystemPrompt,
    quality: DEFAULT_TEXTS.quality,
    negativePrompt: DEFAULT_TEXTS.negativePrompt,
    promptOrder: DEFAULT_PROMPT_ORDER,
    naiCharPromptOrder: DEFAULT_CHAR_PROMPT_ORDER,
    tailInjectionEnabled: false,
    tailInjection: DEFAULT_TEXTS.tailInjection,

    naiMaxCharacters: 22,
    naiMaxPixels: 1024 * 1024,

    maxToolRounds: 10,
    autoSkipSearch: false,
    tagBrowsePageChars: 12000,
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

    danbooruLogin: '',

    proxy: '',
  }
}

/** 设置页里有「恢复默认」按钮的项（规格 §14.2） */
export const RESTORABLE_KEYS = [
  'systemPrompt',
  'naiCharSystemPrompt',
  'tailInjection',
  'quality',
  'negativePrompt',
  'promptOrder',
  'naiCharPromptOrder',
] as const satisfies readonly (keyof AppConfig)[]

export type NumericKey = {
  [K in keyof AppConfig]: AppConfig[K] extends number ? K : never
}[keyof AppConfig]

export interface NumberRule {
  min: number
  max?: number
  integer: boolean
}

/**
 * 数值项的取值规则。设置页保存前按它校验；mergeConfig 读配置时
 * 违反规则的值回到默认值（手改出来的 0 秒超时会让每个请求立刻被自己取消）。
 */
export const NUMBER_RULES: Record<NumericKey, NumberRule> = {
  maxTokens: { min: 1, integer: true },
  requestTimeoutSec: { min: 1, integer: true },
  // budget 与 maxTokens 的相对关系（≥1024 且 < maxTokens）在发请求时收敛并告警（规格 §9.3），这里只管是正整数
  thinkingBudgetTokens: { min: 1, integer: true },
  openaiReasoningBudget: { min: 0, integer: true },
  naiMaxCharacters: { min: 1, integer: true },
  naiMaxPixels: { min: 64 * 64, integer: true },
  naiTimeoutSec: { min: 1, integer: true },
  retryCount: { min: 0, integer: true },
  taskIntervalMs: { min: 0, integer: true },
  historyDays: { min: 1, integer: true },
  maxToolRounds: { min: 1, integer: true },
  // 插件的 Schema 就是 2000~40000
  tagBrowsePageChars: { min: 2000, max: 40000, integer: true },
  tagQueryCharacterMax: { min: 0, integer: true },
  tagQueryArtistMax: { min: 0, integer: true },
  tagQueryGeneralMax: { min: 0, integer: true },
  tagQuerySeriesMax: { min: 0, integer: true },
  tagQueryWikiLength: { min: 0, integer: true },
}

function numberRuleError(rule: NumberRule, value: number): string | null {
  if (!Number.isFinite(value)) return '请输入数字'
  if (rule.integer && !Number.isInteger(value)) return '请输入整数'
  if (value < rule.min) return `不能小于 ${rule.min}`
  if (rule.max !== undefined && value > rule.max) return `不能大于 ${rule.max}`
  return null
}

/** 附加请求参数的问题；合法（含留空）时返回 null */
export function extraParamsError(text: string): string | null {
  if (text.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return '不是合法的 JSON'
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return '要写成 JSON 对象，例如 {"top_p": 0.9}'
  }
  const reserved = Object.keys(parsed).filter((k) => RESERVED_REQUEST_KEYS.includes(k))
  if (reserved.length > 0) return `不能包含 ${reserved.join('、')}：这些由应用自己填`
  return null
}

/** 附加请求参数 → 对象。留空或不合法时给空对象（保存与读配置时都已校验过，正常路径走不到不合法） */
export function parseExtraParams(text: string): Record<string, unknown> {
  if (extraParamsError(text) !== null || text.trim() === '') return {}
  return JSON.parse(text) as Record<string, unknown>
}

export type ConfigErrors = Partial<Record<keyof AppConfig, string>>

/** 保存前的校验。返回空对象表示全部合法 */
export function validateConfig(cfg: AppConfig): ConfigErrors {
  const errors: ConfigErrors = {}
  for (const key of Object.keys(NUMBER_RULES) as NumericKey[]) {
    const e = numberRuleError(NUMBER_RULES[key], cfg[key])
    if (e !== null) errors[key] = e
  }
  if (!/^https?:\/\/\S+$/i.test(cfg.apiBaseUrl.trim())) {
    errors.apiBaseUrl = '要写成 http:// 或 https:// 开头的地址'
  }
  if (!/^https?:\/\/\S+$/i.test(cfg.naiBaseUrl.trim())) {
    errors.naiBaseUrl = '要写成 http:// 或 https:// 开头的地址'
  }
  if (cfg.model.trim() === '') errors.model = '模型名不能为空'
  const mainOrder = fieldOrderError(MAIN_FIELDS, cfg.promptOrder)
  if (mainOrder !== null) errors.promptOrder = mainOrder
  const charOrder = fieldOrderError(CHARACTER_FIELDS, cfg.naiCharPromptOrder)
  if (charOrder !== null) errors.naiCharPromptOrder = charOrder
  const extra = extraParamsError(cfg.openaiExtraParams)
  if (extra !== null) errors.openaiExtraParams = extra
  const proxy = parseProxyRules(cfg.proxy)
  if (!proxy.ok) errors.proxy = proxy.message
  return errors
}

/**
 * 把读到的任意 JSON 合并成一份完整合法的配置。
 *
 * 逐项取值：类型与默认值一致才用存的值，否则用默认值。**只补缺、不回退**——
 * 存的是空串就还是空串（规格 §14.1 默认文案不回退）。不认识的键丢弃。
 * 枚举、数值规则、字段顺序不合法的项回到默认值：这些只可能来自手改的文件，
 * 带着它们跑会变成查不到原因的故障。
 */
export function mergeConfig(stored: unknown): AppConfig {
  const base = defaultAppConfig()
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return base
  const src = stored as Record<string, unknown>
  const out = { ...base } as Record<keyof AppConfig, unknown>
  for (const key of Object.keys(base) as (keyof AppConfig)[]) {
    const v = src[key]
    if (typeof v !== typeof base[key]) continue
    if (typeof v === 'number' && !Number.isFinite(v)) continue
    out[key] = v
  }
  const cfg = out as AppConfig

  if (!API_TYPES.includes(cfg.apiType)) cfg.apiType = base.apiType
  if (!THINKING_FORMATS.includes(cfg.thinkingFormat)) cfg.thinkingFormat = base.thinkingFormat
  if (!THINKING_EFFORTS.includes(cfg.thinkingEffort)) cfg.thinkingEffort = base.thinkingEffort
  if (!OPENAI_REASONING_DIALECTS.includes(cfg.openaiReasoningDialect)) cfg.openaiReasoningDialect = base.openaiReasoningDialect
  if (!OPENAI_REASONING_EFFORTS.includes(cfg.openaiReasoningEffort)) cfg.openaiReasoningEffort = base.openaiReasoningEffort
  if (!IMAGE_FORMATS.includes(cfg.imageFormat)) cfg.imageFormat = base.imageFormat
  if (extraParamsError(cfg.openaiExtraParams) !== null) cfg.openaiExtraParams = base.openaiExtraParams
  for (const key of Object.keys(NUMBER_RULES) as NumericKey[]) {
    if (numberRuleError(NUMBER_RULES[key], cfg[key]) !== null) cfg[key] = base[key]
  }
  if (fieldOrderError(MAIN_FIELDS, cfg.promptOrder) !== null) cfg.promptOrder = base.promptOrder
  if (fieldOrderError(CHARACTER_FIELDS, cfg.naiCharPromptOrder) !== null) {
    cfg.naiCharPromptOrder = base.naiCharPromptOrder
  }
  return cfg
}
