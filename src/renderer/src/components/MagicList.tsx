import { useEffect, useRef } from 'react'
import { formatCount } from '../format'
import { useMagicBook } from '../state/magicbook'

const catLabel = (cat: string): string => cat.replace('/', ' / ')

/** 中栏：标签列表（浏览按帖子数；检索按档位，释义后带分类） */
export default function MagicList(): JSX.Element {
  const activeCat = useMagicBook((s) => s.activeCat)
  const list = useMagicBook((s) => s.list)
  const search = useMagicBook((s) => s.search)
  const query = useMagicBook((s) => s.query)
  const selected = useMagicBook((s) => s.selected)
  const copied = useMagicBook((s) => s.copied)
  const { select, copy } = useMagicBook.getState()
  const rowsRef = useRef<HTMLDivElement>(null)

  const searching = search !== null
  const source = searching ? search : list
  const result = search?.status === 'ready' ? search.value : null
  const items = searching ? (result?.items ?? []) : list?.status === 'ready' ? list.value : []
  const count = searching ? (activeCat === null ? (result?.total ?? 0) : (result?.byCat[activeCat] ?? 0)) : items.length
  const rest = searching ? count - items.length : 0

  // 选中项滚进可见范围：从详情里点辨析、wiki 链接定位过来时要看得到它
  useEffect(() => {
    if (selected === null) return
    rowsRef.current?.querySelector<HTMLElement>(`[data-tag="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected, items])

  return (
    <section className="mb-list">
      <div className="mb-list-head">
        {searching ? (
          <>
            搜索「<b>{query.trim()}</b>」· {activeCat === null ? '全部命中' : catLabel(activeCat)} <b>{count}</b> 条
            <span className="mb-list-sort">按标签名 › 释义 › 别名命中排序，同档按帖子数</span>
          </>
        ) : (
          activeCat !== null && (
            <>
              <b>{catLabel(activeCat)}</b> · {count} 条<span className="mb-list-sort">按帖子数排序</span>
            </>
          )
        )}
      </div>
      <div className="mb-rows" ref={rowsRef}>
        {source?.status === 'loading' && <div className="mb-empty">载入中…</div>}
        {source?.status === 'error' && <div className="mb-empty">{source.message}</div>}
        {searching && result !== null && count === 0 && <div className="mb-empty">没有命中</div>}
        {items.map((it) => (
          <div key={it.t} data-tag={it.t} className={`mb-row${selected === it.t ? ' is-active' : ''}`} onClick={() => select(it.t)}>
            <span className="mb-tag">{it.t.replace(/_/g, ' ')}</span>
            <span className="mb-gl" title={it.g}>
              {it.g}
              {searching && <span className="cat">{catLabel(it.cat)}</span>}
            </span>
            <span className="mb-marks">
              {it.trap && <span className="mb-mark trap">易误读</span>}
              {it.vs && <span className="mb-mark vs">辨析</span>}
            </span>
            <span className="mb-cnt">{formatCount(it.c)}</span>
            <button
              type="button"
              className="btn btn-sm mb-copy"
              onClick={(e) => {
                e.stopPropagation()
                copy(it.t)
              }}
            >
              {copied === it.t ? '已复制' : '复制'}
            </button>
          </div>
        ))}
        {rest > 0 && <div className="mb-more">还有 {rest} 条，换个更具体的关键词</div>}
      </div>
    </section>
  )
}
