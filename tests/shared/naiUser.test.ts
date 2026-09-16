import { describe, expect, it } from 'vitest'
import {
  LOW_USAGE_PERCENT,
  estimateImages,
  formatCountNumber,
  formatDuration,
  parseSubscription,
  tierName,
} from '@shared/naiUser'

/** /user/subscription 的真实形状（截取用得到的字段） */
const raw = {
  tier: 3,
  active: true,
  expiresAt: 1790000000,
  trainingStepsLeft: { fixedTrainingStepsLeft: 8000, purchasedTrainingSteps: 4345 },
  usage: { percent: 87, timeUntilNextPercent: 312, isNegative: false },
}

describe('parseSubscription', () => {
  it('点数是「每月赠送 + 购买」，用量、档位、到期一并取出（到期换成毫秒）', () => {
    expect(parseSubscription(raw)).toEqual({
      anlas: { fixed: 8000, purchased: 4345, total: 12345 },
      tier: 3,
      active: true,
      expiresAt: 1790000000 * 1000,
      usage: { percent: 87, timeUntilNextPercent: 312, isNegative: false },
    })
  })

  it('usage 包在 subscription 下（/user/data 的形状）也认', () => {
    const nested = { subscription: { ...raw, usage: undefined }, usage: raw.usage }
    expect(parseSubscription(nested)?.usage).toEqual(raw.usage)
    const inSub = { subscription: raw }
    expect(inSub.subscription.usage).toEqual(raw.usage)
    expect(parseSubscription(inSub)?.usage).toEqual(raw.usage)
  })

  it('没有 usage 字段（老订阅）：点数照样解析，usage 为 null', () => {
    const { usage, ...noUsage } = raw
    expect(usage).toBeDefined()
    const parsed = parseSubscription(noUsage)
    expect(parsed?.anlas.total).toBe(12345)
    expect(parsed?.usage).toBeNull()
  })

  it('isNegative 与缺项：缺的按 0 / false 补', () => {
    const parsed = parseSubscription({
      trainingStepsLeft: { fixedTrainingStepsLeft: 5 },
      usage: { percent: 0, isNegative: true },
    })
    expect(parsed).toEqual({
      anlas: { fixed: 5, purchased: 0, total: 5 },
      tier: null,
      active: false,
      expiresAt: null,
      usage: { percent: 0, timeUntilNextPercent: 0, isNegative: true },
    })
  })

  it('没有 trainingStepsLeft 就不是订阅信息（中转端点返回的错误页）→ null', () => {
    expect(parseSubscription({ usage: raw.usage })).toBeNull()
    expect(parseSubscription('<html>')).toBeNull()
    expect(parseSubscription(null)).toBeNull()
  })
})

describe('估算与文案', () => {
  it('estimateImages 按每张消耗百分比换算，向下取整', () => {
    expect(estimateImages(87, 0.058)).toBe(1500)
    expect(estimateImages(1, 0.058)).toBe(17)
    expect(estimateImages(0, 0.058)).toBe(0)
  })

  it('每张消耗填 0 或负数 → 不估算', () => {
    expect(estimateImages(87, 0)).toBeNull()
    expect(estimateImages(87, -1)).toBeNull()
  })

  it('恢复速率按时长分档；0 或负数写「未知」', () => {
    expect(formatDuration(312)).toBe('5 分 12 秒')
    expect(formatDuration(42)).toBe('42 秒')
    expect(formatDuration(7888)).toBe('2 小时 11 分')
    expect(formatDuration(0)).toBe('未知')
  })

  it('点数与张数带千分位', () => {
    expect(formatCountNumber(12345)).toBe('12,345')
    expect(formatCountNumber(0)).toBe('0')
  })

  it('档位名', () => {
    expect([tierName(0), tierName(3), tierName(9), tierName(null)]).toEqual(['Paper', 'Opus', '档位 9', '未知档位'])
  })

  it('低余量线是 20%', () => {
    expect(LOW_USAGE_PERCENT).toBe(20)
  })
})
