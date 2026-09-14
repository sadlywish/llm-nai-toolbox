import { useState } from 'react'
import type { DanbooruPost } from '@shared/danbooru'
import { selectPreviewThumbs } from '../danbooru/previewThumbs'
import type { Load } from '../state/wiki'

/** 单张缩略图：CDN 首字节可能要几秒，必须有占位（照工具箱 ArtistPostGrid 的 Thumb） */
function Thumb({ post, onOpen }: { post: DanbooruPost; onOpen: (url: string, alt: string) => void }): JSX.Element | null {
  const [loaded, setLoaded] = useState(false)
  const preview = post.previewUrl ?? post.largeUrl
  const open = post.originalUrl ?? post.largeUrl ?? post.previewUrl
  if (preview === null || open === null) return null
  return (
    <button type="button" className={`wiki-thumb ${loaded ? '' : 'is-loading'}`} title={`post ${post.id}`} onClick={() => onOpen(open, `post ${post.id}`)}>
      <img src={preview} alt={`post ${post.id}`} loading="lazy" onLoad={() => setLoaded(true)} onError={() => setLoaded(true)} />
    </button>
  )
}

interface Props {
  posts: Load<DanbooruPost[]>
  count: number
  onOpen: (url: string, alt: string) => void
}

export default function WikiPosts({ posts, count, onOpen }: Props): JSX.Element {
  if (posts.status === 'loading') {
    return <div className="wiki-thumbs">{Array.from({ length: count }, (_, i) => <span key={i} className="wiki-thumb is-loading" />)}</div>
  }
  if (posts.status === 'error') return <div className="wiki-error">D 站请求失败：{posts.message}</div>
  if (posts.value.length === 0) return <div className="wiki-dim">没有例图</div>
  return (
    <div className="wiki-thumbs">
      {selectPreviewThumbs(posts.value, count).map((p) => (
        <Thumb key={p.id} post={p} onOpen={onOpen} />
      ))}
    </div>
  )
}
