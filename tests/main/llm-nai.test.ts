import { describe, expect, it } from 'vitest'
import { defaultAppConfig } from '../../src/shared/config'
import {
  calcNaiDimensions,
  extractLoras,
  finalizeArgs,
  multiCharacterAddendum,
  normalizeNaiArtists,
  stripLoras,
  stripUnsupportedLoras,
} from '../../src/main/llm/nai'
import type { JsonObject } from '../../src/main/llm/types'
import { PIXEL_PRESETS } from '../../src/shared/naiOptions'

describe('normalizeNaiArtists', () => {
  it('词首的 @ 换成 artist:，含权重与括号写法', () => {
    expect(normalizeNaiArtists('@wlop, @ask')).toBe('artist:wlop, artist:ask')
    expect(normalizeNaiArtists('1.5::@jima ::')).toBe('1.5::artist:jima ::')
    expect(normalizeNaiArtists('{@fkey}')).toBe('{artist:fkey}')
    expect(normalizeNaiArtists('(@halcon:0.8)')).toBe('(artist:halcon:0.8)')
  })

  it('@@ 与 \\@ 是字面 @；词中间的 @ 不动', () => {
    expect(normalizeNaiArtists('@@_@')).toBe('@_@')
    expect(normalizeNaiArtists('\\@name')).toBe('@name')
    expect(normalizeNaiArtists('e-mail@example')).toBe('e-mail@example')
  })
})

describe('LoRA', () => {
  it('提取与剥离', () => {
    expect(extractLoras('a, <lora:x:0.8>, <LORA:y>')).toEqual(['<lora:x:0.8>', '<LORA:y>'])
    expect(stripLoras('a, <lora:x:0.8>, b')).toBe('a , b')
  })

  it('画风预设剥掉 LoRA；整段都是 LoRA 时为空', () => {
    expect(stripUnsupportedLoras('<lora:a:1>, wlop')).toEqual({ style: 'wlop', removed: ['<lora:a:1>'] })
    expect(stripUnsupportedLoras('<lora:a:1>')).toEqual({ style: '', removed: ['<lora:a:1>'] })
    expect(stripUnsupportedLoras('wlop')).toEqual({ style: 'wlop', removed: [] })
  })
})

describe('calcNaiDimensions', () => {
  it('按像素上限反推并对齐到 64', () => {
    expect(calcNaiDimensions('1:1', 1048576)).toEqual([1024, 1024])
    expect(calcNaiDimensions('16:9', 1048576)).toEqual([1344, 768])
  })

  it('对齐后超出上限时逐步收缩（2:3 对齐出 832×1280，收缩到 832×1216）', () => {
    expect(calcNaiDimensions('2:3', 1048576)).toEqual([832, 1216])
  })

  it('比例写坏了按 1:1', () => {
    expect(calcNaiDimensions('abc', 1048576)).toEqual([1024, 1024])
  })

  it('三个像素上限预设在各自的官网比例上换算回官网尺寸', () => {
    const px = (id: string): number => PIXEL_PRESETS.find((p) => p.id === id)!.pixels
    expect(calcNaiDimensions('2:3', px('normal'))).toEqual([832, 1216])
    expect(calcNaiDimensions('1:1', px('large'))).toEqual([1472, 1472])
    expect(calcNaiDimensions('16:9', px('wallpaper'))).toEqual([1920, 1088])
    expect(calcNaiDimensions('9:16', px('wallpaper'))).toEqual([1088, 1920])
  })
})

describe('finalizeArgs', () => {
  const config = { ...defaultAppConfig(), naiMaxCharacters: 2 }

  it('画师前缀归一并记一条说明；就地修改', () => {
    const args: JsonObject = { artist: '@wlop, ask' }
    const notes = finalizeArgs(args, config)
    expect(args.artist).toBe('artist:wlop, ask')
    expect(notes).toEqual(['画师前缀归一: "@wlop, ask" → "artist:wlop, ask"'])
  })

  it('各字段里的 LoRA 剥掉', () => {
    const args: JsonObject = { tags: 'smile, <lora:x:1>' }
    expect(finalizeArgs(args, config)).toEqual(['已移除 LoRA 调用（NovelAI 不支持）: <lora:x:1>'])
    expect(extractLoras(String(args.tags))).toEqual([])
  })

  it('多角色：角色层写了名字时移除顶层 character；都没写时保留并说明', () => {
    const a: JsonObject = { character: 'saber', characters: [{ character: 'saber' }] }
    expect(finalizeArgs(a, config)[0]).toContain('顶层 character 应留空，已移除: saber')
    expect(a.character).toBeUndefined()
    const b: JsonObject = { character: 'saber', characters: [{ count: 'girl' }] }
    expect(finalizeArgs(b, config)[0]).toContain('已保留以免丢失')
    expect(b.character).toBe('saber')
  })

  it('角色数超过上限截断', () => {
    const args: JsonObject = { characters: [{}, {}, {}] }
    expect(finalizeArgs(args, config)).toContain('角色数 3 超过上限 2，已截断')
    expect(args.characters).toHaveLength(2)
  })

  it('角色里混入的整图内容剔除：画风类字段整删，分级与质量词逐标签删', () => {
    const args: JsonObject = {
      quality: 'masterpiece, best quality',
      characters: [{ count: 'girl, rating:general', artist: 'x', environment: 'beach', tags: 'smile, masterpiece' }],
    }
    const notes = finalizeArgs(args, config)
    expect(args.characters).toEqual([{ count: 'girl', tags: 'smile' }])
    expect(notes).toContain('角色提示词中混入的整图内容已剔除: artist, environment, rating:general, masterpiece')
  })

  it('角色数组里不是对象的元素跳过，不抛错', () => {
    expect(() => finalizeArgs({ characters: ['x', null, { tags: 'a' }] }, config)).not.toThrow()
  })
})

describe('multiCharacterAddendum', () => {
  const config = { ...defaultAppConfig(), naiCharSystemPrompt: 'EXTRA' }

  it('关闭多角色时为空', () => {
    expect(multiCharacterAddendum(config, 'off')).toBe('')
  })

  it('位置由模型安排：带「未启用坐标定位」说明，并指向界面上的选项而不是命令名', () => {
    const text = multiCharacterAddendum(config, 'auto')
    expect(text).toContain('[多角色模式已启用]')
    expect(text).toContain('本次未启用坐标定位')
    expect(text).toContain('「手动指定坐标」')
    expect(text).not.toContain('-R')
  })

  it('手动指定坐标：不带那段说明；设置里的多角色附加接在最后', () => {
    const text = multiCharacterAddendum(config, 'coords')
    expect(text).not.toContain('未启用坐标定位')
    expect(text.endsWith('\nEXTRA')).toBe(true)
  })
})
