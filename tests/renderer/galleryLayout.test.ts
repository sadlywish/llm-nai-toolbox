import { describe, expect, it } from 'vitest'
import { GALLERY_GAP, GALLERY_MIN_SLOT, galleryLayout } from '../../src/renderer/src/galleryLayout'

describe('galleryLayout', () => {
  it('1 张按比例顶满：横图宽度受限、竖图高度受限，不裁图', () => {
    // 1376×820 区域，1216×832 横图：高度 820 → 宽 1198.46；宽度 1376 更宽，所以高度是瓶颈
    expect(galleryLayout({ count: 1, aspect: 1216 / 832, width: 1376, height: 820 })).toEqual({ columns: 1, slotWidth: 1198, fits: true })
    // 窄区域：宽度是瓶颈
    expect(galleryLayout({ count: 1, aspect: 1216 / 832, width: 600, height: 820 })).toEqual({ columns: 1, slotWidth: 600, fits: true })
  })

  it('多张时取让每张最大的列数（3 张横图 → 2 列，6 张竖图 → 3 列）', () => {
    expect(galleryLayout({ count: 3, aspect: 1216 / 832, width: 1376, height: 820 })).toEqual({ columns: 2, slotWidth: 593, fits: true })
    expect(galleryLayout({ count: 6, aspect: 832 / 1216, width: 1376, height: 820 })).toEqual({ columns: 3, slotWidth: 277, fits: true })
  })

  it('每张小于最小尺寸时退回固定最小尺寸、按宽度排满列数，区域内滚动', () => {
    const r = galleryLayout({ count: 40, aspect: 832 / 1216, width: 1376, height: 820 })
    expect(r).toEqual({ columns: Math.floor((1376 + GALLERY_GAP) / (GALLERY_MIN_SLOT + GALLERY_GAP)), slotWidth: GALLERY_MIN_SLOT, fits: false })
  })

  it('区域还没量出来（0×0）或没有格子时不排版', () => {
    expect(galleryLayout({ count: 3, aspect: 1, width: 0, height: 0 })).toBeNull()
    expect(galleryLayout({ count: 0, aspect: 1, width: 1376, height: 820 })).toBeNull()
  })

  it('区域尺寸是小数时，格子高度不超出区域（不冒滚动条）', () => {
    const aspect = 1152 / 1792
    const r = galleryLayout({ count: 1, aspect, width: 1366.4, height: 821.6 })!
    expect(r.slotWidth / aspect).toBeLessThanOrEqual(821)
    expect(r.slotWidth).toBe(527)
  })

  it('区域比最小尺寸还窄时至少 1 列', () => {
    expect(galleryLayout({ count: 5, aspect: 1, width: 200, height: 100 })).toEqual({ columns: 1, slotWidth: GALLERY_MIN_SLOT, fits: false })
  })
})
