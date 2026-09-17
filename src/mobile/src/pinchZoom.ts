/**
 * 大图的捏合缩放/拖动：所有纯计算都在这里，React 组件只负责接手势、量元素、渲染。
 *
 * 变换固定写成 `translate(x, y) scale(s)`，且 transform-origin 在元素中心。CSS 的变换列表是
 * 从左往右乘的，所以一个内容点 p（相对元素中心、未缩放时的 px）落在屏幕上的位置是 `s·p + t`。
 * 下面每个函数都按这个式子推的——组件那边要是把 translate 挪到 scale 后面，这些数就全是错的。
 */

/** 1x 就是「整张图正好摆满」，再缩下去只会在四周留黑边，没意义 */
export const MIN_SCALE = 1
export const MAX_SCALE = 6
/** 两次点按之间最多这么久、这么远才算双击（大图里双击是关闭） */
export const DOUBLE_TAP_MS = 300
export const DOUBLE_TAP_SLOP = 30
/** 一次点按里手指挪过这么多 px 就不再算「点」，只算拖 */
export const TAP_SLOP = 10
/** 按下超过这么久也不算「点」（长按是浏览器自己的保存菜单，别抢） */
export const TAP_MAX_MS = 400

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

/** 当前画面：缩放倍数 + 相对居中位置的位移（px） */
export interface View {
  scale: number
  x: number
  y: number
}

export const IDENTITY: View = { scale: MIN_SCALE, x: 0, y: 0 }

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return MIN_SCALE
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/**
 * 缩放到 `nextScale`，并让 `focus` 这个屏幕点底下的内容不动。
 *
 * @param focus 相对元素中心的偏移（px），也就是两指中点/双击点减掉元素中心。
 *   不做这一步的话，捏合时图会朝着中心跑——手指按住的地方和画面对不上，实机上立刻就能看出来。
 */
export function zoomAt(view: View, nextScale: number, focus: Point): View {
  const from = clampScale(view.scale)
  const scale = clampScale(nextScale)
  // 由 `s·p + t = focus` 解出缩放前后同一个 p 对应的新位移
  const ratio = scale / from
  return {
    scale,
    x: focus.x - ratio * (focus.x - view.x),
    y: focus.y - ratio * (focus.y - view.y),
  }
}

/** 单纯挪位移，边界由 clampOffset 收（拖出去多少在这里不管） */
export function panBy(view: View, dx: number, dy: number): View {
  return { scale: view.scale, x: view.x + dx, y: view.y + dy }
}

/**
 * 一根轴上的收敛：放大后的图比视野大多少，就最多能拖多少（拖到边贴边为止）。
 * 图没视野大时只有居中一个合法位置——1x 时正好是这种情况，位移自动归零，不用另写一条「复位」。
 */
function clampAxis(offset: number, painted: number, viewport: number): number {
  const limit = Math.max(0, (painted - viewport) / 2)
  if (!Number.isFinite(offset)) return 0
  const clamped = Math.min(limit, Math.max(-limit, offset))
  // 往负方向收到 0 时 Math.max 给的是 -0：算术上无所谓，但「归零了没有」的比较会被它坑
  return clamped === 0 ? 0 : clamped
}

/**
 * 把位移收进边界，不让图被拖出视野。
 *
 * @param content 1x 时图**实际画出来**的尺寸（不含 object-fit 留下的黑边），见 fitContain
 * @param viewport 容器尺寸
 */
export function clampOffset(view: View, content: Size, viewport: Size): View {
  return {
    scale: view.scale,
    x: clampAxis(view.x, content.width * view.scale, viewport.width),
    y: clampAxis(view.y, content.height * view.scale, viewport.height),
  }
}

export interface Tap {
  /** Date.now() */
  time: number
  x: number
  y: number
}

export function isDoubleTap(prev: Tap | null, next: Tap): boolean {
  if (prev === null) return false
  return next.time - prev.time <= DOUBLE_TAP_MS && distance(prev, next) <= DOUBLE_TAP_SLOP
}

/**
 * `object-fit: contain` 之后图真正占的尺寸。
 *
 * 边界要按这个算而不是按元素框：竖图塞进扁盒子时两边是黑边，按元素框算的话能把图拖到
 * 只剩黑边在视野里。图还没加载完（naturalWidth 是 0）就先按盒子来——宽一点无所谓，
 * 算出 0 尺寸会让边界死锁成「不许拖」。
 */
export function fitContain(natural: Size, box: Size): Size {
  if (!(natural.width > 0) || !(natural.height > 0) || !(box.width > 0) || !(box.height > 0)) return box
  const k = Math.min(box.width / natural.width, box.height / natural.height)
  return { width: natural.width * k, height: natural.height * k }
}

function round(n: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

/** 写进 style.transform 的那串（顺序见文件头的注释，别改） */
export function transformOf(view: View): string {
  return `translate(${round(view.x, 2)}px, ${round(view.y, 2)}px) scale(${round(view.scale, 3)})`
}
