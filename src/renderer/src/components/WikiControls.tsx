import { useState } from 'react'
import type { ArtistMatchDimension } from '../danbooru/suggest'
import { formatCount } from '../format'
import { useWiki } from '../state/wiki'

const DIM_LABEL: Record<ArtistMatchDimension, string> = { name: '名称', alias: '别名', url: '链接' }

export default function WikiControls(): JSX.Element {
  const source = useWiki((s) => s.source)
  const followCursor = useWiki((s) => s.followCursor)
  const query = useWiki((s) => s.query)
  const suggestions = useWiki((s) => s.suggestions)
  const { setSource, toggleFollowCursor, setQuery, show } = useWiki.getState()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)

  function pick(index: number): void {
    const s = suggestions[index]
    if (s) show(s.tag, source)
    else if (query.trim() !== '') show(query, source)
    setOpen(false)
  }

  return (
    <div className="wiki-controls">
      <div className="wiki-row">
        <div className="wiki-seg" role="tablist">
          <button type="button" role="tab" className={source === 'artist' ? 'is-on' : ''} onClick={() => setSource('artist')}>
            画师
          </button>
          <button type="button" role="tab" className={source === 'tag' ? 'is-on' : ''} onClick={() => setSource('tag')}>
            标签
          </button>
        </div>
        <label className="wiki-follow">
          <input type="checkbox" checked={followCursor} onChange={toggleFollowCursor} /> 跟随光标
        </label>
      </div>
      <div className="wiki-search">
        <input
          value={query}
          placeholder={source === 'tag' ? '搜索标签（支持中文别名）…' : '搜索画师：名称、别名或主页链接…'}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(a + 1, suggestions.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(a - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              pick(open ? active : -1)
            } else if (e.key === 'Escape') {
              setOpen(false)
            }
          }}
        />
        {open && suggestions.length > 0 && (
          <ul className="wiki-suggest">
            {suggestions.map((s, i) => (
              <li
                key={s.tag}
                className={i === active ? 'is-active' : ''}
                // mousedown 先于 blur：用 click 的话输入框先失焦、下拉先关，点不中
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(i)
                }}
                onMouseEnter={() => setActive(i)}
              >
                {s.label}
                {s.byGloss ? (
                  <span className="gl">{s.gloss}</span>
                ) : (
                  s.zh.length > 0 && <span className="zh">{s.zh[0]}</span>
                )}
                {s.byGloss && <span className="by">释义</span>}
                {s.matchedBy.length > 0 && <span className="by">{s.matchedBy.map((d) => DIM_LABEL[d]).join('·')}</span>}
                {s.count !== null && <span className="cnt">{formatCount(s.count)}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
