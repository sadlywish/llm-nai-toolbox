import { useState } from 'react'
import { useMagicBook } from '../state/magicbook'
import ImageViewer from '../viewer/ImageViewer'
import GlossCard from './GlossCard'
import { WikiEntryBody, WikiEntryHead, WikiEntryMeta } from './WikiEntryView'

/** 右栏：词条头 → 中文说明 → D 站 WIKI */
export default function MagicDetail(): JSX.Element {
  const entry = useMagicBook((s) => s.entry)
  const copied = useMagicBook((s) => s.copied)
  const { locate, copy } = useMagicBook.getState()
  const [viewer, setViewer] = useState<{ url: string; alt: string } | null>(null)

  if (entry === null) {
    return (
      <aside className="mb-detail">
        <div className="wiki-empty">点列表里的标签，查看中文说明与 D 站 WIKI</div>
      </aside>
    )
  }
  const gloss = entry.gloss.status === 'ready' ? entry.gloss.value : null
  return (
    <aside className="mb-detail">
      <WikiEntryHead
        entry={entry}
        actionLabel={copied === entry.tag ? '已复制' : '复制'}
        actionTitle="复制到剪贴板（下划线换成空格）"
        onAction={() => copy(entry.tag)}
        notice={null}
        meta={false}
      />
      {gloss !== null && <GlossCard gloss={gloss} title="中文说明（与 LLM 工具看到的一致）" showCat onTag={locate} />}
      <div className="mb-divider">D 站 WIKI</div>
      <WikiEntryMeta entry={entry} />
      <WikiEntryBody entry={entry} onWikiLink={locate} onOpenImage={(url, alt) => setViewer({ url, alt })} />
      {viewer !== null && <ImageViewer url={viewer.url} alt={viewer.alt} onClose={() => setViewer(null)} />}
    </aside>
  )
}
