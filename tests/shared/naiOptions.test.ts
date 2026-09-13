import { describe, expect, it } from 'vitest'
import { MODEL_OPTIONS, NOISE_SCHEDULE_OPTIONS, SAMPLER_OPTIONS, alignTo64 } from '@shared/naiOptions'
import { defaultGenParams } from '@shared/workspace'

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
