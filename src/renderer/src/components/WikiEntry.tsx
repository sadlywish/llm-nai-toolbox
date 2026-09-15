import { formatWikiTag } from '../prompt/insertTag'
import { insertIntoLastEditor } from '../editor/editorRegistry'
import { useWiki } from '../state/wiki'
import GlossCard from './GlossCard'
import { WikiEntryBody, WikiEntryHead } from './WikiEntryView'

interface Props {
  onWikiLink: (tag: string) => void
  onOpenImage: (url: string, alt: string) => void
}

/** WIKI 竖栏的词条：头部 → 中文说明（界面稿 2026-09-15-magicbook-mockup.html 第四节）→ 正文与例图 */
export default function WikiEntry({ onWikiLink, onOpenImage }: Props): JSX.Element {
  const entry = useWiki((s) => s.entry)
  const notice = useWiki((s) => s.notice)
  const setNotice = useWiki((s) => s.setNotice)
  const show = useWiki((s) => s.show)

  if (entry === null) return <div className="wiki-empty">搜索一个词，或在正向提示词里把光标停在词上</div>

  const isArtist = entry.source === 'artist'
  const gloss = entry.gloss.status === 'ready' ? entry.gloss.value : null

  function add(): void {
    if (entry === null) return
    const text = formatWikiTag(entry.tag, isArtist)
    if (insertIntoLastEditor(text)) {
      setNotice(null)
      return
    }
    void window.api.writeClipboardText(text).then(() => setNotice('已复制到剪贴板'))
  }

  return (
    <>
      <WikiEntryHead entry={entry} actionLabel="+ 加入" actionTitle="插到上次光标所在位置" onAction={add} notice={notice} meta />
      {!isArtist && gloss !== null && <GlossCard gloss={gloss} onTag={(t) => show(t, 'tag')} />}
      <WikiEntryBody entry={entry} onWikiLink={onWikiLink} onOpenImage={onOpenImage} />
    </>
  )
}
