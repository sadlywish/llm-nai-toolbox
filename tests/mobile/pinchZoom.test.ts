import { describe, expect, it } from 'vitest'
import {
  clampOffset,
  clampScale,
  distance,
  DOUBLE_TAP_SCALE,
  doubleTapScale,
  fitContain,
  IDENTITY,
  isDoubleTap,
  MAX_SCALE,
  midpoint,
  panBy,
  transformOf,
  zoomAt,
  type Point,
  type View,
} from '../../src/mobile/src/pinchZoom'

/** 组件里那条变换 `translate(t) scale(s)` 的含义：内容点 p 落在 s·p + t */
function project(view: View, p: Point): Point {
  return { x: view.scale * p.x + view.x, y: view.scale * p.y + view.y }
}

/** 屏幕上的一点对应的内容点 */
function unproject(view: View, screen: Point): Point {
  return { x: (screen.x - view.x) / view.scale, y: (screen.y - view.y) / view.scale }
}

describe('distance / midpoint', () => {
  it('两指的距离与中点', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
    expect(midpoint({ x: 0, y: 10 }, { x: 4, y: -2 })).toEqual({ x: 2, y: 4 })
  })
})

describe('clampScale', () => {
  it('收在 1x–6x，脏值退回 1x', () => {
    expect(clampScale(0.3)).toBe(1)
    expect(clampScale(3)).toBe(3)
    expect(clampScale(99)).toBe(MAX_SCALE)
    expect(clampScale(Number.NaN)).toBe(1)
  })
})

describe('zoomAt', () => {
  it('捏合放大后两指中点底下的内容不跑偏', () => {
    const before: View = { scale: 1.4, x: -20, y: 35 }
    const focus = { x: 60, y: -90 } // 相对元素中心的两指中点
    const held = unproject(before, focus)

    const after = zoomAt(before, 3.2, focus)

    expect(after.scale).toBe(3.2)
    // 同一个内容点缩放后仍落在手指中点上（不做补偿的话图会朝中心跑）
    expect(project(after, held).x).toBeCloseTo(focus.x, 6)
    expect(project(after, held).y).toBeCloseTo(focus.y, 6)
    expect(after.x).not.toBeCloseTo(before.x, 3)
  })

  it('倍数超上限时位移按收敛后的倍数算', () => {
    // 按 6x 补偿是 10 - 6×10 = -50；要是拿 99 去算就成了 -980，图会瞬间飞出视野
    expect(zoomAt(IDENTITY, 99, { x: 10, y: 0 })).toEqual({ scale: MAX_SCALE, x: -50, y: 0 })
  })
})

describe('clampOffset', () => {
  const content = { width: 300, height: 400 }
  const viewport = { width: 300, height: 400 }

  it('放大后最多拖到边贴边', () => {
    // 2x 时画出来 600×800，左右各多出 150、上下各多出 200
    const v: View = { scale: 2, x: 0, y: 0 }
    expect(clampOffset(panBy(v, 500, -900), content, viewport)).toEqual({ scale: 2, x: 150, y: -200 })
    expect(clampOffset(panBy(v, 40, -30), content, viewport)).toEqual({ scale: 2, x: 40, y: -30 })
  })

  it('1x 时根本拖不动：图没视野大，只有居中一个合法位置', () => {
    expect(clampOffset(panBy(IDENTITY, 80, -80), content, viewport)).toEqual({ scale: 1, x: 0, y: 0 })
  })

  it('缩回 1x 时位移自动归零', () => {
    expect(clampOffset({ scale: 1, x: 120, y: -80 }, content, viewport)).toEqual({ scale: 1, x: 0, y: 0 })
  })

  it('边界按图画出来的尺寸算，不算 object-fit 留的黑边', () => {
    // 832×1216 的竖图塞进 366×523 的框：两边各留一点黑边，画出来只有 357.87 宽
    const painted = fitContain({ width: 832, height: 1216 }, { width: 366, height: 523 })
    const clamped = clampOffset({ scale: 2, x: 999, y: 0 }, painted, { width: 366, height: 523 })
    expect(clamped.x).toBeCloseTo((357.86 * 2 - 366) / 2, 1)
    // 按元素框（366）算会多给 8px，那 8px 拖出来就是一条黑边
    expect(clamped.x).toBeLessThan((366 * 2 - 366) / 2)
  })
})

describe('doubleTapScale', () => {
  it('双击在 1x 与 2.5x 之间来回', () => {
    expect(doubleTapScale(1)).toBe(DOUBLE_TAP_SCALE)
    expect(doubleTapScale(DOUBLE_TAP_SCALE)).toBe(1)
    expect(doubleTapScale(6)).toBe(1)
    // 捏到一点点就停手，双击的意思仍是「放大」
    expect(doubleTapScale(1.02)).toBe(DOUBLE_TAP_SCALE)
  })

  it('放大再双击能完全回到原样', () => {
    const content = { width: 360, height: 520 }
    const viewport = { width: 360, height: 520 }
    const focus = { x: 100, y: 60 }

    const zoomed = clampOffset(zoomAt(IDENTITY, doubleTapScale(IDENTITY.scale), focus), content, viewport)
    expect(zoomed.scale).toBe(DOUBLE_TAP_SCALE)
    expect(zoomed.x).not.toBe(0)

    const back = clampOffset(zoomAt(zoomed, doubleTapScale(zoomed.scale), focus), content, viewport)
    expect(back).toEqual({ scale: 1, x: 0, y: 0 })
  })
})

describe('isDoubleTap', () => {
  it('第一下没得比', () => {
    expect(isDoubleTap(null, { time: 1000, x: 10, y: 10 })).toBe(false)
  })

  it('够快够近才算', () => {
    const first = { time: 1000, x: 100, y: 100 }
    expect(isDoubleTap(first, { time: 1200, x: 108, y: 104 })).toBe(true)
    expect(isDoubleTap(first, { time: 1600, x: 100, y: 100 })).toBe(false) // 太慢
    expect(isDoubleTap(first, { time: 1100, x: 160, y: 100 })).toBe(false) // 太远
  })
})

describe('fitContain', () => {
  it('竖图塞进扁框：高度撑满，宽度按比例缩', () => {
    const painted = fitContain({ width: 832, height: 1216 }, { width: 366, height: 523 })
    expect(painted.height).toBeCloseTo(523, 6)
    expect(painted.width).toBeCloseTo((523 * 832) / 1216, 6)
  })

  it('图还没加载（natural 是 0）就先按框算，不能算出 0 尺寸卡死拖动', () => {
    expect(fitContain({ width: 0, height: 0 }, { width: 366, height: 523 })).toEqual({ width: 366, height: 523 })
  })
})

describe('transformOf', () => {
  it('先位移后缩放，顺序不能反（pinchZoom 的算术全按这个顺序推的）', () => {
    expect(transformOf({ scale: 2, x: 5, y: 6 })).toBe('translate(5px, 6px) scale(2)')
  })

  it('长小数截短，免得每帧写一串 17 位的数进 style', () => {
    expect(transformOf({ scale: 1, x: 1 / 3, y: 0 })).toBe('translate(0.33px, 0px) scale(1)')
  })
})
