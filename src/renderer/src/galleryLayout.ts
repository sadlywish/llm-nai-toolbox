/** 出图弹窗格子间距，与 .gen-grid 的 gap 一致 */
export const GALLERY_GAP = 8
/** 每张的最小宽度：再小就看不清，退回这个尺寸并在区域内滚动 */
export const GALLERY_MIN_SLOT = 240

export interface GalleryLayout {
  columns: number
  /** 每张的宽度（px，向下取整）；高度由格子的 aspect-ratio 决定 */
  slotWidth: number
  /** true = 全部格子都装得下（可以整体居中）；false = 退回最小尺寸、需要滚动 */
  fits: boolean
}

/**
 * 出图弹窗的格子排版（界面稿 2026-09-14-generate-button-mockup 第二部分）：
 * 在图片区域里按张数逐个试算列数，取让每张最大的那个；1 张时就是按比例顶满、不裁图。
 * 每张小于 GALLERY_MIN_SLOT 时退回最小尺寸，按宽度排满列数。
 *
 * @param aspect 宽 / 高
 * @returns 区域还没量出来或没有格子时 null（沿用 CSS 默认排版）
 */
export function galleryLayout(p: { count: number; aspect: number; width: number; height: number }): GalleryLayout | null {
  const { count, aspect } = p
  // ResizeObserver 报的是小数；不先取整的话按高度算出的格子会高出零点几像素，冒出滚动条又挤窄宽度
  const width = Math.floor(p.width)
  const height = Math.floor(p.height)
  if (count <= 0 || width <= 0 || height <= 0 || !(aspect > 0)) return null
  let best = { columns: 1, slot: 0 }
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns)
    const byWidth = (width - GALLERY_GAP * (columns - 1)) / columns
    const byHeight = ((height - GALLERY_GAP * (rows - 1)) / rows) * aspect
    const slot = Math.min(byWidth, byHeight)
    // 严格大于：一样大时取列数少的
    if (slot > best.slot) best = { columns, slot }
  }
  if (best.slot < GALLERY_MIN_SLOT) {
    return { columns: Math.max(1, Math.floor((width + GALLERY_GAP) / (GALLERY_MIN_SLOT + GALLERY_GAP))), slotWidth: GALLERY_MIN_SLOT, fits: false }
  }
  return { columns: best.columns, slotWidth: Math.floor(best.slot), fits: true }
}
