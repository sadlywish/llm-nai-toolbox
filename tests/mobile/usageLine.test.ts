import { describe, expect, it } from 'vitest'
import { formatUsageLine } from '../../src/mobile/src/usageLine'

function sub(percent: number, overrides: Partial<{ timeUntilNextPercent: number; isNegative: boolean }> = {}) {
  return {
    anlas: { fixed: 10000, purchased: 2345, total: 12345 },
    tier: 3,
    active: true,
    expiresAt: null,
    usage: { percent, timeUntilNextPercent: 312, isNegative: false, ...overrides },
  }
}

describe('formatUsageLine', () => {
  it('拼出点数、用量、张数与恢复速率', () => {
    const { text } = formatUsageLine(sub(87), 0.058)
    expect(text).toBe('点数 12,345 · V5 用量 87%（约 1,500 张） 每 5 分 12 秒 +1%')
  })

  it('低于 20% 标低量', () => {
    expect(formatUsageLine(sub(19), 0.058).low).toBe(true)
    expect(formatUsageLine(sub(20), 0.058).low).toBe(false)
  })

  it('每张消耗百分比为 0 时不显示张数', () => {
    const { text } = formatUsageLine(sub(87), 0)
    expect(text).not.toContain('张）')
    expect(text).toBe('点数 12,345 · V5 用量 87% 每 5 分 12 秒 +1%')
  })

  it('恢复速率未知（0 或负数）时不显示那一段', () => {
    const { text } = formatUsageLine(sub(87, { timeUntilNextPercent: 0 }), 0.058)
    expect(text).toBe('点数 12,345 · V5 用量 87%（约 1,500 张）')
  })

  it('usage 为负值（额度不可用）时不显示百分比与张数', () => {
    const { text, low } = formatUsageLine(sub(87, { isNegative: true }), 0.058)
    expect(text).toBe('点数 12,345 · 按时额度不可用（未订阅或已用尽）')
    expect(low).toBe(false)
  })

  it('没有按时额度（usage 为 null）时同样只显示点数', () => {
    const noUsage = { anlas: { fixed: 100, purchased: 0, total: 100 }, tier: 0, active: true, expiresAt: null, usage: null }
    expect(formatUsageLine(noUsage, 0.058).text).toBe('点数 100 · 按时额度不可用（未订阅或已用尽）')
  })
})
