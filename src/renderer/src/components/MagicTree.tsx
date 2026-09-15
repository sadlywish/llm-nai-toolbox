import { useMagicBook } from '../state/magicbook'

const subLabel = (cat: string): string => cat.slice(cat.indexOf('/') + 1)

/** 左栏：检索框 + 两级分类树（界面稿 2026-09-15-magicbook-mockup.html 二、三节） */
export default function MagicTree(): JSX.Element {
  const tree = useMagicBook((s) => s.tree)
  const expanded = useMagicBook((s) => s.expanded)
  const activeCat = useMagicBook((s) => s.activeCat)
  const query = useMagicBook((s) => s.query)
  const search = useMagicBook((s) => s.search)
  const { toggleGroup, openCat, setQuery } = useMagicBook.getState()

  const value = tree?.status === 'ready' ? tree.value : null
  const result = search?.status === 'ready' ? search.value : null
  const searching = search !== null
  const catCount = value === null ? 0 : value.groups.reduce((n, g) => n + g.subs.length, 0)

  let note = ''
  if (!searching && value !== null) note = `${value.groups.length} 组 · ${catCount} 类 · ${value.total.toLocaleString('en-US')} 个标签`
  if (searching) note = result === null ? '检索中…' : `命中 ${result.total} 条，分布在 ${Object.keys(result.byCat).length} 个分类`

  return (
    <aside className="mb-tree">
      <div className="mb-search">
        <input
          className={query.trim() !== '' ? 'has-q' : ''}
          value={query}
          placeholder="搜标签名、中文释义、中英日别名…"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('')
          }}
        />
        {note !== '' && <span className="mb-search-note">{note}</span>}
      </div>
      <div className="mb-tree-items">
        {tree?.status === 'error' && <div className="mb-empty">{tree.message}</div>}
        {searching && result !== null && result.total === 0 && <div className="mb-empty">没有命中</div>}
        {searching && result !== null && result.total > 0 && (
          <button type="button" className={`mb-group${activeCat === null ? ' is-active' : ''}`} onClick={() => openCat(null)}>
            <span className="arrow" />
            全部命中
            <span className="n hit">{result.total}</span>
          </button>
        )}
        {value?.groups.map((g) => {
          if (searching) {
            if (result === null) return null
            const subs = g.subs.filter((s) => (result.byCat[s.cat] ?? 0) > 0)
            if (subs.length === 0) return null
            const n = subs.reduce((sum, s) => sum + result.byCat[s.cat], 0)
            return (
              <div key={g.top}>
                <div className="mb-group is-static">
                  <span className="arrow">▾</span>
                  {g.top}
                  <span className="n hit">{n}</span>
                </div>
                {subs.map((s) => (
                  <button key={s.cat} type="button" className={`mb-sub${activeCat === s.cat ? ' is-active' : ''}`} onClick={() => openCat(s.cat)}>
                    <span className="name">{subLabel(s.cat)}</span>
                    <span className="n hit">{result.byCat[s.cat]}</span>
                  </button>
                ))}
              </div>
            )
          }
          const open = expanded.includes(g.top)
          return (
            <div key={g.top}>
              <button type="button" className="mb-group" onClick={() => toggleGroup(g.top)}>
                <span className="arrow">{open ? '▾' : '▸'}</span>
                {g.top}
                <span className="n">{g.n}</span>
              </button>
              {open &&
                g.subs.map((s) => (
                  <button key={s.cat} type="button" className={`mb-sub${activeCat === s.cat ? ' is-active' : ''}`} onClick={() => openCat(s.cat)}>
                    <span className="name">{s.sub}</span>
                    <span className="n">{s.n}</span>
                  </button>
                ))}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
