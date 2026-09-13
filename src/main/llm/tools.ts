import { parseFieldOrder } from '@shared/fields'
import type { JsonObject, ToolDefinition } from './types'

/**
 * LLM 工具的 schema。工具名、字段名、说明文字与插件逐字一致（规格 §9.2）。
 * 插件的 search_lora 与 list_models 不要（规格明确不做 LoRA）。
 *
 * 字段名与 shared/fields.ts 的 MAIN_FIELDS / CHARACTER_FIELDS 必须逐字相同；
 * tests/main/llm-tools.test.ts 有断言守着这一点。
 */

export const GENERATE_TOOL_NAME = 'generate_image'
export const GENERATE_CHARACTERS_TOOL_NAME = 'generate_image_characters'
export const SEARCH_TAGS_TOOL_NAME = 'search_tags'
export const CHARACTER_FEATURES_TOOL_NAME = 'search_character_features'
export const BROWSE_TAGS_TOOL_NAME = 'browse_tags'
export const LOAD_MANUAL_TOOL_NAME = 'load_tag_manual'

/** 需要把结果喂回 LLM 再往下走的工具。循环靠它判断「还要不要继续」 */
export const SEARCH_TOOL_NAMES: ReadonlySet<string> = new Set([
  SEARCH_TAGS_TOOL_NAME,
  CHARACTER_FEATURES_TOOL_NAME,
  BROWSE_TAGS_TOOL_NAME,
  LOAD_MANUAL_TOOL_NAME,
])

export function isGenerateTool(name: string): boolean {
  return name === GENERATE_TOOL_NAME || name === GENERATE_CHARACTERS_TOOL_NAME
}

// ─── 工具 Schema ────────────────────────────────────────────
// 字段名与 reforge 后端**完全一致**，这样 LLM 交互层（提示词拼接顺序、质量词去重、
// -e 修改模式的 <现有参数> 展示、缓存复用）在两个后端之间无需任何分支。

const SHARED_FIELDS: Record<string, JsonObject> = {
  count: {
    type: 'string',
    description: '人数、构图、镜头，如 1girl, 2girls, 1boy, solo, cowboy shot, portrait 等',
  },
  character: { type: 'string', description: '角色名称' },
  series: { type: 'string', description: '作品/系列名称' },
  style: { type: 'string', description: '画风标签' },
  artist: { type: 'string', description: '画师名。注意不要转义用于调整权重的括号' },
  appearance: {
    type: 'string',
    description: '角色外观：仅包含发型、发色、年龄、瞳色、体型、服装、饰品。每个概念只描述一次，不要与 tags 重复。',
  },
  tags: {
    type: 'string',
    description: '动作、互动、姿势、表情等场景标签，逗号分隔。不要重复 appearance 中已有的内容。同一概念只保留最具体的标签。',
  },
  environment: { type: 'string', description: '环境/背景/光影描述' },
  nltags: { type: 'string', description: '自然语言补充描述（最多一句）' },
  quality: {
    type: 'string',
    description: '质量标签，根据用户上下文中的 [质量词] 设置。质量相关标签只能出现在此字段。',
  },
}

// 插件这里还有 seed 字段。本应用不让模型管 seed（2026-09-13 用户决定），seed 完全由参数区决定
const TAIL_FIELDS: Record<string, JsonObject> = {
  negative_prompt: {
    type: 'string',
    description: '反向提示词（英文）。根据用户上下文中的 [负面词] 设置，并结合画面需求调整。',
  },
  aspect_ratio: {
    type: 'string',
    description: '宽高比，如 1:1, 2:3, 3:2, 16:9, 9:16。实际分辨率按总像素上限反推并对齐到 64 的倍数。',
    default: '1:1',
  },
  text: {
    type: 'string',
    description:
      '要在画面中重点渲染的一段文字（招牌、书页、标语等）。写文字内容本身即可，引号可加可不加。' +
      '★只能填一段连续文字★：NovelAI 的文本强化机制针对单段做字形修复，填多段不会生效。' +
      '画面中需要出现多处文字时，挑最长、最重要的那一段填在这里，' +
      '其余文字只在 tags 或 nltags 里用引号写出来（它们不会被强化，字形可能不准，这是模型限制）。' +
      '限制：需要 V4 及以上模型；建议 120 字符以内；V4/V4.5 只能渲染英文，V5 可渲染中文。' +
      '用户没有要求画面中出现文字时留空。',
  },
  transparent_background: {
    type: 'boolean',
    description:
      '透明背景。用户要求"透明背景/去背景/PNG 抠图/无背景"时设为 true，' +
      '同时要在 environment 或 tags 里写上 transparent background 标签——' +
      '这个开关只是告诉模型"提示词里在要求透明背景"，本身不产生透明效果。' +
      '需要 V5 及以上模型。',
    default: false,
  },
}

/** 角色独立提示词：字段与整图一致，但语义是"这个角色自己"的内容 */
const CHARACTER_ITEM_FIELDS: Record<string, JsonObject> = {
  count: {
    type: 'string',
    description:
      '该角色的性别标记，只能是 girl / boy / other 三者之一，**不带数字**。' +
      '这对应官方界面上每个角色的性别选择器。' +
      '整张图的总人数（2girls, 1girl 1boy 等）写在顶层 count，不要写在这里。',
    enum: ['girl', 'boy', 'other'],
  },
  character: { type: 'string', description: '该角色的角色名（无则留空）' },
  appearance: {
    type: 'string',
    description:
      '该角色的发型、发色、瞳色、体型、服装、饰品，英文 Danbooru 标签。' +
      '严禁写画风/画师词，也严禁写背景和场景——那些属于顶层字段。',
  },
  tags: {
    type: 'string',
    description:
      '该角色自己的动作、姿势、表情、视线。不要写背景、场景、光影、画风。' +
      '涉及与其他角色的互动时用方向标记，注意是**前缀**写法（标记直接贴在动作词前面，不加空格）：' +
      '动作发起方写 source#动作，承受方写 target#动作，双向动作两边都写 mutual#动作。' +
      '例如拥抱 → 角色A 写 source#hug，角色B 写 target#hug；' +
      '对视 → 两边都写 mutual#eye contact。' +
      '没有跨角色互动时不要写这些标记。',
  },
  nltags: { type: 'string', description: '该角色的自然语言补充（英文，最多一句）' },
  negative_prompt: { type: 'string', description: '该角色专属的反向提示词（可留空）' },
  position: {
    type: 'string',
    description:
      '该角色在画面中的位置，两种写法都可以：' +
      '① 自由坐标 "x,y"，取值 0~1，x 从左到右、y 从上到下，例如 "0.3,0.5" 表示偏左居中（V5 推荐，定位更精确）；' +
      '② 5×5 网格标记，列 A~E 从左到右、行 1~5 从上到下，例如左侧 B3、右侧 D3、居中 C3。' +
      '不填默认居中。',
  },
}

const MULTI_CHARACTER_TOOL: ToolDefinition = {
  name: GENERATE_CHARACTERS_TOOL_NAME,
  description:
    '使用 NovelAI 的多角色能力生成图片。每个角色拥有独立的提示词与画面位置。' +
    '★顶层字段只描述整幅画（总人数、画风、场景、构图），' +
    '具体是哪些角色、各自长什么样，全部写在 characters 数组里★',
  inputSchema: {
    type: 'object',
    properties: {
      ...SHARED_FIELDS,
      // 覆盖共享定义：多角色模式下这两项的语义变了
      count: {
        type: 'string',
        description:
          '整幅画的总人数与分级，如 "2girls, rating:general" 或 "1girl 1boy"。' +
          '只写总数和整体性的标签，不要写任何具体角色的信息。',
      },
      character: {
        type: 'string',
        description:
          '★多角色模式下此字段必须留空★。角色名要逐个写进 characters 数组里各自的 character 字段，' +
          '例如 characters[0].character = "saber"、characters[1].character = "hatsune miku"。' +
          '写在这里会让模型无法把角色和位置对应起来。',
      },
      characters: {
        type: 'array',
        description:
          '角色列表。每个元素描述一个角色自己的内容。' +
          '顶层字段描述整幅画（总人数、场景、画风），角色元素只描述该角色本身。',
        items: { type: 'object', properties: CHARACTER_ITEM_FIELDS },
      },
      ...TAIL_FIELDS,
    },
    required: ['tags', 'characters'],
  },
}

const SEARCH_TAGS_TOOL: ToolDefinition = {
  name: SEARCH_TAGS_TOOL_NAME,
  description:
    '按**字面**搜索 Danbooru 标签数据库。' +
    '主要用于角色名、画师名、作品名这类专有名词——它们有确切的字面写法，字面匹配最有效。' +
    '外貌、服装、动作、表情、构图、场景、光线这类【概念】请优先用 browse_tags 浏览分类挑选：' +
    '中文口语说法与英文标签的字面常常毫不重合（「从上往下看」对应 from_above、' +
    '「伸出舌头」对应 tongue_out），字面搜索查不出来，换关键词重查通常也无效。' +
    '针对默认画风中的关键词，不需要通过本工具查询，直接使用即可。' +
    '重要：必须一次性将所有需要查询的画师、角色、作品、概念在同一次调用中全部给出，禁止分多次调用逐个查询。' +
    '查询时优先使用用户提示中的原始词汇，不要自行臆造或翻译后再查询。仅当原始词汇无结果时再尝试其他变体。' +
    '优先使用中文查询，匹配效果最佳；仅当中文无结果时再尝试日文或英文。' +
    '匹配度：≥0.85 直接采信，0.7~0.84 基本可信，<0.7 置信度较低。' +
    '收到结果后直接使用返回的标签，不要重复搜索同一内容。',
  inputSchema: {
    type: 'object',
    properties: {
      artists: {
        type: 'array',
        items: { type: 'string' },
        description: '画师查询词列表。如: ["sakimichan", "岸田メル"]',
      },
      characters: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: '角色名称（中文、日文或英文均可）',
            },
            series: {
              type: 'string',
              description: '角色所属作品名（仅当能确认作品时提供，可省略）',
            },
          },
          required: ['name'],
        },
        description: '角色查询列表。如: [{"name":"初音未来"}, {"name":"saber","series":"fate"}]',
      },
      concepts: {
        type: 'array',
        items: { type: 'string' },
        description: '概念/通用标签查询词列表。用于查找服饰、姿势、场景、外貌特征等概念的准确标签。如: ["过膝袜", "JK制服", "俯视"]',
      },
      series: {
        type: 'array',
        items: { type: 'string' },
        description: '作品/系列查询词列表，查作品本身的标签。如: ["原神", "碧蓝档案", "Fate"]。'
          + '注意与 characters 里的 series 字段区分：那个是给角色**消歧**用的提示（同名角色分属不同作品），'
          + '不会单独返回作品标签；只有把作品名放进这里，才会返回该作品自己的标签。'
          + '用户要求画某作品的场景/风格、或需要把作品名拼进提示词时用它。',
      },
    },
  },
}

const SEARCH_CHARACTER_TOOL: ToolDefinition = {
  name: CHARACTER_FEATURES_TOOL_NAME,
  description:
    '查询角色的官方外貌和服装标签。使用角色的 Danbooru 标签名查询（可从 search_tags 结果获得）。' +
    '返回角色的作品、外貌标签和服装标签。生成角色图片时必须参考返回的标签，不要凭印象臆造角色外貌。' +
    '可一次查询多个角色，支持部分名称匹配。',
  inputSchema: {
    type: 'object',
    properties: {
      names: {
        type: 'array',
        items: { type: 'string' },
        description: '角色标签名列表。如: ["hatsune_miku", "saber"]',
      },
    },
    required: ['names'],
  },
}

const BROWSE_TAGS_TOOL: ToolDefinition = {
  name: BROWSE_TAGS_TOOL_NAME,
  description:
    '★把中文描述转成标签时的首选工具★。浏览某个分类下的全部标签，看着中文释义自己挑——' +
    '这是最可靠的方式：分类内条目有限，你能直接判断哪个标签真正对应用户的意思。' +
    '外貌、服装、动作、表情、构图、场景、光线、氛围这些都应该先用它。' +
    '分类名见系统提示词中的分类目录，格式「一级/二级」。结果按使用量降序，常用的在最前面。' +
    '分类默认整类返回，只有超大分类才分页（返回里会写明还有几页）。' +
    'keyword 是可选的排序提示：命中项被提到最前，但**不会删掉其余条目**。'  +
    '**中文和英文关键词都支持**，直接用用户原话里的中文词即可，不必先译成英文——'  +
    '匹配范围含标签名、中英日别名与 wiki 正文，填 "精液" 与填 "cum" 效果相当。'  +
    '它只负责把可能相关的排到前面，不替你筛选——仍要通读释义自己挑。' +
    '（search_tags 是字面匹配，只在你已经知道确切标签名、或要查角色/画师/作品这类专名时才用）',
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        description: '分类名，必须与目录中列出的完全一致，格式为「一级/二级」。如 "身体/face tags"、"画面构成/image composition"',
      },
      keyword: {
        type: 'string',
        description: '可选，排序提示而非过滤器：命中项排到最前，其余条目仍会全部列出。'
          + '**中文、英文关键词都支持**——直接填用户原话里的中文词就行，不需要先翻成英文。'
          + '匹配范围含标签名、中英日别名与 wiki 正文，所以 "精液" 与 "cum"、"俯视" 与 "from above" 效果相当。'
          + '大分类里想先看某方面时用，如 "袜"、"湿"。命中为空不代表分类里没有你要的标签，照常读释义挑。',
      },
      page: {
        type: 'integer',
        description: '可选，页码从 1 开始。大分类会分页返回，返回内容里会提示还有几页。',
      },
    },
    required: ['category'],
  },
}

const LOAD_MANUAL_TOOL: ToolDefinition = {
  name: LOAD_MANUAL_TOOL_NAME,
  description:
    '调取某个主题的完整 Danbooru 标签表。当你需要为某个方面挑选标签、但想不出有哪些可选时使用。' +
    '例如用户说"换个特别的发型"、"设计一套有意思的服装"、"用个不常见的构图"。' +
    '可用主题见系统提示词中的手册目录。一次只调一个主题，拿到表后直接从中挑选，不要重复调取同一主题。',
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: '主题名，必须与手册目录中列出的完全一致。如: "hair styles"、"attire-tops"、"posture"',
      },
    },
    required: ['topic'],
  },
}

/**
 * 生成工具。单角色时描述里那句拼接顺序按设置动态生成——插件写死的常量与 promptOrder 默认值
 * 本来就不一致（规格 §1.1）。
 */
export function generateTool(multi: boolean, promptOrder: string): ToolDefinition {
  if (multi) return MULTI_CHARACTER_TOOL
  return {
    name: GENERATE_TOOL_NAME,
    description: '使用 NovelAI 生成图片。' + `正向提示词由各字段按固定顺序拼接：${parseFieldOrder(promptOrder).join(', ')}。`,
    inputSchema: {
      type: 'object',
      properties: { ...SHARED_FIELDS, ...TAIL_FIELDS },
      required: ['tags'],
    },
  }
}

export interface ToolAvailability {
  searchTags: boolean
  characterFeatures: boolean
  browse: boolean
  manual: boolean
}

export interface RoundToolsOptions {
  /** 从 0 数 */
  round: number
  maxRounds: number
  /** 上一轮搜索全部高置信且开了 autoSkipSearch */
  skipSearch: boolean
  multi: boolean
  promptOrder: string
  available: ToolAvailability
}

/**
 * 本轮的工具集。插件 index.ts 第 2193–2215 行。
 * 最后一轮只给生成工具，强制收口；数据不可用的工具不注册（规格 §10.2）。
 */
export function selectRoundTools(o: RoundToolsOptions): ToolDefinition[] {
  const gen = generateTool(o.multi, o.promptOrder)
  if (o.round === o.maxRounds - 1) return [gen]
  const tools: ToolDefinition[] = [gen]
  if (!o.skipSearch && o.available.searchTags) tools.push(SEARCH_TAGS_TOOL)
  if (o.available.characterFeatures) tools.push(SEARCH_CHARACTER_TOOL)
  if (o.available.manual) tools.push(LOAD_MANUAL_TOOL)
  if (o.available.browse) tools.push(BROWSE_TAGS_TOOL)
  return tools
}
