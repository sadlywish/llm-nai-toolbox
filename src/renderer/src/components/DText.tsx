import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { parseDText, type DBlock, type DInline } from '@shared/dtext'

interface Props {
  body: string
  /** 点内链：在 WIKI 栏里切到那个 tag */
  onWikiLink: (tag: string) => void
  /** 点内嵌图：打开查看器 */
  onOpenImage: (url: string, alt: string) => void
}

/** !post #123：按 id 取一张帖子的缩略图 */
function PostImage({ postId, onOpen }: { postId: number; onOpen: (url: string, alt: string) => void }): JSX.Element {
  const [urls, setUrls] = useState<{ preview: string; open: string } | null | 'missing'>(null)
  useEffect(() => {
    let cancelled = false
    void window.api.danbooruPosts({ tag: `id:${postId}`, limit: 1, page: 1 }).then((r) => {
      if (cancelled) return
      const p = r.ok ? r.posts[0] : undefined
      const preview = p ? (p.previewUrl ?? p.largeUrl) : null
      const open = p ? (p.originalUrl ?? p.largeUrl ?? p.previewUrl) : null
      setUrls(preview && open ? { preview, open } : 'missing')
    })
    return () => {
      cancelled = true
    }
  }, [postId])
  if (urls === 'missing') return <span className="dtext-missing">!post #{postId}</span>
  if (urls === null) return <span className="dtext-img is-loading" />
  return (
    <button type="button" className="dtext-img" onClick={() => onOpen(urls.open, `post ${postId}`)}>
      <img src={urls.preview} alt={`post ${postId}`} loading="lazy" />
    </button>
  )
}

function renderInline(nodes: DInline[], p: Props): ReactNode[] {
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
        return <PostImage key={i} postId={n.postId} onOpen={p.onOpenImage} />
    }
  })
}

function renderBlock(b: DBlock, i: number, p: Props): ReactNode {
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
  return <div className="wiki-text">{doc.blocks.map((b, i) => renderBlock(b, i, props))}</div>
}

export function seeAlsoOf(body: string): string[] {
  return parseDText(body).seeAlso
}
