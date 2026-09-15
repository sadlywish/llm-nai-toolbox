import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { duplicateName } from '@shared/duplicateName'
import { newId } from '@shared/ids'
import { moveStyle, nextStyleName, styleNameError, type StylePreset } from '@shared/styles'
import { normalizeWeights } from '@renderer/prompt/normalizeWeights'
import { estimateT5Tokens } from '@renderer/prompt/t5'
import TagTextEditor from '../editor/TagTextEditor'
import { useStyles } from '../state/styles'
import { useWorkspace } from '../state/workspace'

/** 确认框里的内容线索：截取前若干字符，帮用户认出删的是哪条 */
function previewOf(text: string, maxLen = 40): string {
  const trimmed = text.trim()
  return trimmed.length <= maxLen ? trimmed : `${trimmed.slice(0, maxLen)}…`
}

/** 按下后移动超过这么多像素才算拖动，否则松手就是一次点击 */
const DRAG_THRESHOLD_PX = 4
/** 拖到列表上下边缘这么近时自动滚动 */
const AUTO_SCROLL_EDGE_PX = 28
const AUTO_SCROLL_STEP_PX = 10

interface DragState {
  id: string
  from: number
  /** 插入位：插在第 to 行前面，等于行数时放到最后 */
  to: number
  /** 拖影在列表滚动内容里的纵坐标 */
  y: number
}

interface Props {
  /** 「覆盖画风」写进工作台后切回工作台 */
  onOpenWorkbench: () => void
}

/**
 * 画风维护视图：左侧列表 + 右侧详情（界面稿 docs/superpowers/specs/2026-09-15-style-list-mockup.html）。
 * 列表可拖动排序，绿点标出当前预设画风，顶上单独置顶当前预设；预设画风在这里选，指令区只显示。
 */
export default function StyleManager({ onOpenWorkbench }: Props): JSX.Element {
  const presets = useStyles((s) => s.presets)
  const loadError = useStyles((s) => s.loadError)
  const saveError = useStyles((s) => s.saveError)
  const saving = useStyles((s) => s.saving)
  const update = useStyles((s) => s.update)
  const dismissSaveError = useStyles((s) => s.dismissSaveError)
  const workspace = useWorkspace((s) => s.workspace)
  const updateWorkspace = useWorkspace((s) => s.update)

  // 打开的是哪条：纯界面浏览状态，不持久化。找不到（被删掉、刚进来）就退回当前预设，再退回第一条
  const [activeId, setActiveId] = useState<string | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  // 工具条的一次性提示，连同属于哪条一起存，只在对得上的那条显示
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null)
  // 新建、提取出来的那条：名称框自动聚焦并全选，接着就能打名字
  const [focusNameId, setFocusNameId] = useState<string | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // 刚拖完松手时浏览器还会补发一次 click，别让它把选中项换成被拖的那条
  const suppressClick = useRef(false)

  // 弹框期间才挂 Escape 监听
  useEffect(() => {
    if (pendingDeleteId === null) return
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setPendingDeleteId(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pendingDeleteId])

  const list = presets ?? []
  const presetId = workspace?.console.presetId ?? ''
  const current = list.find((p) => p.id === presetId) ?? null
  const active = list.find((p) => p.id === activeId) ?? current ?? list[0] ?? null

  // 打开的那条滚进列表可见范围：从指令区「选择预设…」进来、点顶上的当前预设时都要能看到它
  useEffect(() => {
    if (active === null) return
    const row = listRef.current?.querySelector<HTMLElement>(`[data-style-id="${active.id}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [active?.id])

  if (presets === null) {
    return (
      <section className="pane style-manager">
        <div className="placeholder">{loadError ?? '载入画风预设中…'}</div>
      </section>
    )
  }

  const pendingDelete = list.find((p) => p.id === pendingDeleteId)
  const workspaceArtist = (workspace?.main.artist ?? '').trim()

  function addPreset(tags: string): StylePreset {
    const preset: StylePreset = { id: newId('st'), name: nextStyleName(list), tags }
    update((draft) => {
      draft.push(preset)
    })
    setActiveId(preset.id)
    setFocusNameId(preset.id)
    return preset
  }

  function extractFromWorkbench(): void {
    const preset = addPreset(workspaceArtist)
    setNotice({ id: preset.id, text: '已从工作台 artist 块生成' })
  }

  function renamePreset(id: string, name: string): void {
    update((draft) => {
      const target = draft.find((p) => p.id === id)
      if (target) target.name = name
    })
  }

  function removePreset(id: string): void {
    update((draft) => {
      const at = draft.findIndex((p) => p.id === id)
      if (at >= 0) draft.splice(at, 1)
    })
  }

  function duplicatePreset(src: StylePreset): void {
    const copy: StylePreset = { id: newId('st'), name: duplicateName(src.name, list.map((p) => p.name)), tags: src.tags }
    update((draft) => {
      const at = draft.findIndex((p) => p.id === src.id)
      draft.splice(at + 1, 0, copy)
    })
    setActiveId(copy.id)
    setNotice({ id: copy.id, text: `已从「${src.name}」生成副本` })
  }

  /** 没有可转的老写法时不写回：写回会产生一次无意义的保存，也会把编辑器的撤销栈推进一格 */
  function normalizePreset(p: StylePreset): void {
    const r = normalizeWeights(p.tags)
    if (r.weights === 0 && r.artists === 0 && r.escapes === 0) {
      setNotice({ id: p.id, text: '没有需要转换的老写法' })
      return
    }
    update((draft) => {
      const target = draft.find((x) => x.id === p.id)
      if (target) target.tags = r.text
    })
    const parts: string[] = []
    if (r.weights > 0) parts.push(`${r.weights} 处权重`)
    if (r.artists > 0) parts.push(`${r.artists} 个 @ 标记`)
    if (r.escapes > 0) parts.push(`${r.escapes} 处转义括号`)
    setNotice({ id: p.id, text: `已转换 ${parts.join('、')}` })
  }

  /** 选为预设画风：只换预设，不动指令区的画风档位（用户拍板） */
  function choosePreset(p: StylePreset): void {
    updateWorkspace((ws) => {
      ws.console.presetId = p.id
    })
  }

  /** 覆盖画风：标签整段替换工作台的 artist 块，然后切回工作台 */
  function applyToWorkbench(p: StylePreset): void {
    updateWorkspace((ws) => {
      ws.main.artist = p.tags
    })
    onOpenWorkbench()
  }

  /** 按下一行：移动过门槛才进入拖动；松手时按插入位重排 */
  function startPointer(e: ReactPointerEvent<HTMLDivElement>, index: number, id: string): void {
    if (e.button !== 0) return
    const listEl = listRef.current
    if (listEl === null) return
    const startY = e.clientY
    let lastY = startY
    let dragging = false
    let to = index
    let raf = 0

    const place = (): void => {
      const rows = [...listEl.querySelectorAll<HTMLElement>('.style-row')]
      to = rows.filter((row) => {
        const r = row.getBoundingClientRect()
        return r.top + r.height / 2 < lastY
      }).length
      const box = listEl.getBoundingClientRect()
      setDrag({ id, from: index, to, y: lastY - box.top + listEl.scrollTop })
    }

    const autoScroll = (): void => {
      const box = listEl.getBoundingClientRect()
      if (lastY < box.top + AUTO_SCROLL_EDGE_PX) listEl.scrollTop -= AUTO_SCROLL_STEP_PX
      else if (lastY > box.bottom - AUTO_SCROLL_EDGE_PX) listEl.scrollTop += AUTO_SCROLL_STEP_PX
      place()
      raf = requestAnimationFrame(autoScroll)
    }

    const onMove = (ev: PointerEvent): void => {
      lastY = ev.clientY
      if (!dragging) {
        if (Math.abs(lastY - startY) < DRAG_THRESHOLD_PX) return
        dragging = true
        raf = requestAnimationFrame(autoScroll)
      }
      place()
    }

    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      cancelAnimationFrame(raf)
      if (!dragging) return
      suppressClick.current = true
      setTimeout(() => {
        suppressClick.current = false
      }, 0)
      setDrag(null)
      update((draft) => moveStyle(draft, index, to))
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const activeIsPreset = active !== null && active.id === presetId
  const activeEmpty = active !== null && active.tags.trim() === ''

  return (
    <>
      <section className="pane style-manager">
        <aside className="style-list">
          {/* 当前预设画风置顶：画风多时不用翻找（界面稿第三节理解 A） */}
          <button
            type="button"
            className={`style-current${current !== null && active?.id === current.id ? ' is-active' : ''}`}
            disabled={current === null}
            onClick={() => current !== null && setActiveId(current.id)}
          >
            <span className="style-current-label">当前预设画风</span>
            {current === null ? (
              <span className="style-current-none">未选择</span>
            ) : (
              <>
                <span className="style-current-name">
                  <span className="style-dot is-on" />
                  <span className="style-row-name">{current.name}</span>
                  {current.tags.trim() === '' && <span className="tab-empty-mark">空</span>}
                </span>
                <span className="style-current-tags">{current.tags.trim() === '' ? '（标签为空）' : current.tags}</span>
              </>
            )}
          </button>

          <div className="style-list-head">
            全部画风 <b>{list.length}</b>
            <span className="header-spacer" />
            <button
              type="button"
              className="btn btn-sm"
              disabled={workspaceArtist === ''}
              title={workspaceArtist === '' ? '工作台的 artist 块是空的' : '把工作台 artist 块现在的内容存成一条新画风'}
              onClick={extractFromWorkbench}
            >
              从工作台提取
            </button>
            <button type="button" className="btn btn-sm" title="新建画风" onClick={() => addPreset('')}>
              + 新建
            </button>
          </div>

          <div className="style-list-items" ref={listRef}>
            {list.map((p, index) => {
              const cls = ['style-row']
              if (p.id === active?.id) cls.push('is-active')
              if (p.id === presetId) cls.push('is-preset')
              if (drag !== null && drag.id === p.id) cls.push('is-dragging')
              if (drag !== null && drag.to === index) cls.push('is-drop-before')
              if (drag !== null && drag.to === list.length && index === list.length - 1) cls.push('is-drop-after')
              return (
                <div
                  key={p.id}
                  className={cls.join(' ')}
                  data-style-id={p.id}
                  title="点击打开；按住拖动调整顺序"
                  onPointerDown={(e) => startPointer(e, index, p.id)}
                  onClick={() => {
                    if (!suppressClick.current) setActiveId(p.id)
                  }}
                >
                  <span className="style-grip">⋮⋮</span>
                  <span className={`style-dot${p.id === presetId ? ' is-on' : ''}`} />
                  <span className="style-row-name">{p.name}</span>
                  {p.tags.trim() === '' && <span className="tab-empty-mark">空</span>}
                </div>
              )
            })}
            {drag !== null && (
              <div className="style-ghost" style={{ top: drag.y - 14 }}>
                <span className="style-grip">⋮⋮</span>
                {list.find((p) => p.id === drag.id)?.name}
              </div>
            )}
          </div>
        </aside>

        <div className="style-detail">
          {active === null && <div className="style-empty">还没有画风预设，点左边的「+ 新建」新建一条</div>}

          {active !== null && (
            <>
              <div className="style-detail-head">
                <NameInput
                  key={active.id}
                  preset={active}
                  presets={list}
                  autoFocus={focusNameId === active.id}
                  onFocused={() => setFocusNameId(null)}
                  onCommit={(name) => renamePreset(active.id, name)}
                />
                {activeIsPreset && (
                  <span className="style-preset-badge">
                    <span className="style-dot is-on" />
                    当前预设画风
                  </span>
                )}
                <span className="header-spacer" />
                <span className="pane-budget">约 {estimateT5Tokens(active.tags)} token</span>
              </div>

              <div className="style-actions">
                <button
                  type="button"
                  className="btn btn-choose"
                  disabled={activeIsPreset || activeEmpty || workspace === null}
                  title={activeEmpty ? '画风为空，不能选为预设' : '设为全局预设画风：指令区画风档位是「用预设画风覆盖」时回填用它'}
                  onClick={() => choosePreset(active)}
                >
                  {activeIsPreset ? '已是预设画风' : '选为预设画风'}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={activeEmpty || workspace === null}
                  title={activeEmpty ? '画风为空' : '把这条画风整段写进工作台的 artist 块，并切回工作台'}
                  onClick={() => applyToWorkbench(active)}
                >
                  覆盖画风
                </button>
                <span className="style-sep" />
                <button
                  type="button"
                  className="btn"
                  title="把 {x} [x] (x:1.2) 这类老写法转成 NAI 的 1.05::x:: 格式，把 @xxx 换成 artist:xxx，并把 webui 转义的 \( \) 还原成普通括号"
                  onClick={() => normalizePreset(active)}
                >
                  规范化权重与 @
                </button>
                <button type="button" className="btn" title="把当前画风复制成一条新画风" onClick={() => duplicatePreset(active)}>
                  生成副本
                </button>
                {notice?.id === active.id && (
                  <span className="prompt-toolbar-notice" role="status">
                    {notice.text}
                  </span>
                )}
                <span className="header-spacer" />
                <button
                  type="button"
                  className="btn btn-danger"
                  title="删除这个画风"
                  onClick={() => {
                    // 空预设没有工作可丢，弹确认只是摩擦，直接删
                    if (!activeEmpty) setPendingDeleteId(active.id)
                    else removePreset(active.id)
                  }}
                >
                  删除
                </button>
              </div>

              {/* key 带 id：切换画风时换掉 CodeMirror 实例与撤销栈，否则 Ctrl+Z 会串到别的预设 */}
              <div className="style-editor">
                <TagTextEditor
                  key={active.id}
                  value={active.tags}
                  prefer="artist"
                  flagFullWidthComma
                  placeholder="画风标签，例如 artist:wlop, thick painting"
                  onChange={(tags) =>
                    update((draft) => {
                      const target = draft.find((p) => p.id === active.id)
                      if (target) target.tags = tags
                    })
                  }
                />
              </div>
              <div className="style-foot">
                <span>Ctrl+↑/↓ 调整光标所在标签的权重</span>
                {saveError !== null ? (
                  <span className="field-error" role="alert">
                    {saveError}{' '}
                    <button type="button" className="link-button" onClick={dismissSaveError}>
                      知道了
                    </button>
                  </span>
                ) : (
                  <span>{saving ? '保存中…' : '已保存'}</span>
                )}
              </div>
            </>
          )}
        </div>
      </section>

      {pendingDelete !== undefined && (
        <div className="dialog-backdrop">
          <div className="dialog" role="dialog">
            <div className="dialog-title">删除画风「{pendingDelete.name}」？</div>
            <div className="dialog-body">
              <p>{previewOf(pendingDelete.tags)}</p>
              {pendingDelete.id === presetId && <p>它是当前预设画风，删除后预设变为「未选择」。</p>}
            </div>
            <div className="dialog-actions">
              {/* 默认焦点落在取消上：误操作防护本身不该在下一步又变成误操作 */}
              <button type="button" autoFocus onClick={() => setPendingDeleteId(null)}>
                取消
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  removePreset(pendingDelete.id)
                  setPendingDeleteId(null)
                }}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/**
 * 详情头部的名称框：直接改名。失焦或 Enter 提交；空名、重名时标红且不保存，失焦时退回原名；Esc 放弃。
 * 外面按画风 id 给 key，换一条画风就是一个新框，草稿不会串。
 */
function NameInput({
  preset,
  presets,
  autoFocus,
  onFocused,
  onCommit,
}: {
  preset: StylePreset
  presets: readonly StylePreset[]
  autoFocus: boolean
  onFocused: () => void
  onCommit: (name: string) => void
}): JSX.Element {
  const [draft, setDraft] = useState(preset.name)
  const ref = useRef<HTMLInputElement>(null)
  const error = styleNameError(draft, presets, preset.id)

  // 名字在别处变了（撤销、生成副本后的重名修正等）且框里没在改时，跟上
  useEffect(() => {
    if (document.activeElement !== ref.current) setDraft(preset.name)
  }, [preset.name])

  useEffect(() => {
    if (!autoFocus) return
    ref.current?.focus()
    ref.current?.select()
    onFocused()
  }, [autoFocus, onFocused])

  function commit(): void {
    const name = draft.trim()
    if (error === null && name !== preset.name) onCommit(name)
    else setDraft(preset.name)
  }

  return (
    <input
      ref={ref}
      className={`style-name-input${error !== null ? ' is-invalid' : ''}`}
      value={draft}
      title={error ?? '画风名称'}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') ref.current?.blur()
        if (e.key === 'Escape') {
          setDraft(preset.name)
          // 先退回原名再失焦，失焦时的提交看到的就是原名
          requestAnimationFrame(() => ref.current?.blur())
        }
      }}
    />
  )
}
