import { describe, expect, it } from 'vitest'
import { clampParams } from '../../src/mobile/src/clampParams'
import { defaultGenParams } from '../../src/shared/workspace'

/**
 * 参数页宽高约束的测试。基准参数是 1024×1024（defaultGenParams 的默认值），
 * 上限用 1024×1024 与更小的值分别验证「只对齐」与「按比例缩」两条路径。
 */
describe('clampParams', () => {
  const base = defaultGenParams()
  const maxPixels = 1024 * 1024

  it('宽高对齐到 64 的倍数', () => {
    const p = clampParams({ ...base, width: 830, height: 1024 }, maxPixels)
    expect(p.width).toBe(832)
    expect(p.height).toBe(1024)
  })

  it('对齐后仍未超限时不触发缩放', () => {
    const p = clampParams({ ...base, width: 750, height: 750 }, maxPixels)
    // 750 对齐到 768（四舍五入到最近的 64 倍数），乘积远小于上限
    expect(p.width).toBe(768)
    expect(p.height).toBe(768)
  })

  it('总像素超上限时按比例缩回去，且结果仍是 64 的倍数', () => {
    const p = clampParams({ ...base, width: 1600, height: 1600 }, maxPixels)
    expect(p.width * p.height).toBeLessThanOrEqual(maxPixels)
    expect(p.width % 64).toBe(0)
    expect(p.height % 64).toBe(0)
    // 原图是正方形，缩放要保持比例，不能因为对齐把它挤成长方形
    expect(p.width).toBe(p.height)
  })

  it('非方形超限也按比例缩，宽高比大致保持', () => {
    const p = clampParams({ ...base, width: 2000, height: 1000 }, maxPixels)
    expect(p.width * p.height).toBeLessThanOrEqual(maxPixels)
    const ratio = p.width / p.height
    expect(ratio).toBeGreaterThan(1.8)
    expect(ratio).toBeLessThan(2.2)
  })

  it('不改动宽高以外的字段', () => {
    const p = clampParams({ ...base, steps: 30, seed: 42 }, maxPixels)
    expect(p.steps).toBe(30)
    expect(p.seed).toBe(42)
  })
})
