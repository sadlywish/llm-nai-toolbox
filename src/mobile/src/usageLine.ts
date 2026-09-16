// 顶部额度行的文案拼接（计划 Task 13）。抽成纯函数是因为 vitest 的手机端测试跑在
// node 环境下（vitest.config.ts 没接 jsdom），拼文案的逻辑不能留在 .tsx 组件里，否则测不到。
import { LOW_USAGE_PERCENT, estimateImages, formatCountNumber, formatDuration, type NaiSubscription } from '@shared/naiUser'

export interface UsageLineText {
  /** 显示用的完整一行，如「点数 12,345 · V5 用量 87%（约 1,500 张） 每 5 分 12 秒 +1%」 */
  text: string
  /** 余量低于 LOW_USAGE_PERCENT，界面上标黄 */
  low: boolean
}

/**
 * 与桌面端顶栏 `NaiUsageBar` 的 `Body` 同一套文案，只是拼成一整行而不是分段 JSX——
 * 手机顶部空间窄，没有必要也没有地方分好几段展示。
 */
export function formatUsageLine(sub: NaiSubscription, percentPerImage: number): UsageLineText {
  const points = `点数 ${formatCountNumber(sub.anlas.total)}`
  const usage = sub.usage
  if (usage === null || usage.isNegative) {
    return { text: `${points} · 按时额度不可用（未订阅或已用尽）`, low: false }
  }
  // percentPerImage 为 0（没配置或用户没填过）时 estimateImages 给 null，这里不显示张数，
  // 不是显示「约 0 张」——0 张会让人以为额度已经耗尽
  const images = estimateImages(usage.percent, percentPerImage)
  const imagesSuffix = images === null ? '' : `（约 ${formatCountNumber(images)} 张）`
  const rateSuffix = usage.timeUntilNextPercent > 0 ? ` 每 ${formatDuration(usage.timeUntilNextPercent)} +1%` : ''
  return {
    text: `${points} · V5 用量 ${usage.percent}%${imagesSuffix}${rateSuffix}`,
    low: usage.percent < LOW_USAGE_PERCENT,
  }
}
