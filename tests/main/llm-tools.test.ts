import { describe, expect, it } from 'vitest'
import { CHARACTER_FIELDS, MAIN_FIELDS } from '../../src/shared/fields'
import {
  SEARCH_TOOL_NAMES,
  generateTool,
  isGenerateTool,
  selectRoundTools,
  type ToolAvailability,
} from '../../src/main/llm/tools'
import type { JsonObject } from '../../src/main/llm/types'

const ORDER = 'quality, count, style, character, artist, appearance, tags, environment, series, nltags'
const props = (schema: JsonObject): JsonObject => schema.properties as JsonObject
const all: ToolAvailability = { searchTags: true, characterFeatures: true, browse: true, manual: true }

describe('generateTool', () => {
  it('generate_image：描述里的拼接顺序按设置生成', () => {
    const t = generateTool(false, ORDER)
    expect(t.name).toBe('generate_image')
    expect(t.description).toContain(`正向提示词由各字段按固定顺序拼接：${ORDER}。`)
    expect(t.inputSchema.required).toEqual(['tags'])
  })

  it('generate_image 的属性 = 全部整图字段 + 五个尾部参数（与 fields.ts 不许漂移）', () => {
    const keys = Object.keys(props(generateTool(false, ORDER).inputSchema)).sort()
    const expected = [
      ...MAIN_FIELDS.map((f) => f.name),
      'negative_prompt',
      'aspect_ratio',
      'seed',
      'text',
      'transparent_background',
    ].sort()
    expect(keys).toEqual(expected)
  })

  it('generate_image_characters：角色项属性 = 角色字段 + negative_prompt + position；count 的枚举与字段定义一致', () => {
    const t = generateTool(true, ORDER)
    expect(t.name).toBe('generate_image_characters')
    expect(t.inputSchema.required).toEqual(['tags', 'characters'])
    const items = (props(t.inputSchema).characters as JsonObject).items as JsonObject
    const itemProps = props(items)
    expect(Object.keys(itemProps).sort()).toEqual(
      [...CHARACTER_FIELDS.map((f) => f.name), 'negative_prompt', 'position'].sort(),
    )
    const countOptions = CHARACTER_FIELDS.find((f) => f.name === 'count')?.options
    expect((itemProps.count as JsonObject).enum).toEqual(countOptions)
  })

  it('多角色工具的顶层 character 说明要求留空', () => {
    const top = props(generateTool(true, ORDER).inputSchema)
    expect(String((top.character as JsonObject).description)).toContain('多角色模式下此字段必须留空')
  })
})

describe('selectRoundTools', () => {
  const names = (o: Partial<Parameters<typeof selectRoundTools>[0]>) =>
    selectRoundTools({ round: 0, maxRounds: 10, skipSearch: false, multi: false, promptOrder: ORDER, available: all, ...o }).map(
      (t) => t.name,
    )

  it('普通轮次：生成工具在前，其余按插件顺序', () => {
    expect(names({})).toEqual(['generate_image', 'search_tags', 'search_character_features', 'load_tag_manual', 'browse_tags'])
  })

  it('最后一轮只给生成工具；只有一轮时第一轮就是最后一轮', () => {
    expect(names({ round: 9 })).toEqual(['generate_image'])
    expect(names({ maxRounds: 1 })).toEqual(['generate_image'])
  })

  it('搜索高置信后撤掉 search_tags，其余保留', () => {
    expect(names({ skipSearch: true })).toEqual(['generate_image', 'search_character_features', 'load_tag_manual', 'browse_tags'])
  })

  it('数据不可用的工具不注册', () => {
    expect(names({ available: { searchTags: false, characterFeatures: false, browse: true, manual: false } })).toEqual([
      'generate_image',
      'browse_tags',
    ])
  })

  it('多角色时生成工具换成 generate_image_characters', () => {
    expect(names({ multi: true })[0]).toBe('generate_image_characters')
  })
})

describe('工具名集合', () => {
  it('四个检索工具；两个生成工具', () => {
    expect([...SEARCH_TOOL_NAMES].sort()).toEqual(['browse_tags', 'load_tag_manual', 'search_character_features', 'search_tags'])
    expect(isGenerateTool('generate_image')).toBe(true)
    expect(isGenerateTool('generate_image_characters')).toBe(true)
    expect(isGenerateTool('search_tags')).toBe(false)
  })
})
