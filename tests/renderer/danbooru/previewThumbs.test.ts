import { describe, expect, it } from 'vitest'
import { selectPreviewThumbs } from '@renderer/danbooru/previewThumbs'
import type { DanbooruPost } from '@shared/danbooru'

function post(id: number): DanbooruPost {
  return { id, previewUrl: `p${id}`, largeUrl: null, originalUrl: null }
}

describe('selectPreviewThumbs', () => {
  it('一页张数超过显示上限时只取前 N 张', () => {
    const posts = Array.from({ length: 20 }, (_, i) => post(i + 1))
    const result = selectPreviewThumbs(posts, 6)
    expect(result).toHaveLength(6)
    expect(result.map((p) => p.id)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('一页张数不足上限时原样返回，不补空位', () => {
    const posts = [post(1), post(2)]
    expect(selectPreviewThumbs(posts, 6)).toEqual(posts)
  })

  it('空数组返回空数组', () => {
    expect(selectPreviewThumbs([], 6)).toEqual([])
  })

  it('上限非正数或非有限数时视为不显示', () => {
    const posts = [post(1), post(2)]
    expect(selectPreviewThumbs(posts, 0)).toEqual([])
    expect(selectPreviewThumbs(posts, -1)).toEqual([])
    expect(selectPreviewThumbs(posts, NaN)).toEqual([])
  })
})
