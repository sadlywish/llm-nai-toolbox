import { useEffect } from 'react'
import {
  LOW_USAGE_PERCENT,
  estimateImages,
  formatCountNumber,
  formatDuration,
  tierName,
  type NaiSubscription,
} from '@shared/naiUser'
import { useNaiUsage } from '../state/naiUsage'

interface Props {
  /** 没填 Token 就不查——查了也只会拿回一条「未配置」 */
  hasNaiToken: boolean
  /** 设置里的每张消耗百分比；0 = 不估算张数 */
  percentPerImage: number
}

function anlasTitle(sub: NaiSubscription): string {
  const parts = [`每月赠送 ${formatCountNumber(sub.anlas.fixed)} + 购买 ${formatCountNumber(sub.anlas.purchased)}`]
  parts.push(sub.active ? tierName(sub.tier) : `${tierName(sub.tier)}（未激活）`)
  if (sub.expiresAt !== null) parts.push(`到期 ${new Date(sub.expiresAt).toLocaleDateString()}`)
  return parts.join(' · ')
}

/** 额度正文：点数 + V5 用量。usage 为空或不可用时只显示点数并说明 */
function Body({ sub, percentPerImage }: { sub: NaiSubscription; percentPerImage: number }): JSX.Element {
  const usage = sub.usage
  const low = usage !== null && !usage.isNegative && usage.percent < LOW_USAGE_PERCENT
  const images = usage === null ? null : estimateImages(usage.percent, percentPerImage)
  return (
    <>
      <span>点数</span>
      <span className="v" title={anlasTitle(sub)}>
        {formatCountNumber(sub.anlas.total)}
      </span>
      {usage === null || usage.isNegative ? (
        <span className="dim">按时额度不可用（未订阅或已用尽）</span>
      ) : (
        <>
          <span className="sep">·</span>
          <span>V5 用量</span>
          <span className={low ? 'v low' : 'v'}>
            {usage.percent}%{images !== null && `（约 ${formatCountNumber(images)} 张）`}
          </span>
          {low && <span className="low">余量偏低</span>}
          {usage.timeUntilNextPercent > 0 && (
            <span className="dim">每 {formatDuration(usage.timeUntilNextPercent)} +1%</span>
          )}
        </>
      )}
    </>
  )
}

/**
 * 顶栏的 NovelAI 额度条（界面稿 2026-09-16-nai-usage-mockup.html 位置 B）。
 * 查询失败只写一行红字，不弹窗、不拦出图——额度查不到不该影响干活。
 */
export default function NaiUsageBar({ hasNaiToken, percentPerImage }: Props): JSX.Element {
  const state = useNaiUsage((s) => s.state)
  const refresh = useNaiUsage((s) => s.refresh)

  // 启动后查一次；设置里刚填上 Token 也按「启动」算，立刻查
  useEffect(() => {
    if (hasNaiToken) void refresh()
  }, [hasNaiToken, refresh])

  return (
    <div className="nai-usage">
      {!hasNaiToken ? (
        <span className="dim">未配置 NovelAI Token，无法查询额度</span>
      ) : state.kind === 'loading' ? (
        <span className="dim">正在查询 NovelAI 额度…</span>
      ) : state.kind === 'error' ? (
        <span className="bad">{state.error.message}</span>
      ) : state.kind === 'ready' ? (
        <Body sub={state.subscription} percentPerImage={percentPerImage} />
      ) : (
        <span className="dim">额度未查询</span>
      )}
      <button
        type="button"
        className="nai-usage-refresh"
        title="刷新 NovelAI 额度"
        disabled={!hasNaiToken || state.kind === 'loading'}
        onClick={() => void refresh()}
      >
        ⟳
      </button>
    </div>
  )
}
