import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { DanbooruPost } from '@shared/danbooru'
import { parseDText, type DBlock, type DInline } from '@shared/dtext'
import { POST_BATCH_SIZE, chunkIds, collectPostIds, idsTag } from '../danbooru/postBatch'

interface Props {
  body: string
  /** 点内链：在 WIKI 栏里切到那个 tag */
  onWikiLink: (tag: string) => void
  /** 点内嵌图：打开查看器 */
  onOpenImage: (url: string, alt: string) => void
}

/** 渲染时往下传的上下文：整页内嵌图的批量查询结果，null = 还在查 */
interface RenderCtx extends Props {
  posts: Map<number, DanbooruPost> | null
}

/** !post #123：缩略图地址来自整页的批量查询（见 danbooru/postBatch.ts），这里不再各自请求 */
function PostImage({ postId, posts, onOpen }: { postId: number; posts: Map<number, DanbooruPost> | null; onOpen: (url: string, alt: string) => void }): JSX.Element {
  if (posts === null) return <span className="dtext-img is-loading" />
  const p = posts.get(postId)
  const preview = p ? (p.previewUrl ?? p.largeUrl) : null
  const open = p ? (p.originalUrl ?? p.largeUrl ?? p.previewUrl) : null
  if (!preview || !open) return <span className="dtext-missing">!post #{postId}</span>
  return (
    <button type="button" className="dtext-img" onClick={() => onOpen(open, `post ${postId}`)}>
      <img src={preview} alt={`post ${postId}`} loading="lazy" />
    </button>
  )
}

function renderInline(nodes: DInline[], p: RenderCtx): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.type) {
      case 'text':
        return n.text
      case 'br':
        return <br key={i} />
      case 'wikiLink':
        return (
          <a key={i} href="#" className="dtext-wiki" onClick={(e) => { e.preventDefault(); p.onWikiLink(n.tag) }}>
            {n.label}
          </a>
        )
      case 'extLink':
        // target=_blank 交给主进程 setWindowOpenHandler，只放行 http(s)，用系统浏览器打开
        return (
          <a key={i} href={n.url} target="_blank" rel="noreferrer">
            {n.label} ↗
          </a>
        )
      case 'style': {
        const Tag = n.style
        return <Tag key={i}>{renderInline(n.children, p)}</Tag>
      }
      case 'postImage':
        return <PostImage key={i} postId={n.postId} posts={p.posts} onOpen={p.onOpenImage} />
    }
  })
}

function renderBlock(b: DBlock, i: number, p: RenderCtx): ReactNode {
  switch (b.type) {
    case 'heading':
      // 统一降两级：wiki 的 h4 显示成比词条名小的小标题
      return <div key={i} className={`dtext-h dtext-h${Math.min(6, b.level + 2)}`}>{renderInline(b.children, p)}</div>
    case 'paragraph':
      return <p key={i}>{renderInline(b.children, p)}</p>
    case 'list':
      return (
        <ul key={i}>
          {b.items.map((it, j) => (
            <li key={j} style={{ marginLeft: `${(it.depth - 1) * 14}px` }}>{renderInline(it.children, p)}</li>
          ))}
        </ul>
      )
    case 'quote':
      return <blockquote key={i}>{b.blocks.map((x, j) => renderBlock(x, j, p))}</blockquote>
    case 'code':
      return <pre key={i}>{b.text}</pre>
  }
}

/** wiki 正文。See also 由调用方另外渲染成芯片（parseDText 已从正文里去掉那一节） */
export default function DText(props: Props): JSX.Element {
  const doc = useMemo(() => parseDText(props.body), [props.body])
  const postIds = useMemo(() => collectPostIds(doc), [doc])
  const [posts, setPosts] = useState<Map<number, DanbooruPost> | null>(null)

  // 整页内嵌图一次查完（每批最多 POST_BATCH_SIZE 个 id）。查不到或请求失败的 id 显示成「!post #id」文字
  useEffect(() => {
    if (postIds.length === 0) {
      setPosts(new Map())
      return
    }
    let cancelled = false
    setPosts(null)
    void Promise.all(
      chunkIds(postIds, POST_BATCH_SIZE).map((chunk) =>
        window.api.danbooruPosts({ tag: idsTag(chunk), limit: chunk.length, page: 1 }).then((r) => (r.ok ? r.posts : [])),
      ),
    ).then((groups) => {
      if (!cancelled) setPosts(new Map(groups.flat().map((post) => [post.id, post])))
    })
    return () => {
      cancelled = true
    }
  }, [postIds])

  const ctx: RenderCtx = { ...props, posts }
  return <div className="wiki-text">{doc.blocks.map((b, i) => renderBlock(b, i, ctx))}</div>
}

export function seeAlsoOf(body: string): string[] {
  return parseDText(body).seeAlso
}
