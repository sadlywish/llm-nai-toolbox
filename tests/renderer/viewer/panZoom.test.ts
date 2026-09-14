import { describe, expect, it } from 'vitest'
import {
  MAX_SCALE,
  MIN_SCALE,
  clampView,
  computeInitialView,
  isClick,
  panBy,
  zoomAt,
  type ViewState,
} from '@renderer/viewer/panZoom'

// 通用尺寸：832×1216（NAI 常见竖幅），与 cellSize.test.ts 用同一张参考图，
// 方便和真实场景对照
const IMAGE = { width: 832, height: 1216 }

// panBy/zoomAt 两组测试要的是「给定一个 scale=1 的起始 view，钳制/缩放数学
// 对不对」，跟 computeInitialView 具体怎么算初始缩放比例无关。以前图省事
// 直接调 computeInitialView 借一个 scale=1 的起点，但改成「装不下才缩小」
// 之后，用同样的 IMAGE/viewport 组合调 computeInitialView 不再保证拿到
// scale=1（很多组合现在会被缩小），会让这些测试的起点悄悄变掉。这里改成
// 显式构造 scale=1、居中的 ViewState，把两组测试跟 computeInitialView 的
// 语义变化解耦，继续测「钳制/缩放数学」本身
function scale1CenteredView(imageSize: { width: number; height: number }, viewportSize: { width: number; height: number }): ViewState {
  return {
    scale: 1,
    offsetX: (viewportSize.width - imageSize.width) / 2,
    offsetY: (viewportSize.height - imageSize.height) / 2,
  }
}

describe('computeInitialView', () => {
  it('图比视口大（高度受限）：缩小到高度刚好装下，宽度方向留白居中', () => {
    const viewport = { width: 600, height: 800 }
    const fitScale = viewport.height / IMAGE.height // 0.658… < 600/832，高度是更紧的约束
    const view = computeInitialView(IMAGE, viewport)
    expect(view.scale).toBeCloseTo(fitScale, 10)
    expect(view.offsetX).toBeCloseTo((viewport.width - IMAGE.width * fitScale) / 2, 5)
    expect(view.offsetY).toBeCloseTo(0, 5) // 高度方向恰好撑满，无留白
    // 缩放后的显示尺寸不能超出视口
    expect(IMAGE.width * view.scale).toBeLessThanOrEqual(viewport.width + 1e-9)
    expect(IMAGE.height * view.scale).toBeLessThanOrEqual(viewport.height + 1e-9)
  })

  it('图比视口大（宽度受限）：缩小到宽度刚好装下，高度方向留白居中', () => {
    const viewport = { width: 400, height: 1400 }
    const fitScale = viewport.width / IMAGE.width // 0.48… < 1400/1216，宽度是更紧的约束
    const view = computeInitialView(IMAGE, viewport)
    expect(view.scale).toBeCloseTo(fitScale, 10)
    expect(view.offsetX).toBeCloseTo(0, 5) // 宽度方向恰好撑满，无留白
    expect(view.offsetY).toBeCloseTo((viewport.height - IMAGE.height * fitScale) / 2, 5)
    expect(IMAGE.width * view.scale).toBeLessThanOrEqual(viewport.width + 1e-9)
    expect(IMAGE.height * view.scale).toBeLessThanOrEqual(viewport.height + 1e-9)
  })

  it('图比视口小：1:1 居中，不放大凑满视口', () => {
    const view = computeInitialView({ width: 400, height: 300 }, { width: 1000, height: 800 })
    expect(view.scale).toBe(1)
    expect(view.offsetX).toBeCloseTo((1000 - 400) / 2, 5)
    expect(view.offsetY).toBeCloseTo((800 - 300) / 2, 5)
  })

  it('图与视口尺寸完全相等：1:1，offset 为 0', () => {
    const view = computeInitialView({ width: 600, height: 800 }, { width: 600, height: 800 })
    expect(view.scale).toBe(1)
    expect(view.offsetX).toBe(0)
    expect(view.offsetY).toBe(0)
  })

  it('极大图：适应比例远低于 MIN_SCALE(0.1) 时，仍按适应比例来，不被下限卡住', () => {
    const hugeImage = { width: 3000, height: 10000 }
    const viewport = { width: 800, height: 800 }
    const fitScale = viewport.height / hugeImage.height // 0.08，低于 MIN_SCALE
    expect(fitScale).toBeLessThan(MIN_SCALE)
    const view = computeInitialView(hugeImage, viewport)
    expect(view.scale).toBeCloseTo(fitScale, 10)
    expect(view.scale).toBeLessThan(MIN_SCALE)
  })

  it('图片尺寸未知（宽高为 0）：退化为 1:1，不崩溃、不产生 NaN/Infinity', () => {
    const view = computeInitialView({ width: 0, height: 0 }, { width: 600, height: 800 })
    expect(view.scale).toBe(1)
    expect(view.offsetX).toBe(300) // (600 - 0*1) / 2
    expect(view.offsetY).toBe(400) // (800 - 0*1) / 2
    expect(Number.isFinite(view.scale)).toBe(true)
  })
})

describe('panBy · 边界钳制', () => {
  const viewport = { width: 600, height: 800 }

  it('两个方向都比视口大时，拖动增量正常生效', () => {
    const start = scale1CenteredView(IMAGE, viewport) // offsetX=-116, offsetY=-208
    const next = panBy(start, -50, -30, IMAGE, viewport)
    expect(next.offsetX).toBeCloseTo(-166, 5)
    expect(next.offsetY).toBeCloseTo(-238, 5)
  })

  it('拖过头（图左/上边缘想超过视口左/上边缘）时钳制在 0', () => {
    const start = scale1CenteredView(IMAGE, viewport)
    const next = panBy(start, 200, 300, IMAGE, viewport)
    expect(next.offsetX).toBe(0)
    expect(next.offsetY).toBe(0)
  })

  it('拖过头（图右/下边缘想露出视口右/下边缘）时钳制在 viewport-image', () => {
    const start = scale1CenteredView(IMAGE, viewport)
    const next = panBy(start, -200, -300, IMAGE, viewport)
    expect(next.offsetX).toBe(600 - 832)
    expect(next.offsetY).toBe(800 - 1216)
  })

  it('某方向比视口小时，不允许在该方向平移——无论增量多大都保持居中', () => {
    // 宽 400 < 视口宽 600：横向不能拖；高 1216 > 视口高 800：纵向仍能拖
    const narrowImage = { width: 400, height: 1216 }
    const start = scale1CenteredView(narrowImage, viewport)
    const next = panBy(start, 5000, -50, narrowImage, viewport)
    expect(next.offsetX).toBeCloseTo((600 - 400) / 2, 5) // 强制居中，5000 的横向增量被忽略
    expect(next.offsetY).toBeCloseTo(start.offsetY - 50, 5) // 纵向正常响应
  })
})

describe('zoomAt · 以光标为锚点缩放', () => {
  const viewport = { width: 400, height: 500 }

  it('缩放前后，光标下的那个图上像素坐标保持不变', () => {
    const start = scale1CenteredView(IMAGE, viewport)
    const cursorX = 150
    const cursorY = 200
    const imgXBefore = (cursorX - start.offsetX) / start.scale
    const imgYBefore = (cursorY - start.offsetY) / start.scale

    const next = zoomAt({ view: start, imageSize: IMAGE, viewportSize: viewport, cursorX, cursorY, deltaY: -100 })

    expect(next.scale).toBeGreaterThan(start.scale) // deltaY 为负 = 放大
    const imgXAfter = (cursorX - next.offsetX) / next.scale
    const imgYAfter = (cursorY - next.offsetY) / next.scale
    expect(imgXAfter).toBeCloseTo(imgXBefore, 5)
    expect(imgYAfter).toBeCloseTo(imgYBefore, 5)
  })

  it('放大不能超过 8×', () => {
    const start = scale1CenteredView(IMAGE, viewport)
    const next = zoomAt({
      view: start,
      imageSize: IMAGE,
      viewportSize: viewport,
      cursorX: 200,
      cursorY: 250,
      deltaY: -1_000_000,
    })
    expect(next.scale).toBe(MAX_SCALE)
  })

  it('缩小不能低于 0.1×', () => {
    const start = scale1CenteredView(IMAGE, viewport)
    const next = zoomAt({
      view: start,
      imageSize: IMAGE,
      viewportSize: viewport,
      cursorX: 200,
      cursorY: 250,
      deltaY: 1_000_000,
    })
    expect(next.scale).toBe(MIN_SCALE)
  })

  it('极大图：缩小下限跟随适应比例，允许缩到比固定下限 MIN_SCALE 更低——否则永远看不全整张', () => {
    const hugeImage = { width: 3000, height: 10000 }
    const hugeViewport = { width: 800, height: 800 }
    const fitScale = hugeViewport.height / hugeImage.height // 0.08，低于 MIN_SCALE(0.1)
    expect(fitScale).toBeLessThan(MIN_SCALE)
    const start: ViewState = { scale: fitScale, offsetX: 0, offsetY: 0 }
    const next = zoomAt({
      view: start,
      imageSize: hugeImage,
      viewportSize: hugeViewport,
      cursorX: 400,
      cursorY: 400,
      deltaY: 1_000_000, // 继续往小了滚，验证不会被拉回固定下限 0.1
    })
    expect(next.scale).toBeCloseTo(fitScale, 10)
    expect(next.scale).toBeLessThan(MIN_SCALE)
  })

  it('缩小到图比视口还小之后，自动回到居中（复用 clampView 的钳制）', () => {
    const start = scale1CenteredView(IMAGE, viewport)
    const bigViewport = { width: 1000, height: 800 }
    const next = zoomAt({
      view: start,
      imageSize: IMAGE,
      viewportSize: bigViewport,
      cursorX: 10,
      cursorY: 10,
      deltaY: 1_000_000, // 钳制到 0.1×，832×1216 → 83.2×121.6，比 bigViewport 小得多
    })
    expect(next.scale).toBe(MIN_SCALE)
    expect(next.offsetX).toBeCloseTo((1000 - 832 * MIN_SCALE) / 2, 5)
    expect(next.offsetY).toBeCloseTo((800 - 1216 * MIN_SCALE) / 2, 5)
  })
})

describe('clampView', () => {
  it('直接对一个越界的 view 钳制，两个方向分别处理', () => {
    const viewport = { width: 600, height: 800 }
    const clamped = clampView({ scale: 1, offsetX: 500, offsetY: -9000 }, IMAGE, viewport)
    expect(clamped.offsetX).toBe(0)
    expect(clamped.offsetY).toBe(800 - 1216)
  })
})

// 点击关闭 vs 拖动平移的判定（新需求）：放大后拖动浏览时松手位置常常落在
// 图片外面，若照字面「点击目标不是图片就关闭」实现，会把拖动误判成点击、
// 意外关掉查看器。改成比较按下到松开的位移，超过阈值就是拖动，不算点击。
describe('isClick · 点击与拖动的判定', () => {
  it('按下松开在同一点：判定为点击', () => {
    expect(isClick({ x: 10, y: 10 }, { x: 10, y: 10 }, 4)).toBe(true)
  })

  it('位移 3px（小于阈值 4px）：仍判定为点击', () => {
    expect(isClick({ x: 0, y: 0 }, { x: 3, y: 0 }, 4)).toBe(true)
  })

  it('位移 10px（远超阈值）：判定为拖动', () => {
    expect(isClick({ x: 0, y: 0 }, { x: 10, y: 0 }, 4)).toBe(false)
  })

  it('只在横向移动、且超过阈值：判定为拖动', () => {
    expect(isClick({ x: 0, y: 0 }, { x: 6, y: 0 }, 4)).toBe(false)
  })

  it('只在纵向移动、且超过阈值：判定为拖动', () => {
    expect(isClick({ x: 0, y: 0 }, { x: 0, y: 6 }, 4)).toBe(false)
  })

  it('只在纵向移动，但未超过阈值：判定为点击', () => {
    expect(isClick({ x: 0, y: 0 }, { x: 0, y: 2 }, 4)).toBe(true)
  })

  it('位移恰好等于阈值：判定为点击（边界用 <=，不是 <）', () => {
    expect(isClick({ x: 0, y: 0 }, { x: 4, y: 0 }, 4)).toBe(true)
  })
})
