import { describe, expect, it } from 'vitest'
import type { AssembledPrompt } from '../../../src/shared/gen'
import { defaultGenParams } from '../../../src/shared/workspace'
import { UC_PRESET_NONE, buildPayload, positionToCenter } from '../../../src/main/nai/payload'

describe('positionToCenter', () => {
  it('自由坐标，支持中文逗号，越界钳到 0~1', () => {
    expect(positionToCenter('0.3,0.5')).toEqual({ x: 0.3, y: 0.5 })
    expect(positionToCenter(' 0.2 ， 0.8 ')).toEqual({ x: 0.2, y: 0.8 })
    expect(positionToCenter('1.5,-2')).toEqual({ x: 1, y: 0 })
  })

  it('5×5 网格写法，大小写都认', () => {
    expect(positionToCenter('B3')).toEqual({ x: 0.3, y: 0.5 })
    expect(positionToCenter('e1')).toEqual({ x: 0.9, y: 0.1 })
  })

  it('空或认不出的写法居中', () => {
    expect(positionToCenter('')).toEqual({ x: 0.5, y: 0.5 })
    expect(positionToCenter('左边')).toEqual({ x: 0.5, y: 0.5 })
  })
})

describe('buildPayload', () => {
  const assembled: AssembledPrompt = {
    positive: '2girls , beach, no text',
    negative: 'lowres',
    characters: [
      { prompt: 'girl , skadi ,', negative: 'bad hands', center: { x: 0.3, y: 0.5 } },
      { prompt: 'girl , specter ,', negative: '', center: { x: 0.7, y: 0.5 } },
    ],
  }
  const base = { assembled, params: { ...defaultGenParams(), width: 830, height: 1210, steps: 23, scale: 7 }, useCoords: true, seed: 42, imageFormat: 'png' as const }

  it('顶层形状与模型', () => {
    const body = buildPayload(base)
    expect(body.input).toBe('2girls , beach, no text')
    expect(body.model).toBe('nai-diffusion-5-full')
    expect(body.action).toBe('generate')
  })

  it('参数：宽高对齐 64；不加负面预设与质量词；不开 Variety Boost', () => {
    const p = buildPayload(base).parameters
    expect([p.width, p.height, p.steps, p.scale, p.seed, p.n_samples]).toEqual([832, 1216, 23, 7, 42, 1])
    expect(p.ucPreset).toBe(UC_PRESET_NONE)
    expect(UC_PRESET_NONE).toBe(3)
    expect(p.qualityToggle).toBe(false)
    expect(p.skip_cfg_above_sigma).toBeNull()
    expect([p.prefer_brownian, p.deliberate_euler_ancestral_bug]).toEqual([true, false])
    expect([p.negative_prompt, p.image_format, p.params_version]).toEqual(['lowres', 'png', 3])
  })

  it('v4_prompt / v4_negative_prompt：角色正负各自成对，坐标相同', () => {
    const p = buildPayload(base).parameters
    expect(p.v4_prompt).toEqual({
      caption: {
        base_caption: '2girls , beach, no text',
        char_captions: [
          { char_caption: 'girl , skadi ,', centers: [{ x: 0.3, y: 0.5 }] },
          { char_caption: 'girl , specter ,', centers: [{ x: 0.7, y: 0.5 }] },
        ],
      },
      use_coords: true,
      use_order: true,
    })
    expect(p.v4_negative_prompt).toEqual({
      caption: {
        base_caption: 'lowres',
        char_captions: [
          { char_caption: 'bad hands', centers: [{ x: 0.3, y: 0.5 }] },
          { char_caption: '', centers: [{ x: 0.7, y: 0.5 }] },
        ],
      },
      legacy_uc: false,
    })
    expect(p.characterPrompts).toEqual([
      { prompt: 'girl , skadi ,', uc: 'bad hands', center: { x: 0.3, y: 0.5 }, enabled: true },
      { prompt: 'girl , specter ,', uc: '', center: { x: 0.7, y: 0.5 }, enabled: true },
    ])
  })

  it('没有角色时 use_coords 恒为 false', () => {
    const p = buildPayload({ ...base, assembled: { ...assembled, characters: [] } }).parameters
    expect((p.v4_prompt as { use_coords: boolean }).use_coords).toBe(false)
  })

  it('透明背景：开启才带 tag_hint_transparent_background 与 straight_alpha', () => {
    expect('straight_alpha' in buildPayload(base).parameters).toBe(false)
    const p = buildPayload({ ...base, params: { ...base.params, transparentBackground: true } }).parameters
    expect([p.tag_hint_transparent_background, p.straight_alpha]).toEqual([true, true])
  })
})
