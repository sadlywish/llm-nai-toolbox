import { useCallback, useEffect, useState } from 'react'
import { completionTargetAt } from '@shared/blockCompletion'
import { cursorBus } from '../editor/cursorBus'
import { useWiki } from '../state/wiki'
import ImageViewer from '../viewer/ImageViewer'
import WikiControls from './WikiControls'
import WikiEntry from './WikiEntry'

/**
 * 右侧 WIKI 竖栏（界面稿 2026-09-14-wiki-rail-mockup.html）。
 * 收起时整栏不渲染，也不订阅光标广播——编辑器那边因此不取文档、不算词（规格 R1、R2）。
 */
export default function WikiRail(): JSX.Element | null {
  const collapsed = useWiki((s) => s.collapsed)
  const followCursor = useWiki((s) => s.followCursor)
  const [viewer, setViewer] = useState<{ url: string; alt: string } | null>(null)

  useEffect(() => {
    if (collapsed || !followCursor) return
    return cursorBus.subscribe(({ doc, specs, head }) => {
      const target = completionTargetAt(doc, specs, head)
      if (target !== null) useWiki.getState().onCursorWord(target.query, target.prefer === 'artist')
    })
  }, [collapsed, followCursor])

  const onWikiLink = useCallback((tag: string) => {
    void window.api.tagdbLookup(tag).then((local) => useWiki.getState().show(tag, local?.category === 'artist' ? 'artist' : 'tag'))
  }, [])

  if (collapsed) return null
  return (
    <aside className="wiki-rail">
      <WikiControls />
      <div className="wiki-body">
        <WikiEntry onWikiLink={onWikiLink} onOpenImage={(url, alt) => setViewer({ url, alt })} />
      </div>
      {viewer !== null && <ImageViewer url={viewer.url} alt={viewer.alt} onClose={() => setViewer(null)} />}
    </aside>
  )
}
