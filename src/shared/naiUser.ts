/**
 * NovelAI 账号额度：剩余点数（Anlas）与 V5 起的按时限额（官方称 usage，插件里叫「体力条」）。
 * 两样都在 `GET {naiBaseUrl}/user/subscription` 的一次响应里，移植自插件 src/backend/nai-usage.ts。
 *
 * 注意接口地址：账号端点必须走 image.novelai.net——api.novelai.net 上这些端点已停用，
 * 会返回 400 "Please refresh NovelAI.net…"。本工程的 naiBaseUrl 默认就是 image.novelai.net。
 */

export interface NaiUsage {
  /** 剩余百分比 [0, 100] */
  percent: number
  /**
   * 恢复 1% 所需的秒数——**不是倒计时**。官方注释 "always +1% offset from now" 指的是
   * 从任意当前值再涨 1% 要多久，是个恒定的速率量（插件实测 150 秒内三次采样零变化）。
   * 所以文案写「每 X +1%」，不能写成「X 后 +1%」。
   */
  timeUntilNextPercent: number
  /** true = 该额度不可用（没订阅按时点数或已用尽） */
  isNegative: boolean
}

export interface NaiAnlas {
  /** 订阅每月给的 */
  fixed: number
  /** 自己买的 */
  purchased: number
  total: number
}

export interface NaiSubscription {
  anlas: NaiAnlas
  /** 官方档位号：0 Paper / 1 Tablet / 2 Scroll / 3 Opus；缺失为 null */
  tier: number | null
  active: boolean
  /** 到期时间（毫秒）；缺失为 null */
  expiresAt: number | null
  /** 没有按时限额（老订阅、接口没给）时为 null */
  usage: NaiUsage | null
}

export type NaiSubscriptionErrorKind = 'no-token' | 'network' | 'timeout' | 'http' | 'unauthorized' | 'invalid'

export interface NaiSubscriptionError {
  kind: NaiSubscriptionErrorKind
  /** 可直接展示的一行中文；界面只写一行红字，不弹窗 */
  message: string
}

export type NaiSubscriptionResult =
  | { ok: true; subscription: NaiSubscription }
  | { ok: false; error: NaiSubscriptionError }

/** 余量低于这个百分比就在界面上标黄 */
export const LOW_USAGE_PERCENT = 20

const TIER_NAMES: Record<number, string> = { 0: 'Paper', 1: 'Tablet', 2: 'Scroll', 3: 'Opus' }

export function tierName(tier: number | null): string {
  return tier === null ? '未知档位' : (TIER_NAMES[tier] ?? `档位 ${tier}`)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * 响应 JSON → NaiSubscription；形状对不上返回 null。
 * usage 在 /user/subscription 是顶层字段，/user/data 则包在 subscription 下，两处都认。
 */
export function parseSubscription(raw: unknown): NaiSubscription | null {
  if (!isRecord(raw)) return null
  const sub = isRecord(raw.subscription) ? raw.subscription : raw
  const steps = isRecord(sub.trainingStepsLeft) ? sub.trainingStepsLeft : null
  // 点数是这个功能的主角：连它都没有就说明响应根本不是订阅信息（常见于中转端点返回的错误页）
  if (steps === null) return null
  const fixed = num(steps.fixedTrainingStepsLeft)
  const purchased = num(steps.purchasedTrainingSteps)
  const rawUsage = isRecord(raw.usage) ? raw.usage : isRecord(sub.usage) ? sub.usage : null
  const usage =
    rawUsage !== null && typeof rawUsage.percent === 'number'
      ? {
          percent: rawUsage.percent,
          timeUntilNextPercent: num(rawUsage.timeUntilNextPercent),
          isNegative: rawUsage.isNegative === true,
        }
      : null
  return {
    anlas: { fixed, purchased, total: fixed + purchased },
    tier: typeof sub.tier === 'number' ? sub.tier : null,
    active: sub.active === true,
    expiresAt: typeof sub.expiresAt === 'number' ? sub.expiresAt * 1000 : null,
    usage,
  }
}

/**
 * 还能画几张。官方接口**只给百分比、不给张数**，只能按「每张消耗百分比」换算，
 * 这个值要用户按实测填（设置 naiUsagePercentPerImage），填 0 就不估算。
 */
export function estimateImages(percent: number, percentPerImage: number): number | null {
  if (!(percentPerImage > 0)) return null
  return Math.max(0, Math.floor(percent / percentPerImage))
}

/** 千分位，点数与张数都用 */
export function formatCountNumber(n: number): string {
  return n.toLocaleString('en-US')
}

/** 恢复速率的时长：3 小时 5 分 / 5 分 12 秒 / 42 秒 */
export function formatDuration(seconds: number): string {
  if (!(seconds > 0)) return '未知'
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h} 小时 ${m} 分`
  if (m > 0) return `${m} 分 ${sec} 秒`
  return `${sec} 秒`
}
