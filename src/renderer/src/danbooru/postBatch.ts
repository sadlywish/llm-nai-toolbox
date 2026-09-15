import type { DBlock, DInline, DTextDoc } from '@shared/dtext'

/**
 * wiki 正文里 !post #id 的批量取图。
 *
 * 原来每张内嵌图各发一次 posts.json?tags=id:N，全部挤进 Danbooru 客户端的全局令牌桶
 * （突发 6 个、之后每秒 1 个）。japanese_clothes 这种正文里 123 张图的词条要排约 120 秒，
 * 期间切到别的词条，它的正文、例图请求也排在后面（实测模拟 111–113 秒），看起来就是「图片读不出来」。
 * D 站自己的 wiki 页是服务端直接给出缩略图地址，不逐张调接口。
 *
 * 改成一页一次：id:1,2,3 这种列表查询 Danbooru 支持（实测，不存在的 id 直接略过、返回按 id 倒序），
 * 一批最多 POST_BATCH_SIZE 个，limit 同步设成这一批的个数。图片本身照旧由 <img> 并发加载，
 * CDN 不经过令牌桶。
 */

/** 一次查询最多带多少个 id：posts.json 单页上限 200，取 100 让 URL 也不至于太长 */
export const POST_BATCH_SIZE = 100

function fromInline(nodes: DInline[], out: number[]): void {
  for (const n of nodes) {
    if (n.type === 'postImage') out.push(n.postId)
    else if (n.type === 'style') fromInline(n.children, out)
  }
}

function fromBlocks(blocks: DBlock[], out: number[]): void {
  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
      case 'paragraph':
        fromInline(b.children, out)
        break
      case 'list':
        for (const it of b.items) fromInline(it.children, out)
        break
      case 'quote':
        fromBlocks(b.blocks, out)
        break
      case 'code':
        break
    }
  }
}

/** 正文里所有内嵌图的帖子 id，去重、保持先后 */
export function collectPostIds(doc: DTextDoc): number[] {
  const out: number[] = []
  fromBlocks(doc.blocks, out)
  return [...new Set(out)]
}

export function chunkIds(ids: readonly number[], size: number): number[][] {
  const chunks: number[][] = []
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size))
  return chunks
}

/** Danbooru 的 id 列表元标签 */
export function idsTag(ids: readonly number[]): string {
  return `id:${ids.join(',')}`
}
