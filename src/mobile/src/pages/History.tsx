// 历史页（计划 Task 16，界面稿第四节左边那张）：轮次列表 + 详情（那一轮的图与参数只读）。
//
// 历史只在电脑本地落盘，手机这边永远是「问一次拿一份快照」——没有独立的读写模型，
// 详情页里看图、放大、参数写回手机全部照搬 Task 15 出图页那一套（ImageViewer 与
// applyRoundToMobile），不另写一份判断逻辑。
import { useEffect, useState } from 'react'
import type { GenSnapshot, RoundRecord } from '@shared/gen'
import type { MobileMeta } from '@shared/mobileApi'
import type { Workspace } from '@shared/workspace'
import { messageOf, type ApiClient } from '../api'
import ImageViewer from '../components/ImageViewer'
import { applyRoundToMobile } from '../slots'
import { BACK_PRIORITY } from '../backStack'
import { summarize } from '../summarize'
import { useBackHandler } from '../useBackHandler'

interface Props {
  client: ApiClient
  meta: MobileMeta | null
  /** 「参数写回手机」落到手机这一份；这一页本身不显示当前工作区，不需要读它 */
  onWorkspaceChange: (update: (w: Workspace) => Workspace) => void
}

/** 详情页顶上那行只读参数：尺寸、步数、CFG、采样器（完整参数在大图的「本工具参数」页） */
function paramsLine(round: RoundRecord): string {
  const p = round.snapshot.params
  return `${p.width}×${p.height} · ${p.steps} 步 · CFG ${p.scale} · ${p.sampler}`
}

function RoundDetail({
  round,
  meta,
  client,
  onBack,
  onApply,
}: {
  round: RoundRecord
  meta: MobileMeta | null
  client: ApiClient
  onBack: () => void
  onApply: (snapshot: GenSnapshot, seed: number) => void
}): JSX.Element {
  const [viewIndex, setViewIndex] = useState<number | null>(null)
  const [applied, setApplied] = useState(false)

  const okCount = round.images.filter((i) => i.status === 'ok').length
  const failCount = round.images.filter((i) => i.status === 'failed').length
  // 一轮里各张共用同一份生成参数，只是 seed 不同；「参数写回手机」拿第一张成功的 seed，
  // 同桌面端「复制信息」默认拿第一张的逻辑一致（历史竖栏的缩略图也是这么挑的）
  const firstOk = round.images.find((i) => i.status === 'ok') ?? null
  const viewed = viewIndex === null ? null : (round.images.find((i) => i.index === viewIndex) ?? null)
  const params = round.snapshot.params
  const slotStyle = { aspectRatio: `${params.width} / ${params.height}` }

  const applyRound = (): void => {
    if (firstOk === null) return
    onApply(round.snapshot, firstOk.seed)
    setApplied(true)
    // 只是一句回执，两秒后自己退回去（同 ImageViewer 的「已写回手机」）
    setTimeout(() => setApplied(false), 2000)
  }

  return (
    <div className="gen-page">
      <div className="history-bar">
        <button type="button" className="btn sm" onClick={onBack}>
          ‹ 历史
        </button>
        <span className="grow" />
      </div>

      <p className="sec">
        {paramsLine(round)} · 成功 {okCount}
        {failCount > 0 && ` · 失败 ${failCount}`}
      </p>

      {round.images.length === 0 ? (
        <p className="hint">这一轮没有留下图片记录。</p>
      ) : (
        <div className="gen-grid">
          {round.images.map((img) =>
            img.status === 'ok' ? (
              <img
                key={img.index}
                className="gen-slot"
                style={slotStyle}
                src={client.imageUrl(round.startedAt, img.file, 'thumb')}
                alt={`第 ${img.index + 1} 张`}
                loading="lazy"
                onClick={() => setViewIndex(img.index)}
              />
            ) : (
              <div key={img.index} className="gen-slot is-failed" style={slotStyle}>
                {img.error ?? '这张没出来'}
              </div>
            ),
          )}
        </div>
      )}

      <button type="button" className="btn" disabled={firstOk === null} onClick={applyRound}>
        {applied ? '已写回手机' : '参数写回手机'}
      </button>

      {viewed !== null && viewed.status === 'ok' && (
        <ImageViewer
          index={viewed.index}
          file={viewed.file}
          seed={viewed.seed}
          round={round}
          meta={meta}
          client={client}
          onClose={() => setViewIndex(null)}
          onApply={onApply}
        />
      )}
    </div>
  )
}

export default function History({ client, meta, onWorkspaceChange }: Props): JSX.Element {
  const [rounds, setRounds] = useState<RoundRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // 详情页按返回键回列表（同左上角「‹ 历史」），再按才回工作台
  useBackHandler(selectedId !== null, () => setSelectedId(null), BACK_PRIORITY.subpage)
  // 点一下「刷新」就把它加一，effect 依赖它重新拉一次——不额外造一个 refresh() 函数存到 state 里
  const [refreshSignal, setRefreshSignal] = useState(0)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    client
      .history()
      .then((r) => {
        if (alive) setRounds(r)
      })
      .catch((err: unknown) => {
        if (alive) setError(messageOf(err))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [client, refreshSignal])

  const applyParams = (snapshot: GenSnapshot, seed: number): void => {
    onWorkspaceChange((w) => applyRoundToMobile(w, snapshot, seed))
  }

  const selected = selectedId === null ? null : (rounds?.find((r) => r.id === selectedId) ?? null)
  if (selected !== null) {
    return <RoundDetail round={selected} meta={meta} client={client} onBack={() => setSelectedId(null)} onApply={applyParams} />
  }

  return (
    <div className="gen-page">
      <div className="history-bar">
        <span className="sec">最近 30 天</span>
        <span className="grow" />
        <button type="button" className="btn sm" onClick={() => setRefreshSignal((n) => n + 1)}>
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      {error !== null && <p className="alert">{error}</p>}

      {rounds === null ? (
        <p className="hint">正在读历史…</p>
      ) : rounds.length === 0 ? (
        <p className="hint">还没有出过图</p>
      ) : (
        <ul className="history-list">
          {rounds.map((round) => {
            const { title, sub } = summarize(round, new Date())
            const firstOk = round.images.find((i) => i.status === 'ok') ?? null
            return (
              <li key={round.id}>
                <button type="button" className="history-item" onClick={() => setSelectedId(round.id)}>
                  {firstOk === null ? (
                    <div className="history-thumb empty" />
                  ) : (
                    <img
                      className="history-thumb"
                      src={client.imageUrl(round.startedAt, firstOk.file, 'thumb')}
                      alt=""
                      loading="lazy"
                    />
                  )}
                  <div className="history-body">
                    <div className="history-title">{title}</div>
                    <div className="history-sub">{sub}</div>
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
