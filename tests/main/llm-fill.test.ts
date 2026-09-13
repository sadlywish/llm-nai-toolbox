import { describe, expect, it } from 'vitest'
import { defaultAppConfig, type AppConfig } from '../../src/shared/config'
import type { LlmLogLine, MultiCharacterMode } from '../../src/shared/llm'
import { joinCharacterNegative, postProcess } from '../../src/main/llm/fill'
import { RunLog } from '../../src/main/llm/log'
import type { JsonObject } from '../../src/main/llm/types'

function run(
  args: JsonObject,
  over: { config?: Partial<AppConfig>; lockedStyle?: string | null; multi?: MultiCharacterMode; transparent?: boolean; withCharacters?: boolean } = {},
) {
  const lines: LlmLogLine[] = []
  const fill = postProcess(args, {
    config: { ...defaultAppConfig(), negativePrompt: 'NEG', naiCharDefaultNegative: '', ...over.config },
    lockedStyle: over.lockedStyle ?? null,
    multi: over.multi ?? 'off',
    transparent: over.transparent ?? false,
    withCharacters: over.withCharacters ?? false,
    log: new RunLog((l) => lines.push(l)),
  })
  return { fill, lines: lines.map((l) => `[${l.level}] ${l.text}`) }
}

describe('joinCharacterNegative', () => {
  it('两边都有就用逗号接；已经带着默认负面词时不重复追加', () => {
    expect(joinCharacterNegative('bad hands', 'lowres')).toBe('bad hands, lowres')
    expect(joinCharacterNegative('', 'lowres')).toBe('lowres')
    expect(joinCharacterNegative('bad hands', '')).toBe('bad hands')
    expect(joinCharacterNegative('bad hands, LowRes', 'lowres')).toBe('bad hands, LowRes')
  })
})

describe('postProcess', () => {
  it('画风锁定在规范化之前覆盖 artist，所以锁定的画风同样经过前缀归一；原 args 被就地改', () => {
    const args: JsonObject = { artist: 'someone', tags: 'smile' }
    const { fill, lines } = run(args, { lockedStyle: '@wlop' })
    expect(fill.main.artist).toBe('artist:wlop')
    expect(args.artist).toBe('artist:wlop')
    expect(lines.indexOf('[I] [强制画风] artist 覆盖为: @wlop')).toBeLessThan(
      lines.findIndex((l) => l.startsWith('[I] [NovelAI] 画师前缀归一')),
    )
  })

  it('artist 为空时告警', () => {
    expect(run({ tags: 'smile' }).lines).toContain('[W] [画风] artist 段为空（本次未锁定画风）——LLM 未填写该字段')
  })

  it('十个字段都有值（缺的是空串）；换行换成空格并写日志；非字符串转字符串', () => {
    const { fill, lines } = run({ artist: 'a', count: 2, nltags: '第一句。\n第二句。' })
    expect(Object.keys(fill.main)).toHaveLength(10)
    expect(fill.main.count).toBe('2')
    expect(fill.main.nltags).toBe('第一句。 第二句。')
    expect(fill.main.series).toBe('')
    expect(lines).toContain('[I] [回填] nltags 里的换行已换成空格（编辑器每个块只有一行）')
  })

  it('负面词：模型没给就用设置里的负面词', () => {
    expect(run({ artist: 'a', negative_prompt: 'bad' }).fill.negative).toBe('bad')
    expect(run({ artist: 'a' }).fill.negative).toBe('NEG')
    expect(run({ artist: 'a' }, { config: { negativePrompt: '' } }).fill.negative).toBe('')
  })

  it('宽高按比例换算并写一行日志；比例原样带出', () => {
    const { fill, lines } = run({ artist: 'a', aspect_ratio: '2:3' })
    expect([fill.aspectRatio, fill.width, fill.height]).toEqual(['2:3', 832, 1216])
    expect(lines).toContain('[I] 宽高比 2:3 → 832×1216（像素上限 1048576）')
    expect(run({ artist: 'a' }).fill.aspectRatio).toBe('1:1')
  })

  it('seed：≥0 取整数，-1 与认不出的给 null', () => {
    expect(run({ artist: 'a', seed: 42 }).fill.seed).toBe(42)
    expect(run({ artist: 'a', seed: '7' }).fill.seed).toBe(7)
    expect(run({ artist: 'a', seed: 3.7 }).fill.seed).toBe(3)
    expect(run({ artist: 'a', seed: -1 }).fill.seed).toBeNull()
    expect(run({ artist: 'a', seed: 'abc' }).fill.seed).toBeNull()
    expect(run({ artist: 'a' }).fill.seed).toBeNull()
  })

  it('透明背景：强制开关优先；否则看模型给的值', () => {
    expect(run({ artist: 'a' }, { transparent: true }).fill.transparentBackground).toBe(true)
    expect(run({ artist: 'a', transparent_background: true }).fill.transparentBackground).toBe(true)
    expect(run({ artist: 'a', transparent_background: 'true' }).fill.transparentBackground).toBe(true)
    expect(run({ artist: 'a', transparent_background: 'false' }).fill.transparentBackground).toBe(false)
    expect(run({ artist: 'a' }).fill.transparentBackground).toBe(false)
  })

  it('text 原样带出（只去掉换行与首尾空白），不做文本渲染处理', () => {
    expect(run({ artist: 'a', text: ' "天使"\n降临 ' }).fill.text).toBe('"天使" 降临')
  })

  it('角色：只在多角色工具时取；非对象跳过；追加默认负面词；坐标去空白；超上限的已被截断', () => {
    const args: JsonObject = {
      artist: 'a',
      characters: [
        { count: 'girl', character: 'miku', negative_prompt: 'bad hands', position: ' 0.3,0.5 ' },
        'junk',
        { count: 'boy', nltags: '一句\n话' },
        { count: 'other' },
      ],
    }
    const { fill, lines } = run(args, {
      withCharacters: true,
      multi: 'coords',
      config: { naiMaxCharacters: 3, naiCharDefaultNegative: 'lowres' },
    })
    expect(fill.characters).toHaveLength(2)
    expect(fill.characters[0]).toEqual({
      fields: { count: 'girl', character: 'miku', appearance: '', tags: '', nltags: '' },
      negative: 'bad hands, lowres',
      position: '0.3,0.5',
    })
    expect(fill.characters[1].negative).toBe('lowres')
    expect(lines).toContain('[I] [回填] 角色 3 的 nltags 里的换行已换成空格（编辑器每个块只有一行）')
    expect(run({ artist: 'a', characters: [{ count: 'girl' }] }).fill.characters).toEqual([])
  })

  it('使用坐标定位只在「手动指定坐标」时打开', () => {
    expect(run({ artist: 'a' }, { multi: 'coords' }).fill.useCoords).toBe(true)
    expect(run({ artist: 'a' }, { multi: 'auto' }).fill.useCoords).toBe(false)
    expect(run({ artist: 'a' }, { multi: 'off' }).fill.useCoords).toBe(false)
  })
})
