import { useEffect, useState } from 'react'
import { duplicateName } from '@shared/duplicateName'
import { newId } from '@shared/ids'
import { nextStyleName, styleNameError, type StylePreset } from '@shared/styles'
import { normalizeWeights } from '@renderer/prompt/normalizeWeights'
import { estimateT5Tokens } from '@renderer/prompt/t5'
import TagTextEditor from '../editor/TagTextEditor'
import { useStyles } from '../state/styles'

/** 确认框里的内容线索：截取前若干字符，帮用户认出删的是哪条 */
function previewOf(text: string, maxLen = 40): string {
  const trimmed = text.trim()
  return trimmed.length <= maxLen ? trimmed : `${trimmed.slice(0, maxLen)}…`
}

/**
 * 画风维护视图。照画师串工具箱的画师串编辑器：页签是一条条预设，下面是标签编辑器。
 * 界面稿：docs/superpowers/specs/2026-09-13-style-presets-mockup.html（第 1 版，已确认）。
 */
export default function StyleManager(): JSX.Element {
  const presets = useStyles((s) => s.presets)
  const loadError = useStyles((s) => s.loadError)
  const saveError = useStyles((s) => s.saveError)
  const saving = useStyles((s) => s.saving)
  const update = useStyles((s) => s.update)
  const dismissSaveError = useStyles((s) => s.dismissSaveError)

  // 打开的是哪条：纯界面浏览状态，不持久化。找不到（被删掉）就退回第一条
  const [activeId, setActiveId] = useState<string | null>(null)
  // 正在改名的那条与草稿：双击名称进入，Enter/失焦提交，Esc 放弃
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  // 工具条的一次性提示，连同属于哪条一起存，只在对得上的页签显示
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null)

  // 弹框期间才挂 Escape 监听
  useEffect(() => {
    if (pendingDeleteId === null) return
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setPendingDeleteId(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pendingDeleteId])

  if (presets === null) {
    return (
      <section className="pane">
        <div className="placeholder">{loadError ?? '载入画风预设中…'}</div>
      </section>
    )
  }
  const list = presets

  const active = list.find((p) => p.id === activeId) ?? list[0] ?? null
  const renameError = renamingId === null ? null : styleNameError(renameDraft, list, renamingId)
  const pendingDelete = list.find((p) => p.id === pendingDeleteId)

  function addPreset(): void {
    const preset: StylePreset = { id: newId('st'), name: nextStyleName(list), tags: '' }
    update((draft) => {
      draft.push(preset)
    })
    setActiveId(preset.id)
  }

  function commitRename(id: string): void {
    // 名称有错（空、重名）时放弃这次编辑，不落盘
    if (styleNameError(renameDraft, list, id) === null) {
      const name = renameDraft.trim()
      update((draft) => {
        const target = draft.find((p) => p.id === id)
        if (target) target.name = name
      })
    }
    setRenamingId(null)
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
    if (r.weights === 0 && r.artists === 0) {
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
    setNotice({ id: p.id, text: `已转换 ${parts.join('、')}` })
  }

  return (
    <>
      <section className="pane style-manager">
        <div className="tabs style-tabs">
          {list.map((p) => (
            <div
              key={p.id}
              className={`tab ${p.id === active?.id ? 'is-active' : ''}`}
              onClick={() => setActiveId(p.id)}
            >
              {renamingId === p.id ? (
                <input
                  className={`tab-rename-input ${renameError !== null ? 'is-invalid' : ''}`}
                  autoFocus
                  value={renameDraft}
                  title={renameError ?? ''}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={() => commitRename(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && renameError === null) commitRename(p.id)
                    if (e.key === 'Escape') setRenamingId(null)
                  }}
                />
              ) : (
                <span
                  className="tab-name"
                  title="双击重命名"
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    setRenamingId(p.id)
                    setRenameDraft(p.name)
                  }}
                >
                  {p.name}
                </span>
              )}
              {p.tags.trim() === '' && <span className="tab-empty-mark">空</span>}
              <button
                type="button"
                className="tab-close"
                title="删除这个画风"
                onClick={(e) => {
                  e.stopPropagation()
                  // 空预设没有工作可丢，弹确认只是摩擦，直接删
                  if (p.tags.trim() !== '') setPendingDeleteId(p.id)
                  else removePreset(p.id)
                }}
              >
                ×
              </button>
            </div>
          ))}
          <button type="button" className="tab-add" title="新建画风" onClick={addPreset}>
            +
          </button>
        </div>

        {active === null && <div className="style-empty">还没有画风预设，点上面的 + 新建一条</div>}

        {active !== null && (
          <>
            <div className="prompt-toolbar">
              <button
                type="button"
                title="把 {x} [x] (x:1.2) 这类老写法转成 NAI 的 1.05::x:: 格式，并把 @xxx 换成 artist:xxx"
                onClick={() => normalizePreset(active)}
              >
                规范化权重与 @
              </button>
              <button type="button" title="把当前画风复制成一个新页签" onClick={() => duplicatePreset(active)}>
                生成副本
              </button>
              <span className="prompt-toolbar-hint">双击页签改名</span>
              {notice?.id === active.id && (
                <span className="prompt-toolbar-notice" role="status">
                  {notice.text}
                </span>
              )}
              <span className="header-spacer" />
              <span className="pane-budget">约 {estimateT5Tokens(active.tags)} token</span>
            </div>
            {/* key 带 id：切页签时换掉 CodeMirror 实例与撤销栈，否则 Ctrl+Z 会串到别的预设 */}
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
      </section>

      {pendingDelete !== undefined && (
        <div className="dialog-backdrop">
          <div className="dialog" role="dialog">
            <div className="dialog-title">删除画风「{pendingDelete.name}」？</div>
            <div className="dialog-body">
              <p>{previewOf(pendingDelete.tags)}</p>
              <p>删除后指令区里选着它的话会退回「不覆盖」。</p>
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
