/**
 * 字段的唯一事实来源。
 *
 * 分块编辑器的装饰、提示词拼接、LLM 工具 schema 的生成全部从这里取。
 * 各写一份必然漂移——漂移的表现是「界面上有这个块，拼接时被漏掉」。
 *
 * **整图与角色是两套字段集**，数量、语义、输入形态都不同（见 spec §5.3）。
 * 任何消费方都必须接受字段集作为参数，不得引用某一套当默认值。
 */

/** 输入形态。决定补全、校验与全角逗号标红怎么做 */
export type FieldInput =
  /** 逗号分隔的 Danbooru 标签串 */
  | 'tags'
  /** 自然语言描述。中文逗号在这里合法 */
  | 'text'
  /** 固定选项，渲染成选择器而不是文本框 */
  | 'enum'

/** 补全时优先搜哪一类标签；null = 不补全 */
export type CompletionKind = 'artist' | 'character' | 'series' | 'general'

export interface FieldSpec {
  /** 字段名。与 LLM 工具 schema 的属性名逐字相同，不可改 */
  name: string
  /** 徽章上显示的文字 */
  label: string
  /** 色相 0~359。红色区间留给错误标记，字段不用 */
  hue: number
  input: FieldInput
  /** input 为 'enum' 时的可选值，其余形态为空数组 */
  options: readonly string[]
  /** 是否标红全角逗号。只有 tags 形态才标 */
  flagFullWidthComma: boolean
  completion: CompletionKind | null
}

/**
 * 色相按**字段名**分配，这样同名字段在整图与角色两套集合里同色，
 * 用户不必重新认一遍颜色。
 */
const HUE: Record<string, number> = {
  count: 210,
  character: 250,
  series: 285,
  style: 320,
  artist: 30,
  appearance: 50,
  tags: 85,
  environment: 120,
  nltags: 160,
  quality: 190,
}

function tagField(name: string, completion: CompletionKind): FieldSpec {
  return {
    name,
    label: name,
    hue: HUE[name],
    input: 'tags',
    options: [],
    flagFullWidthComma: true,
    completion,
  }
}

function textField(name: string): FieldSpec {
  return {
    name,
    label: name,
    hue: HUE[name],
    input: 'text',
    options: [],
    flagFullWidthComma: false,
    completion: null,
  }
}

/** 与插件 config.promptOrder 的默认值逐字一致 */
export const DEFAULT_PROMPT_ORDER =
  'count, style, character, artist, appearance, tags, environment, series, nltags, quality'

/** 与插件 config.naiCharPromptOrder 的默认值逐字一致 */
export const DEFAULT_CHAR_PROMPT_ORDER = 'count, character, appearance, tags, nltags'

/** 整图字段。顺序即 DEFAULT_PROMPT_ORDER */
export const MAIN_FIELDS: readonly FieldSpec[] = [
  tagField('count', 'general'),
  tagField('style', 'general'),
  tagField('character', 'character'),
  tagField('artist', 'artist'),
  tagField('appearance', 'general'),
  tagField('tags', 'general'),
  tagField('environment', 'general'),
  tagField('series', 'series'),
  textField('nltags'),
  tagField('quality', 'general'),
]

/**
 * 角色字段。只有五项——`negative_prompt` 与 `position` 是该角色的**参数**，
 * 有各自的独立输入，绝不进分块流（spec §1.3）。
 */
export const CHARACTER_FIELDS: readonly FieldSpec[] = [
  {
    // 整图的 count 是「总人数与构图」，角色的 count 是「该角色的性别标记」，
    // 只能是三者之一且不带数字。对应官方界面上每个角色的性别选择器。
    name: 'count',
    label: 'count',
    hue: HUE.count,
    input: 'enum',
    options: ['girl', 'boy', 'other'],
    flagFullWidthComma: false,
    completion: null,
  },
  tagField('character', 'character'),
  tagField('appearance', 'general'),
  tagField('tags', 'general'),
  textField('nltags'),
]

export function fieldByName(
  specs: readonly FieldSpec[],
  name: string,
): FieldSpec | undefined {
  return specs.find((s) => s.name === name)
}

/** 顺序串切成字段名。与插件 buildPrompt 的切法一致：逗号分隔、去空白、丢空项 */
export function parseFieldOrder(order: string): string[] {
  return order
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 顺序串的问题；合法时返回 null。
 *
 * **必须恰好包含字段集的全部字段、各一次。** 插件允许漏写字段（漏掉的不拼接），
 * 这里不允许：顺序串同时决定编辑器里块的先后，漏掉一个字段就意味着一个
 * 在编辑器里看得见、却不会被发出去的块——框里看到的与拼接结果对不上。
 */
export function fieldOrderError(specs: readonly FieldSpec[], order: string): string | null {
  const names = parseFieldOrder(order)
  const known = new Set(specs.map((s) => s.name))
  const unknown = names.filter((n) => !known.has(n))
  if (unknown.length > 0) return `不认识的字段：${unknown.join('、')}`
  const duplicated = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))]
  if (duplicated.length > 0) return `字段重复：${duplicated.join('、')}`
  const missing = specs.map((s) => s.name).filter((n) => !names.includes(n))
  if (missing.length > 0) return `缺少字段：${missing.join('、')}`
  return null
}

/**
 * 按顺序串重排字段集。
 *
 * 顺序串非法时原样返回字段集。这是兜底而不是降级：设置抽屉保存前
 * 与 mergeConfig 读配置时都已经把非法顺序串拦下，正常路径走不到这里。
 *
 * 每次调用返回新数组，调用方必须按顺序串 memo（PromptEditor 以字段集
 * 引用作为重建编辑器的依据，见其 Props 注释）。
 */
export function orderSpecs(specs: readonly FieldSpec[], order: string): readonly FieldSpec[] {
  if (fieldOrderError(specs, order) !== null) return specs
  return parseFieldOrder(order).map((name) => fieldByName(specs, name) as FieldSpec)
}
