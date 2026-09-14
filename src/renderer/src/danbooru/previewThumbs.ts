import type { DanbooruPost } from '@shared/danbooru'

/**
 * 例图表每档只显示固定张数，不是一整页（spec §13.1）。posts.json 的
 * limit（决定总页数、进而决定新/中/旧怎么分档）与这里的显示上限是两个
 * 不同维度的常量，故意不复用同一个值——调大分页 limit 不该顺带把画在
 * 屏幕上的张数也调大，反之亦然。
 *
 * 是「取一页、只显示前 N 张」，不是按张数重新请求：分档数学只认页码，
 * 不受这里显示几张影响。
 */
export function selectPreviewThumbs(posts: DanbooruPost[], limit: number): DanbooruPost[] {
  if (!Number.isFinite(limit) || limit <= 0) return []
  return posts.slice(0, limit)
}
