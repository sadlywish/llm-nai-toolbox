import type { CSSProperties } from 'react'
import type { CompletionPrefer } from '@shared/blockCompletion'
import { formatCount } from '../format'
import { ARTIST_THUMBS_PER_BUCKET, TAG_POSTS_LIMIT, type Load, type WikiEntry } from '../state/wiki'
import DText, { seeAlsoOf } from './DText'
import WikiPosts from './WikiPosts'

const CAT_BY_PREFER: Record<CompletionPrefer, { label: string; hue: number }> = {
  artist: { label: '画师', hue: 30 },
  character: { label: '角色', hue: 250 },
  series: { label: '作品', hue: 285 },
  general: { label: '一般', hue: 85 },
}
const CAT_BY_DANBOORU: Record<number, { label: string; hue: number }> = {
  0: CAT_BY_PREFER.general,
  1: CAT_BY_PREFER.artist,
  3: CAT_BY_PREFER.series,
  4: CAT_BY_PREFER.character,
  5: { label: '元标签', hue: 190 },
}
const BUCKET_LABEL = { new: '新', mid: '中', old: '旧' } as const

const valueOf = <T,>(l: Load<T>): T | undefined => (l.status === 'ready' ? l.value : undefined)
const settled = (l: Load<unknown>): boolean => l.status !== 'loading'

const errorLine = (l: Load<unknown>): JSX.Element | null =>
  l.status === 'error' ? <div className="wiki-error">D 站请求失败：{l.message}</div> : null

/** 中文别名 / 画师别名 / 主页 */
export function WikiEntryMeta({ entry }: { entry: WikiEntry }): JSX.Element {
  const local = valueOf(entry.local)
  const artist = valueOf(entry.artist)
  return (
    <div className="wiki-meta">
      {local && local.zh.length > 0 && (
        <>
          <span className="k">中文</span>
          <span>{local.zh.join('、')}</span>
        </>
      )}
      {artist && artist.otherNames.length > 0 && (
        <>
          <span className="k">别名</span>
          <span>{artist.otherNames.join('、')}</span>
        </>
      )}
      {artist && artist.urls.length > 0 && (
        <>
          <span className="k">主页</span>
          <span>
            {artist.urls.map((u) => (
              <a key={u} href={u} target="_blank" rel="noreferrer" className="wiki-url">
                {u.replace(/^https?:\/\/(www\.)?/, '')} ↗
              </a>
            ))}
          </span>
        </>
      )}
    </div>
  )
}

/** 词条头：名字、分类、封禁/删除、帖子数、动作按钮（竖栏「+ 加入」、魔法书「复制」），可选带 meta */
export function WikiEntryHead(props: {
  entry: WikiEntry
  actionLabel: string
  actionTitle: string
  onAction: () => void
  notice: string | null
  meta: boolean
}): JSX.Element {
  const { entry } = props
  const local = valueOf(entry.local)
  const tagInfo = valueOf(entry.tagInfo)
  const artist = valueOf(entry.artist)
  const wiki = valueOf(entry.wiki)
  const isArtist = entry.source === 'artist'
  const cat = isArtist ? CAT_BY_PREFER.artist : tagInfo ? CAT_BY_DANBOORU[tagInfo.category] : local ? CAT_BY_PREFER[local.category] : undefined
  const count = isArtist ? (entry.artistPostCount ?? local?.count) : (tagInfo?.postCount ?? local?.count)
  const notFound =
    settled(entry.local) && settled(entry.wiki) && (isArtist ? settled(entry.artist) && artist === null : settled(entry.tagInfo) && tagInfo === null) &&
    local === null && wiki === null
  return (
    <div className="wiki-entry-head">
      <div className="wiki-name-row">
        <span className="wiki-name">{entry.tag.replace(/_/g, ' ')}</span>
        {cat && <span className="wiki-cat" style={{ '--h': cat.hue } as CSSProperties}>{cat.label}</span>}
        {artist?.isBanned && <span className="wiki-badge">已封禁</span>}
        {artist?.isDeleted && <span className="wiki-badge">已删除</span>}
        {count !== undefined && <span className="wiki-count">帖子 {formatCount(count)}</span>}
        <button type="button" className="wiki-add" title={props.actionTitle} onClick={props.onAction}>
          {props.actionLabel}
        </button>
      </div>
      {props.notice !== null && <div className="wiki-notice">{props.notice}</div>}
      {notFound && <div className="wiki-dim">查不到这个词</div>}
      {props.meta && <WikiEntryMeta entry={entry} />}
      {errorLine(isArtist ? entry.artist : entry.tagInfo)}
    </div>
  )
}

/** 正文、See also、例图 */
export function WikiEntryBody(props: {
  entry: WikiEntry
  onWikiLink: (tag: string) => void
  onOpenImage: (url: string, alt: string) => void
}): JSX.Element {
  const { entry, onWikiLink, onOpenImage } = props
  const wiki = valueOf(entry.wiki)
  const isArtist = entry.source === 'artist'
  return (
    <>
      {entry.wiki.status === 'loading' && <div className="wiki-dim">载入中…</div>}
      {errorLine(entry.wiki)}
      {wiki && <DText body={wiki.body} onWikiLink={onWikiLink} onOpenImage={onOpenImage} />}
      {wiki && seeAlsoOf(wiki.body).length > 0 && (
        <div className="wiki-seealso">
          <span className="k">See also</span>
          {seeAlsoOf(wiki.body).map((t) => (
            <button key={t} type="button" className="wiki-chip" onClick={() => onWikiLink(t)}>
              {t.replace(/_/g, ' ')}
            </button>
          ))}
        </div>
      )}

      {!isArtist && (
        <>
          <div className="wiki-section-title">例图<span className="sub">评分最高 {TAG_POSTS_LIMIT} 张</span></div>
          <WikiPosts posts={entry.tagPosts} count={TAG_POSTS_LIMIT} onOpen={onOpenImage} />
        </>
      )}
      {isArtist && entry.buckets === null && <div className="wiki-dim">例图载入中…</div>}
      {isArtist && entry.buckets !== null && entry.buckets.length === 0 && <div className="wiki-dim">没有例图</div>}
      {isArtist && entry.bucketsCollapsed && <div className="wiki-dim">作品页数不足以分出新/中/旧三档，以下按现有页数顺序展示</div>}
      {isArtist &&
        entry.buckets?.map((b) => (
          <div key={b.kind}>
            <div className="wiki-section-title">例图<span className="sub">{BUCKET_LABEL[b.kind]} · 第 {b.page} 页</span></div>
            <WikiPosts posts={b.posts} count={ARTIST_THUMBS_PER_BUCKET} onOpen={onOpenImage} />
          </div>
        ))}
    </>
  )
}
