/**
 * 原图查看器的平移/缩放数学（矩阵里的图要能点开看原图，支持拖动平移 +
 * 滚轮缩放）。这个工具存在的唯一理由是让人肉眼对比不同画师串的笔触细节，
 * 缩放到适应窗口会把用来判断的东西糊掉——所以图片能在视口里完整装下时，
 * 打开查看器仍然是 1:1 像素对像素（跟导出矩阵图按原图尺寸、不缩到长边 512
 * 是同一条原则，spec §11.3）。但 Danbooru 原图常有几千像素，1:1 打开只能
 * 看到一个角、连画的是什么都看不出，这种「装不下」的情况改成缩小到刚好
 * 能看全整张——只在「不然什么都看不到」时才让步，不是放弃 1:1 优先。
 *
 * 抽成纯函数是因为这段计算跟 DOM 事件、指针捕获这些副作用完全无关，
 * 抽出来才能脱离浏览器环境单测；实际的鼠标事件绑定由 ImageViewer 组件负责。
 */
export interface Size {
  width: number
  height: number
}

/**
 * scale=1 即图片原始像素尺寸；offsetX/offsetY 是图片左上角相对视口左上角
 * 的像素偏移，与 CSS transform: translate() 的语义一致，直接拿去用。
 */
export interface ViewState {
  scale: number
  offsetX: number
  offsetY: number
}

export const MIN_SCALE = 0.1
export const MAX_SCALE = 8

/** 滚轮每 1000 个 deltaY 对应缩放因子 e¹——指数映射保证连续滚动时缩放手感均匀 */
const WHEEL_ZOOM_SPEED = 0.001

/** 图片在视口里「装得下」所需的缩放比例：宽、高两个方向各自的适应比例
 * 取更小的那个，否则长边会超出视口。图片尺寸未知（宽或高 <= 0，比如
 * 加载完成前的占位状态）时算不出有意义的适应比例，退化为 1，交给调用方
 * 按 1:1 兜底——这个值本身不会被直接渲染，只是让上层逻辑有个确定的返回值 */
function computeFitScale(imageSize: Size, viewportSize: Size): number {
  if (imageSize.width <= 0 || imageSize.height <= 0) return 1
  return Math.min(viewportSize.width / imageSize.width, viewportSize.height / imageSize.height)
}

/**
 * 打开查看器 / 双击重置时用：图能在视口里完整装下就 1:1（能看清笔触细节，
 * 这个工具的核心诉求），装不下才缩小到刚好能看全整张（否则 Danbooru 那种
 * 几千像素的原图 1:1 打开只能看到一个角，连画的是什么都看不出）。
 * 图与视口居中对齐。
 */
export function computeInitialView(imageSize: Size, viewportSize: Size): ViewState {
  const scale = Math.min(1, computeFitScale(imageSize, viewportSize))
  return {
    scale,
    offsetX: (viewportSize.width - imageSize.width * scale) / 2,
    offsetY: (viewportSize.height - imageSize.height * scale) / 2,
  }
}

/**
 * 单个方向上的边界钳制：图在这个方向上比视口小就不允许平移、强制居中；
 * 比视口大则限制在「左/上边缘对齐视口」与「右/下边缘对齐视口」之间，
 * 不允许拖出视口之外露出空白。
 */
function clampAxis(offset: number, imageExtent: number, viewportExtent: number): number {
  if (imageExtent <= viewportExtent) {
    return (viewportExtent - imageExtent) / 2
  }
  const min = viewportExtent - imageExtent // 负数：右/下边缘贴齐视口时的 offset
  return Math.min(0, Math.max(min, offset))
}

/** 对任意 view 做一次边界钳制；缩放和窗口尺寸变化后都要过一遍这个 */
export function clampView(view: ViewState, imageSize: Size, viewportSize: Size): ViewState {
  return {
    scale: view.scale,
    offsetX: clampAxis(view.offsetX, imageSize.width * view.scale, viewportSize.width),
    offsetY: clampAxis(view.offsetY, imageSize.height * view.scale, viewportSize.height),
  }
}

/** 拖动一次增量后的新状态，钳制在边界内 */
export function panBy(
  view: ViewState,
  dx: number,
  dy: number,
  imageSize: Size,
  viewportSize: Size,
): ViewState {
  return clampView(
    { scale: view.scale, offsetX: view.offsetX + dx, offsetY: view.offsetY + dy },
    imageSize,
    viewportSize,
  )
}

/** 「点击关闭」与「拖动平移」的位移判定阈值（像素）。放大后按住拖动浏览
 * 是常见操作，松手位置经常落在图片外——如果只按「点击目标不是图片」判断
 * 就关闭，会把每一次拖动结束都误判成点击，放大浏览会因此没法用。4px 是
 * 经验值：覆盖鼠标手抖、触控板轻触通常会带上的几像素抖动，同时仍能跟
 * 「确实想拖动」的位移区分开 */
export const CLICK_MOVE_THRESHOLD = 4

export interface PointerPoint {
  x: number
  y: number
}

/** 给定按下、松开坐标与阈值，判断这次指针操作算不算「点击」而不是拖动。
 * 抽成纯函数是为了让阈值判断脱离真实指针事件单测；位移用欧氏距离而不是
 * 单独比较 dx/dy，斜着拖动同样要被正确识别成拖动 */
export function isClick(down: PointerPoint, up: PointerPoint, threshold: number): boolean {
  const dx = up.x - down.x
  const dy = up.y - down.y
  return Math.sqrt(dx * dx + dy * dy) <= threshold
}

export interface WheelZoomInput {
  view: ViewState
  imageSize: Size
  viewportSize: Size
  /** 光标在视口坐标系中的位置（相对视口左上角），缩放要以它为锚点 */
  cursorX: number
  cursorY: number
  /** 原生 WheelEvent.deltaY：负值（滚轮向上）放大，正值（滚轮向下）缩小 */
  deltaY: number
}

/**
 * 以光标位置为锚点缩放：缩放前光标对应的图上坐标，缩放后必须还落在同一个
 * 光标位置下——不然缩放看起来会突然「跳」一下，不像是在放大光标指的地方。
 */
export function zoomAt(input: WheelZoomInput): ViewState {
  const { view, imageSize, viewportSize, cursorX, cursorY, deltaY } = input
  const factor = Math.exp(-deltaY * WHEEL_ZOOM_SPEED)
  // 缩放下限不能死卡在固定的 MIN_SCALE：一张几千像素高的图放进几百像素的
  // 视口，适应比例可能远低于 MIN_SCALE，卡在固定下限会导致缩到底也看不全
  // 整张图，所以取「固定下限」和「适应比例」中更小的那个兜底
  const minScale = Math.min(MIN_SCALE, computeFitScale(imageSize, viewportSize))
  const newScale = Math.min(MAX_SCALE, Math.max(minScale, view.scale * factor))

  const imgX = (cursorX - view.offsetX) / view.scale
  const imgY = (cursorY - view.offsetY) / view.scale

  return clampView(
    {
      scale: newScale,
      offsetX: cursorX - imgX * newScale,
      offsetY: cursorY - imgY * newScale,
    },
    imageSize,
    viewportSize,
  )
}
