import { useEffect } from 'react'
import type { RoundRecord, RunProgress } from '@shared/gen'
import { formatRoundTime } from '../formatTime'
import { useRoundImages } from '../hooks/useRoundImages'
import { mergeHistoryWithProgress, useGen } from '../state/gen'

/** 状态徽标：live 非空时以它为准（更实时），否则用磁盘上的状态；完成不写 */
function statusBadge(round: RoundRecord, live: RunProgress | null): string {
  const status = live ? live.status : round.status
  switch (status) {
    case 'running':
      return live ? `进行中 ${live.done + live.failed}/${live.total}` : '进行中'
    case 'paused':
      return '已暂停'
    case 'cancelled':
      return '已取消'
    case 'aborted':
      return '已中止'
    case 'interrupted':
      return '已中断'
    default:
      return ''
  }
}

/** 缩略图取这一轮第一张成功的图；活跃轮次用实时事件里的，历史轮次用磁盘记录里的 */
function Thumbnail({ round, file }: { round: RoundRecord; file: string | null }): JSX.Element {
  const states = useRoundImages(round.startedAt, file === null ? [] : [file])
  const state = file === null ? undefined : states[file]
  if (state?.kind !== 'ready') return <div className="history-thumb history-thumb-empty" />
  return <img className="history-thumb" src={state.url} alt="" />
}

/**
 * 历史竖栏（照画师串工具箱）。启动时从磁盘读最近几天，跑图期间与 useGen.progress 合并显示——
 * 当前活跃的那一轮永远排在最前面并实时走进度。点条目打开那一轮的出图弹窗。
 */
export default function HistoryRail(): JSX.Element {
  const history = useGen((s) => s.history)
  const progress = useGen((s) => s.progress)
  const starting = useGen((s) => s.starting)
  const liveImages = useGen((s) => s.images)
  const loadHistory = useGen((s) => s.loadHistory)
  const openRound = useGen((s) => s.openRound)
  const resume = useGen((s) => s.resume)

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  const entries = mergeHistoryWithProgress(history, progress, starting)

  return (
    <aside className="history-rail">
      <div className="rail-title">历史</div>
      {entries.length === 0 ? (
        <div className="placeholder">跑图后在此显示</div>
      ) : (
        <ul className="history-list">
          {entries.map(({ round, live }) => {
            const records = live ? Object.values(liveImages) : round.images
            const okCount = live ? live.done : round.images.filter((i) => i.status === 'ok').length
            const failCount = live ? live.failed : round.images.filter((i) => i.status === 'failed').length
            const paused = (live ? live.status : round.status) === 'paused'
            const firstOk = [...records].sort((a, b) => a.index - b.index).find((i) => i.status === 'ok') ?? null
            return (
              <li key={round.id} className={`history-entry ${paused ? 'is-paused' : ''}`} onClick={() => openRound(round.id)}>
                <div className="history-entry-top">
                  <Thumbnail round={round} file={firstOk?.file ?? null} />
                  <div className="history-entry-body">
                    <div className="history-entry-time">{formatRoundTime(round.startedAt)}</div>
                    <div className="history-entry-meta">
                      {round.count} 张 · {round.snapshot.params.width}×{round.snapshot.params.height}
                    </div>
                    <div className="history-entry-counts">
                      成功 {okCount} · 失败 {failCount}
                    </div>
                    <div className="history-entry-status">{statusBadge(round, live)}</div>
                  </div>
                </div>
                {paused && (
                  <div className="history-entry-actions">
                    <button
                      type="button"
                      className="history-entry-resume"
                      onClick={(e) => {
                        e.stopPropagation()
                        void resume()
                      }}
                    >
                      继续
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </aside>
  )
}
