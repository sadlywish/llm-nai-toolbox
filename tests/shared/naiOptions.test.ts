import { describe, expect, it } from 'vitest'
import {
  MODEL_OPTIONS,
  NOISE_SCHEDULE_OPTIONS,
  OPUS_FREE_MAX_PIXELS,
  PIXEL_PRESETS,
  SAMPLER_OPTIONS,
  alignTo64,
  exceedsOpusFree,
  pixelPresetOf,
} from '@shared/naiOptions'
import { defaultGenParams } from '@shared/workspace'

describe('PIXEL_PRESETS', () => {
  it('按 NAI 官网：Normal 1024×1024、Large 方图 1472×1472、Wallpaper 1920×1088', () => {
    expect(PIXEL_PRESETS.map((p) => [p.id, p.size, p.pixels])).toEqual([
      ['normal', '1024×1024', 1048576],
      ['large', '1472×1472', 2166784],
      ['wallpaper', '1920×1088', 2088960],
    ])
  })
})

describe('pixelPresetOf', () => {
  it('值恰好等于某个预设时返回它的 id', () => {
    expect(pixelPresetOf(1048576)).toBe('normal')
    expect(pixelPresetOf(2166784)).toBe('large')
    expect(pixelPresetOf(2088960)).toBe('wallpaper')
  })

  it('不等于任何预设（含非法值）时返回 null = 手动设置', () => {
    expect(pixelPresetOf(1300000)).toBeNull()
    expect(pixelPresetOf(1048577)).toBeNull()
    expect(pixelPresetOf(Number.NaN)).toBeNull()
  })
})

describe('exceedsOpusFree', () => {
  it('总像素超过 1024×1024 才算超出 Opus 免费范围', () => {
    expect(OPUS_FREE_MAX_PIXELS).toBe(1048576)
    expect(exceedsOpusFree(1024, 1024)).toBe(false)
    expect(exceedsOpusFree(832, 1216)).toBe(false)
    expect(exceedsOpusFree(1024, 1088)).toBe(true)
    expect(exceedsOpusFree(1472, 1472)).toBe(true)
  })
})

describe('alignTo64', () => {
  it('四舍五入到 64 的倍数', () => {
    expect(alignTo64(832)).toBe(832)
    expect(alignTo64(1000)).toBe(1024)
    expect(alignTo64(1023)).toBe(1024)
    expect(alignTo64(990)).toBe(960)
  })

  it('下限 64', () => {
    expect(alignTo64(10)).toBe(64)
    expect(alignTo64(0)).toBe(64)
  })
})

describe('选项表', () => {
  it('默认参数的每个枚举值都在选项表里 —— 否则下拉框会显示成空白', () => {
    const p = defaultGenParams()
    expect(MODEL_OPTIONS.map((m) => m.value)).toContain(p.model)
    expect(SAMPLER_OPTIONS).toContain(p.sampler)
    expect(NOISE_SCHEDULE_OPTIONS).toContain(p.noiseSchedule)
  })
})
