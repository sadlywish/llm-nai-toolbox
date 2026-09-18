// 点开一张图：全屏看图（界面稿 2026-09-17 第四节方案 Y）。
//
// 黑底铺满、图完整显示；「第几张 · seed」「本工具参数」、关闭浮在顶部，三个动作浮在底部。
// 双指缩放、放大后拖动；**双击关闭**（放大着也关），单击不做事——缩放时手指难免点到，单击关太容易误关。
// 「本工具参数」是盖在全屏上的一整页，内容见 ToolParams。
//
// 显示的参数一律取那一轮落盘的快照，不取手机现在这份工作区——出图之后接着改参数是常事，
// 拿当前值去说「这张图是这么出来的」就是撒谎。seed 用点开的这一张的（同一轮里各张不同）。
//
// 缩放的算术全在 pinchZoom.ts 里，这里只做三件事：把手指位置翻成点、量元素、把结果写进 style。
import { useEffect, useRef, useState } from 'react'
import type { GenSnapshot, RoundRecord } from '@shared/gen'
import { readSnapshotLlm } from '@shared/llmProvenance'
import type { MobileMeta } from '@shared/mobileApi'
import type { ApiClient } from '../api'
import { copyText } from '../clipboard'
import {
  clampOffset,
  distance,
  fitContain,
  IDENTITY,
  isDoubleTap,
  midpoint,
  panBy,
  TAP_MAX_MS,
  TAP_SLOP,
  transformOf,
  zoomAt,
  type Point,
  type Size,
  type Tap,
  type View,
} from '../pinchZoom'
import { shareImage, shareMessage } from '../share'
import { useBackHandler } from '../useBackHandler'
import ToolParams from './ToolParams'

interface Props {
  /** 这一轮的第几张，从 0 数 */
  index: number
  file: string
  seed: number
  /** 那一轮的记录：大图地址要它的 startedAt，参数与提示词取它的快照 */
  round: RoundRecord
  meta: MobileMeta | null
  client: ApiClient
  onClose: () => void
  /** 「参数写回手机」：整套覆盖手机本地那份工作区，seed 用这张的并改成固定 */
  onApply: (snapshot: GenSnapshot, seed: number) => void
}

/** 只要 clientX/clientY：React 的 Touch 与 DOM 的 Touch 是两个类型，按结构收就都能喂 */
function pointOf(touch: { clientX: number; clientY: number }): Point {
  return { x: touch.clientX, y: touch.clientY }
}

export default function ImageViewer({ index, file, seed, round, meta, client, onClose, onApply }: Props): JSX.Element {
  const [applied, setApplied] = useState(false)
  /** 复制不了时把内容摊开让人自己长按选（明文 HTTP 页面里 Clipboard API 常常不可用） */
  const [fallback, setFallback] = useState<string | null>(null)
  const [sharing, setSharing] = useState(false)
  /** 分享给不出面板时那一句（成功与用户自己取消都是 null，不打扰） */
  const [shareHint, setShareHint] = useState<string | null>(null)
  const [showParams, setShowParams] = useState(false)
  // 返回键：参数页开着先关参数页（它后打开，先处理），再按一次关大图
  useBackHandler(true, onClose)
  useBackHandler(showParams, () => setShowParams(false))

  const [view, setView] = useState<View>(IDENTITY)
  const stageRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  /**
   * 手势中途要读「最新的画面」，而 setState 是异步的，读 state 会拿到上一帧的值，
   * 捏合时表现为一顿一顿地回弹。所以真值放 ref，state 只用来触发重绘。
   * （也不能用函数式 setState 就地算：StrictMode 下更新函数会跑两遍，缩放会被叠加两次。）
   */
  const viewRef = useRef<View>(IDENTITY)
  /** 双指：上一帧的指距与中点 */
  const pinchRef = useRef<{ dist: number; mid: Point } | null>(null)
  /** 单指：上一帧的位置 */
  const panRef = useRef<Point | null>(null)
  /** 这一次按下有没有资格算「点一下」（没挪、没按太久） */
  const tapRef = useRef<{ time: number; x: number; y: number; moved: boolean } | null>(null)
  const lastTapRef = useRef<Tap | null>(null)

  const fullUrl = client.imageUrl(round.startedAt, file, 'full')

  // 换了一张图就回到 1x、回到图上：新图接着用上一张的位移会歪在一边
  useEffect(() => {
    viewRef.current = IDENTITY
    setView(IDENTITY)
    setShareHint(null)
    setShowParams(false)
  }, [file])

  const applyView = (next: View): void => {
    viewRef.current = next
    setView(next)
  }

  /** 量出手势要用的三件事；元素还没挂上就返回 null（这一帧什么都不做） */
  const measure = (): { center: Point; content: Size; viewport: Size } | null => {
    const stage = stageRef.current
    const img = imgRef.current
    if (stage === null || img === null) return null
    const rect = img.getBoundingClientRect()
    const current = viewRef.current
    // rect 是变换之后的框；transform-origin 在中心，所以减掉当前位移就是未变换时的中心
    const center = { x: rect.left + rect.width / 2 - current.x, y: rect.top + rect.height / 2 - current.y }
    // offsetWidth/Height 不受 transform 影响，拿到的是 1x 时的元素框（铺满整屏，图靠 object-fit 装在里面）
    const box = { width: img.offsetWidth, height: img.offsetHeight }
    return {
      center,
      content: fitContain({ width: img.naturalWidth, height: img.naturalHeight }, box),
      viewport: { width: stage.clientWidth, height: stage.clientHeight },
    }
  }

  const onTouchStart = (e: React.TouchEvent<HTMLDivElement>): void => {
    if (e.touches.length >= 2) {
      const a = pointOf(e.touches[0])
      const b = pointOf(e.touches[1])
      // 指距最小按 1 算：两指重合时拿它做除数会算出 Infinity
      pinchRef.current = { dist: Math.max(1, distance(a, b)), mid: midpoint(a, b) }
      panRef.current = null
      tapRef.current = null
      return
    }
    const p = pointOf(e.touches[0])
    pinchRef.current = null
    panRef.current = p
    tapRef.current = { time: Date.now(), x: p.x, y: p.y, moved: false }
  }

  const onTouchMove = (e: React.TouchEvent<HTMLDivElement>): void => {
    const m = measure()
    if (m === null) return

    const pinch = pinchRef.current
    if (e.touches.length >= 2 && pinch !== null) {
      const a = pointOf(e.touches[0])
      const b = pointOf(e.touches[1])
      const dist = Math.max(1, distance(a, b))
      const mid = midpoint(a, b)
      const current = viewRef.current
      const focus = { x: mid.x - m.center.x, y: mid.y - m.center.y }
      // 先按指距变化缩放（两指中点底下的内容不动），再跟上两指整体的挪动
      const zoomed = zoomAt(current, current.scale * (dist / pinch.dist), focus)
      const moved = panBy(zoomed, mid.x - pinch.mid.x, mid.y - pinch.mid.y)
      pinchRef.current = { dist, mid }
      applyView(clampOffset(moved, m.content, m.viewport))
      return
    }

    const last = panRef.current
    if (e.touches.length === 1 && last !== null) {
      const p = pointOf(e.touches[0])
      panRef.current = p
      const tap = tapRef.current
      if (tap !== null && distance(tap, p) > TAP_SLOP) tap.moved = true
      // 1x 时 clampOffset 的边界是 0，拖不动——「放大后才允许拖」就落在这一句上，不另设开关
      applyView(clampOffset(panBy(viewRef.current, p.x - last.x, p.y - last.y), m.content, m.viewport))
    }
  }

  const onTouchEnd = (e: React.TouchEvent<HTMLDivElement>): void => {
    if (e.touches.length === 1) {
      // 捏合松了一根手指：剩下那根接着当拖动，不然它和上一帧中点的差会被当成一次跳变
      pinchRef.current = null
      panRef.current = pointOf(e.touches[0])
      return
    }
    if (e.touches.length > 1) return

    const tap = tapRef.current
    pinchRef.current = null
    panRef.current = null
    tapRef.current = null
    if (tap === null || tap.moved) return

    const now = Date.now()
    if (now - tap.time > TAP_MAX_MS) return
    const next: Tap = { time: now, x: tap.x, y: tap.y }
    if (!isDoubleTap(lastTapRef.current, next)) {
      lastTapRef.current = next
      return
    }
    lastTapRef.current = null
    onClose()
  }

  /** 产出这一轮提示词的那条 LLM 指令原文；没经过 LLM（或旧记录没存）就是空，按钮禁用 */
  const instruction = readSnapshotLlm(round.snapshot.llm)?.request.instruction.trim() ?? ''

  const copy = (): void => {
    if (instruction === '') return
    void copyText(instruction).then((ok) => {
      setFallback(ok ? null : instruction)
    })
  }

  const apply = (): void => {
    onApply(round.snapshot, seed)
    setApplied(true)
    // 只是一句回执，两秒后自己退回去（同 EditSheet 的「已复制」）
    setTimeout(() => setApplied(false), 2000)
  }

  const share = (): void => {
    if (sharing) return
    setSharing(true)
    setShareHint(null)
    // shareImage 自己接住了所有异常，只用看 status
    void shareImage(fullUrl, file).then((result) => {
      setSharing(false)
      setShareHint(shareMessage(result))
    })
  }

  // 三个动作与它们的回执：全屏底部与参数页底栏各放一份，同一套状态
  const actions = (
    <>
      {shareHint !== null && <p className="hint">{shareHint}</p>}
      {fallback !== null && (
        <>
          <p className="hint">这个页面是明文 HTTP 发出来的，浏览器不给复制。长按下面这段自己选。</p>
          {/* readOnly 的 textarea 而不是 <p>：手机上长按输入框会直接给出「全选」，比选段落准得多 */}
          <textarea className="viewer-fallback" value={fallback} readOnly spellCheck={false} />
        </>
      )}
      <div className="viewer-actions">
        <button type="button" className="btn sm" onClick={apply}>
          {applied ? '已写回手机' : '参数写回手机'}
        </button>
        <button type="button" className="btn sm" onClick={copy} disabled={instruction === ''}>
          复制 LLM 输入
        </button>
        <button type="button" className="btn sm" onClick={share} disabled={sharing}>
          {sharing ? '分享中…' : '分享'}
        </button>
      </div>
    </>
  )

  const title = `第 ${index + 1} 张 · seed ${seed}`

  return (
    <div className="viewer">
      {/* 整屏都是取景框；touch-action: none 在 CSS 里，手势全归自己管：不这么写浏览器会先把双指当成整页缩放 */}
      <div
        className="viewer-stage"
        ref={stageRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        <img
          ref={imgRef}
          className="viewer-img"
          style={{ transform: transformOf(view) }}
          src={fullUrl}
          alt={`第 ${index + 1} 张`}
          draggable={false}
        />
      </div>

      <div className="viewer-top">
        <span className="viewer-title">{title}</span>
        <button type="button" className="btn sm" onClick={() => setShowParams(true)}>
          本工具参数
        </button>
        <button type="button" className="viewer-close" aria-label="关闭" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="viewer-bottom">{actions}</div>

      {showParams && (
        <div className="viewer-page">
          <div className="viewer-head">
            <button type="button" className="btn sm" onClick={() => setShowParams(false)}>
              返回
            </button>
            <span className="viewer-page-title">本工具参数</span>
            <span className="viewer-title">{title}</span>
          </div>
          <div className="viewer-page-body">
            <ToolParams round={round} seed={seed} meta={meta} />
          </div>
          <div className="viewer-foot">{actions}</div>
        </div>
      )}
    </div>
  )
}
