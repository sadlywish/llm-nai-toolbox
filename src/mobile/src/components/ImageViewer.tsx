// 点开一张图：大图（能捏合放大） + 这张的参数 + 三个动作（界面稿第三节右边那张）。
//
// 显示的参数一律取那一轮落盘的快照，不取手机现在这份工作区——出图之后接着改参数是常事，
// 拿当前值去说「这张图是这么出来的」就是撒谎。seed 用点开的这一张的（同一轮里各张不同）。
//
// 缩放的算术全在 pinchZoom.ts 里，这里只做三件事：把手指位置翻成点、量元素、把结果写进 style。
import { useEffect, useRef, useState } from 'react'
import { MAIN_FIELDS } from '@shared/fields'
import type { GenSnapshot, RoundRecord } from '@shared/gen'
import type { MobileMeta } from '@shared/mobileApi'
import { buildPositivePrompt } from '@shared/prompt'
import type { ApiClient } from '../api'
import { copyText } from '../clipboard'
import {
  clampOffset,
  distance,
  doubleTapScale,
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

/** 参数那一行（界面稿：`832×1216 · 28 步 · CFG 5 · k_euler_ancestral`） */
function paramsLine(snapshot: GenSnapshot): string {
  const p = snapshot.params
  return `${p.width}×${p.height} · ${p.steps} 步 · CFG ${p.scale} · ${p.sampler}`
}

/** 只要 clientX/clientY：React 的 Touch 与 DOM 的 Touch 是两个类型，按结构收就都能喂 */
function pointOf(touch: { clientX: number; clientY: number }): Point {
  return { x: touch.clientX, y: touch.clientY }
}

export default function ImageViewer({ index, file, seed, round, meta, client, onClose, onApply }: Props): JSX.Element {
  const [applied, setApplied] = useState(false)
  /** 复制不了时把提示词摊开让人自己长按选（明文 HTTP 页面里 Clipboard API 常常不可用） */
  const [fallback, setFallback] = useState<string | null>(null)
  const [sharing, setSharing] = useState(false)
  /** 分享给不出面板时那一句（成功与用户自己取消都是 null，不打扰） */
  const [shareHint, setShareHint] = useState<string | null>(null)

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

  // 字段顺序照电脑上的 promptOrder（meta 给的已经排好），拿不到 meta 才退回默认顺序
  const specs = meta?.mainFields ?? MAIN_FIELDS
  const positive = buildPositivePrompt(round.snapshot.main, round.snapshot.text, specs)
  const fullUrl = client.imageUrl(round.startedAt, file, 'full')

  // 换了一张图（历史详情里点下一张）就回到 1x：新图接着用上一张的位移会歪在一边
  useEffect(() => {
    viewRef.current = IDENTITY
    setView(IDENTITY)
    setShareHint(null)
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
    // offsetWidth/Height 不受 transform 影响，拿到的是 1x 时的元素框
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
    const m = measure()
    if (m === null) return
    const focus = { x: next.x - m.center.x, y: next.y - m.center.y }
    const current = viewRef.current
    applyView(clampOffset(zoomAt(current, doubleTapScale(current.scale), focus), m.content, m.viewport))
  }

  const copy = (): void => {
    void copyText(positive).then((ok) => {
      setFallback(ok ? null : positive)
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

  return (
    // 盖住整页而不是从底部弹一半：看图要的是尽量大的画面，半截弹层只剩一条缝
    <div className="viewer">
      <div className="viewer-head">
        <span className="viewer-title">
          第 {index + 1} 张 · seed {seed}
        </span>
        <span className="grow" />
        <button type="button" className="btn sm" onClick={onClose}>
          关闭
        </button>
      </div>
      <div className="viewer-body">
        {/* touch-action: none 在 CSS 里，手势全归自己管：不这么写浏览器会先把双指当成整页缩放 */}
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
        <p className="sec">
          {paramsLine(round.snapshot)}
          {view.scale > 1 && ` · ${Math.round(view.scale * 10) / 10}x（双击复位）`}
        </p>
        <div className="viewer-actions">
          <button type="button" className="btn sm" onClick={apply}>
            {applied ? '已写回手机' : '参数写回手机'}
          </button>
          <button type="button" className="btn sm" onClick={copy}>
            复制正面提示词
          </button>
          <button type="button" className="btn sm" onClick={share} disabled={sharing}>
            {sharing ? '分享中…' : '分享'}
          </button>
        </div>
        {shareHint !== null && <p className="hint">{shareHint}</p>}
        {fallback !== null && (
          <>
            <p className="hint">这个页面是明文 HTTP 发出来的，浏览器不给复制。长按下面这段自己选。</p>
            {/* readOnly 的 textarea 而不是 <p>：手机上长按输入框会直接给出「全选」，比选段落准得多 */}
            <textarea className="viewer-fallback" value={fallback} readOnly spellCheck={false} />
          </>
        )}
      </div>
    </div>
  )
}
