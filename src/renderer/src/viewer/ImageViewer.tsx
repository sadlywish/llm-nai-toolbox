import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from 'react'
import { useEffect, useRef, useState } from 'react'
import { useElementSize } from '../hooks/useElementSize'
import {
  CLICK_MOVE_THRESHOLD,
  clampView,
  computeInitialView,
  isClick,
  panBy,
  zoomAt,
  type Size,
  type ViewState,
} from './panZoom'

interface Props {
  /**
   * 已经存在的图片 URL——跑图中的图是 `file://` 直链，历史图是矩阵那边
   * `readImage` + `createObjectURL` 出来的 object URL。查看器只负责展示，
   * 不读盘也不再 createObjectURL，生命周期仍由原来创建它的那处负责。
   */
  url: string
  alt: string
  onClose: () => void
}

/**
 * 点开看原图（出图格子与溯源侧栏预览图共用同一个入口）：
 * 图能在视口里完整装下就 1:1 居中显示——这个工具存在的意义就是比对画师串
 * 带来的笔触/线条差异，缩放到适应窗口正好把用来判断的东西糊掉，与导出
 * 矩阵图坚持按原图尺寸（spec §11.3）是同一条道理；装不下（典型是 Danbooru
 * 原图，常有几千像素）才缩小到刚好能看全整张，具体规则见 computeInitialView。
 * 叠在出图弹窗之上，关闭只清自己的状态，不动矩阵弹窗的开关。
 */
export default function ImageViewer({ url, alt, onClose }: Props) {
  const { ref: viewportRef, size: viewportSize } = useElementSize<HTMLDivElement>()
  const [imageSize, setImageSize] = useState<Size | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  // 复制结果的一次性反馈；null 表示不显示
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)
  const [view, setView] = useState<ViewState>({ scale: 1, offsetX: 0, offsetY: 0 })
  // 图片刚 onLoad 拿到尺寸的那一刻，view 还是上一张图（或初始占位值）算出来
  // 的——如果这时候就照 imageSize 给图片套上 style 渲染，会在「算出正确
  // 视图」的 effect 跑之前抢先画出错的一帧：大图会被当前（可能是 1:1 的）
  // view 撑得铺满甚至溢出视口。用这个状态显式标记「view 是否已经针对当前
  // imageSize 算好」，没算好之前图片不给 style（跟尺寸未知时一样不显示），
  // 避免闪一下错误的缩放比例
  const [viewReady, setViewReady] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const dragOriginRef = useRef<{ x: number; y: number } | null>(null)
  // pointerdown 时的起点，拖动过程中不更新（与 dragOriginRef 不同，后者
  // 每次 pointermove 都会刷新，用于计算增量平移）；pointerup 时用它跟松开
  // 坐标算总位移，判断这一次是点击还是拖动
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null)
  // pointerup 里判定的「是不是拖动」结果，供随后（鼠标松开后才触发的）
  // click 事件读取——click 不带指针按下时的坐标，没法自己重新判断
  const wasDragRef = useRef(false)
  // 首次拿到图片原始尺寸 + 视口尺寸时做一次 1:1 居中；此后视口尺寸变化
  // （比如用户拖动了窗口）只钳制、不重新居中，否则会打断用户正在看的位置
  const initializedRef = useRef(false)

  // 换了另一张图：旧图的自然尺寸和视图状态对新图没有意义，必须清掉重算，
  // 否则会先拿旧尺寸把新图错误定位一瞬间
  useEffect(() => {
    setImageSize(null)
    setViewReady(false)
    initializedRef.current = false
  }, [url])

  useEffect(() => {
    if (!imageSize || viewportSize.width === 0 || viewportSize.height === 0) return
    if (!initializedRef.current) {
      setView(computeInitialView(imageSize, viewportSize))
      initializedRef.current = true
      setViewReady(true)
    } else {
      setView((v) => clampView(v, imageSize, viewportSize))
    }
  }, [imageSize, viewportSize.width, viewportSize.height])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  function resetView(): void {
    if (!imageSize) return
    setView(computeInitialView(imageSize, viewportSize))
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    if (e.button !== 0 || !imageSize) return
    dragOriginRef.current = { x: e.clientX, y: e.clientY }
    pointerDownRef.current = { x: e.clientX, y: e.clientY }
    setIsDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const origin = dragOriginRef.current
    if (!origin || !imageSize) return
    const dx = e.clientX - origin.x
    const dy = e.clientY - origin.y
    dragOriginRef.current = { x: e.clientX, y: e.clientY }
    setView((v) => panBy(v, dx, dy, imageSize, viewportSize))
  }

  function endDrag(e: ReactPointerEvent<HTMLDivElement>): void {
    const down = pointerDownRef.current
    // 没有起点（比如右键按下那种被 handlePointerDown 提前 return 的情况）
    // 就不算拖动，交给随后的 click 事件按点击处理
    wasDragRef.current = down !== null && !isClick(down, { x: e.clientX, y: e.clientY }, CLICK_MOVE_THRESHOLD)
    dragOriginRef.current = null
    pointerDownRef.current = null
    setIsDragging(false)
  }

  /**
   * 「点击图片外关闭」的判定不能靠事件冒泡到 backdrop——viewport 铺满整个
   * 可视区域，用户点「图片外面」时点的其实还在 viewport 内。改成在这里
   * 直接判断：click 目标就是 viewport 自身（不是图片）、且刚才不是一次
   * 拖动，才关闭；否则要 stopPropagation，防止事件继续冒泡到 backdrop
   * 上那个无条件关闭的 onClick，把「点在图片上」或「拖动结束」也关掉。
   */
  function handleViewportClick(e: ReactMouseEvent<HTMLDivElement>): void {
    const wasDrag = wasDragRef.current
    wasDragRef.current = false
    if (wasDrag || e.target !== e.currentTarget) {
      e.stopPropagation()
      return
    }
    onClose()
  }

  function handleWheel(e: ReactWheelEvent<HTMLDivElement>): void {
    if (!imageSize) return
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    setView((v) =>
      zoomAt({
        view: v,
        imageSize,
        viewportSize,
        cursorX: e.clientX - rect.left,
        cursorY: e.clientY - rect.top,
        deltaY: e.deltaY,
      }),
    )
  }

  /**
   * 复制当前这张图到剪贴板。
   *
   * 走主进程的 `copyImageAt(视口坐标)` 而不是在渲染层取字节：这张图可能是
   * `file://` 直链（跑图中）也可能是 blob: 对象 URL（历史图），两者在渲染层
   * 取字节的路子完全不同，而 copyImageAt 取的是**已经渲染出来的那张图**，
   * 一视同仁。
   *
   * 坐标取「图片矩形与视口的交集」的中心而不是图片矩形本身的中心：放大之后
   * 图会大于视口，矩形中心可能落在视口外，那样 copyImageAt 什么都取不到。
   */
  async function handleCopy(): Promise<void> {
    const el = imgRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const left = Math.max(r.left, 0)
    const right = Math.min(r.right, window.innerWidth)
    const top = Math.max(r.top, 0)
    const bottom = Math.min(r.bottom, window.innerHeight)
    if (right <= left || bottom <= top) {
      setCopied('fail')
      return
    }
    const ok = await window.api.copyImageAt((left + right) / 2, (top + bottom) / 2)
    setCopied(ok ? 'ok' : 'fail')
  }

  return (
    <div className="viewer-backdrop" onClick={onClose}>
      <div className="viewer-hud">
        <span className="viewer-zoom">{Math.round(view.scale * 100)}%</span>
        {copied && (
          <span className={`viewer-copied ${copied === 'ok' ? 'is-ok' : 'is-fail'}`} role="status">
            {copied === 'ok' ? '已复制到剪贴板' : '复制失败'}
          </span>
        )}
        <button
          type="button"
          className="viewer-copy"
          title="复制这张图到剪贴板（也可以在图上点右键）"
          onClick={(e) => {
            // 不冒泡到 .viewer-backdrop 的 onClick，那个会关掉查看器
            e.stopPropagation()
            void handleCopy()
          }}
        >
          复制
        </button>
        <button type="button" className="viewer-close" title="关闭" onClick={onClose}>
          ×
        </button>
      </div>
      <div
        ref={viewportRef}
        className={`viewer-viewport${isDragging ? ' is-dragging' : ''}`}
        onClick={handleViewportClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={handleWheel}
        // 只在图片上双击才重置视图：图片外的单击已经会关闭查看器，
        // 双击的第一下就把窗口关了，挂在整层 viewport 上的这个处理器
        // 在图片外永远走不到——限定目标是把这个事实写进代码，
        // 而不是留一个看着能用、实际不可达的分支
        onDoubleClick={(e) => {
          if (e.target !== e.currentTarget) resetView()
        }}
      >
        <img
          ref={imgRef}
          className="viewer-image"
          src={url}
          alt={alt}
          draggable={false}
          onLoad={(e) =>
            setImageSize({
              width: e.currentTarget.naturalWidth,
              height: e.currentTarget.naturalHeight,
            })
          }
          style={
            imageSize && viewReady
              ? {
                  width: imageSize.width * view.scale,
                  height: imageSize.height * view.scale,
                  transform: `translate(${view.offsetX}px, ${view.offsetY}px)`,
                }
              : undefined
          }
        />
      </div>
    </div>
  )
}
