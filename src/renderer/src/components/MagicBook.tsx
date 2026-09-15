import { useEffect } from 'react'
import { useMagicBook } from '../state/magicbook'
import MagicDetail from './MagicDetail'
import MagicList from './MagicList'
import MagicTree from './MagicTree'

/** TAG 魔法书（界面稿 docs/superpowers/specs/2026-09-15-magicbook-mockup.html）：左分类树 · 中列表 · 右详情 */
export default function MagicBook(): JSX.Element {
  useEffect(() => useMagicBook.getState().init(), [])
  return (
    <section className="mb-page">
      <MagicTree />
      <MagicList />
      <MagicDetail />
    </section>
  )
}
