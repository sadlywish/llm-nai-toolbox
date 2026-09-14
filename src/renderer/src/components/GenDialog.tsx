import { useEffect, useState } from 'react'
import type { FieldSpec } from '@shared/fields'
import type { ImageRecord } from '@shared/gen'
import type { Workspace } from '@shared/workspace'
import { formatRoundTime } from '../formatTime'
import { galleryLayout } from '../galleryLayout'
import { useRoundImages } from '../hooks/useRoundImages'
import { mergeHistoryWithProgress, useGen } from '../state/gen'
import ImageViewer from '../viewer/ImageViewer'
import GenInspector from './GenInspector'

/** 一个格子的展示态（照工具箱 RunGrid 的 SlotState） */
type SlotState =
  | { kind: 'not-started' }
  | { kind: 'pending' }
  | { kind: 'running' }
  | { kind: 'failed'; error: string | null }
  | { kind: 'missing' }
  | { kind: 'ready'; url: string; record: ImageRecord }

interface Props {
  mainSpecs: readonly FieldSpec[]
  charSpecs: readonly FieldSpec[]
  update: (fn: (draft: Workspace) => void) => void
}

/**
 * 出图弹窗（照工具箱 RunMatrixDialog）：点「生成」自动弹出，图一张张填进格子；关闭只改 dialogOpen，
 * 队列该怎么跑还怎么跑。历史竖栏能点开任意一轮：命中当前活跃的 roundId 走实时数据，否则按磁盘快照只读展示。
 */
export default function GenDialog({ mainSpecs, charSpecs, update }: Props): JSX.Element | null {
  const dialogOpen = useGen((s) => s.dialogOpen)
  const closeDialog = useGen((s) => s.closeDialog)
  const progress = useGen((s) => s.progress)
  const history = useGen((s) => s.history)
  const viewingRoundId = useGen((s) => s.viewingRoundId)
  const starting = useGen((s) => s.starting)
  const liveImages = useGen((s) => s.images)
  const resume = useGen((s) => s.resume)
  const cancel = useGen((s) => s.cancel)

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [viewer, setViewer] = useState<{ url: string; alt: string } | null>(null)

  // 格子区域的实际尺寸：排版按它试算列数。用回调 ref——网格要等弹窗打开、轮次就绪才挂上，
  // 挂载时就取 ref 的写法会错过它；打开/关闭溯源侧栏改变宽度时 ResizeObserver 会再报一次
  const [gridEl, setGridEl] = useState<HTMLDivElement | null>(null)
  const [gridSize, setGridSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    if (!gridEl) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setGridSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(gridEl)
    return () => observer.disconnect()
  }, [gridEl])

  // viewingRoundId 为 null 表示「看当前活跃的那一轮」
  const effectiveRoundId = viewingRoundId ?? progress?.roundId ?? null

  // 换了一轮：之前选中的那张与查看器用的 URL 都不属于这一轮了，必须跟着清掉
  useEffect(() => {
    setSelectedIndex(null)
    setViewer(null)
  }, [effectiveRoundId])

  const isLive = effectiveRoundId !== null && effectiveRoundId === progress?.roundId
  const round = isLive
    ? (mergeHistoryWithProgress(history, progress, starting).find((e) => e.live !== null)?.round ?? null)
    : (history.find((r) => r.id === effectiveRoundId) ?? null)
  const stillRunning = isLive && (progress?.status === 'running' || progress?.status === 'paused')
  const records: ImageRecord[] = round === null ? [] : isLive ? Object.values(liveImages) : round.images
  const images = useRoundImages(
    round?.startedAt ?? null,
    records.filter((r) => r.status === 'ok').map((r) => r.file),
  )

  if (!dialogOpen) return null

  function slotFor(index: number): SlotState {
    const rec = records.find((r) => r.index === index)
    if (!rec) {
      if (!isLive) return { kind: 'not-started' }
      if (progress?.current === index) return { kind: 'running' }
      // 队列已经结束而这一格还没有记录：这张根本没轮到，不是「进行中」
      return stillRunning ? { kind: 'pending' } : { kind: 'not-started' }
    }
    if (rec.status === 'failed') return { kind: 'failed', error: rec.error }
    const state = images[rec.file]
    if (state === undefined || state.kind === 'loading') return { kind: 'pending' }
    if (state.kind === 'missing') return { kind: 'missing' }
    return { kind: 'ready', url: state.url, record: rec }
  }

  const params = round?.snapshot.params
  const slotStyle = params ? { aspectRatio: `${params.width} / ${params.height}` } : undefined
  const layout =
    round !== null && params
      ? galleryLayout({ count: round.count, aspect: params.width / params.height, width: gridSize.width, height: gridSize.height })
      : null
  const gridStyle = layout
    ? {
        gridTemplateColumns: `repeat(${layout.columns}, ${layout.slotWidth}px)`,
        justifyContent: 'center',
        // 装得下才垂直居中：装不下时居中会让顶上几行滚不回去
        alignContent: layout.fits ? 'center' : 'start',
      }
    : undefined
  const selectedSlot = selectedIndex === null ? null : slotFor(selectedIndex)
  const inspected = round !== null && selectedSlot?.kind === 'ready' ? { round, record: selectedSlot.record, url: selectedSlot.url } : null

  return (
    <div className="dialog-backdrop">
      <div className="dialog gen-dialog">
        <button type="button" className="dialog-close" title="关闭（不中断任务）" onClick={closeDialog}>
          ×
        </button>
        <div className="dialog-title">出图{round !== null ? ` · ${formatRoundTime(round.startedAt)}` : ''}</div>

        {/* 跑图过程中在标题下面直说「正在生成第几张」：格子会亮，但不一定注意得到 */}
        {isLive && progress?.status === 'running' && (
          <div className="gen-running-bar" role="status">
            <span>{progress.current === null ? '准备中…' : `正在生成第 ${progress.current + 1} 张`}</span>
            <span className="gen-running-count">
              {progress.done + progress.failed} / {progress.total}
              {progress.failed > 0 && ` · 失败 ${progress.failed}`}
            </span>
            {/* 点「生成」后弹窗自动打开、盖住参数区的按钮，所以弹窗里也要有一个够大的取消 */}
            <button type="button" className="big-btn is-cancel" onClick={() => void cancel()}>
              取消
            </button>
          </div>
        )}

        {isLive && progress?.status === 'paused' && (
          <div className="gen-paused-bar">
            <span>已暂停 · 并发冲突</span>
            <div className="gen-bar-actions">
              <button type="button" className="big-btn is-generate" onClick={() => void resume()}>
                继续
              </button>
              <button type="button" className="big-btn is-cancel" onClick={() => void cancel()}>
                取消
              </button>
            </div>
          </div>
        )}

        <div className="gen-dialog-body">
          {round === null ? (
            <div className="placeholder">准备中…</div>
          ) : (
            <div className="gen-grid" ref={setGridEl} style={gridStyle}>
              {Array.from({ length: round.count }, (_, index) => {
                const slot = slotFor(index)
                const alt = `第 ${index + 1} 张`
                switch (slot.kind) {
                  case 'ready':
                    return (
                      <img
                        key={index}
                        className={`gen-slot is-ready ${selectedIndex === index ? 'is-selected' : ''}`}
                        style={slotStyle}
                        src={slot.url}
                        alt={alt}
                        onClick={() => setSelectedIndex(index)}
                        // 双击跳过「先选中出预览、再点预览」，直接打开原图查看器（照工具箱）
                        onDoubleClick={() => setViewer({ url: slot.url, alt })}
                      />
                    )
                  case 'failed':
                    return (
                      <div key={index} className="gen-slot is-failed" style={slotStyle} title={slot.error ?? '生成失败'}>
                        失败
                      </div>
                    )
                  case 'missing':
                    return (
                      <div key={index} className="gen-slot is-missing" style={slotStyle} title="文件已丢失">
                        文件已丢失
                      </div>
                    )
                  case 'running':
                    return (
                      <div key={index} className="gen-slot is-running" style={slotStyle}>
                        <span className="gen-running-label">生成中</span>
                      </div>
                    )
                  case 'pending':
                    return <div key={index} className="gen-slot is-pending" style={slotStyle} />
                  default:
                    return <div key={index} className="gen-slot is-empty" style={slotStyle} />
                }
              })}
            </div>
          )}

          {inspected !== null && (
            <GenInspector
              item={inspected}
              mainSpecs={mainSpecs}
              charSpecs={charSpecs}
              update={update}
              onClose={() => setSelectedIndex(null)}
              onOpenViewer={() => setViewer({ url: inspected.url, alt: `第 ${inspected.record.index + 1} 张` })}
              // 复制完回到参数区（界面稿状态 7 的顺序）：弹窗不关的话，参数区的固定 seed 提示被挡住看不见
              onCopied={closeDialog}
            />
          )}
        </div>
      </div>

      {viewer !== null && <ImageViewer url={viewer.url} alt={viewer.alt} onClose={() => setViewer(null)} />}
    </div>
  )
}
