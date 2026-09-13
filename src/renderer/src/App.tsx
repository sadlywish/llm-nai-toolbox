import { useEffect, useState } from 'react'
import { MAIN_FIELDS } from '@shared/fields'
import { checkTokenLimit, totalTokens } from '@shared/blockMetrics'
import type { FieldValues } from '@shared/blockDoc'
import { tokenLimitFor } from '@renderer/prompt/t5'
import PromptEditor from './editor/PromptEditor'
import { useTagdb } from './state/tagdb'
import { initWorkspacePersistence, useWorkspace } from './state/workspace'

export default function App(): JSX.Element {
  const [version, setVersion] = useState('')
  const workspace = useWorkspace((s) => s.workspace)
  const loadWorkspace = useWorkspace((s) => s.load)
  const updateWorkspace = useWorkspace((s) => s.update)
  const tagdbStatus = useTagdb((s) => s.status)
  const initTagdb = useTagdb((s) => s.init)

  useEffect(() => {
    void window.api.appVersion().then(setVersion)
  }, [])

  // init() 里既主动问一次当前状态，又订阅后续广播——广播可能在这个组件
  // 挂载之前就发出去了，只订阅会错过那第一条（见 useTagdb 的 JSDoc）
  useEffect(() => initTagdb(), [initTagdb])

  useEffect(() => {
    void loadWorkspace()
  }, [loadWorkspace])

  useEffect(() => initWorkspacePersistence(), [])

  if (workspace === null) return <div className="app">载入中…</div>

  const model = workspace.params.model
  const onMainChange = (values: FieldValues): void =>
    updateWorkspace((ws) => {
      ws.main = values
    })

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-title">llm-nai-toolbox</span>
        {version !== '' && <span className="app-version">v{version}</span>}
      </header>

      {tagdbStatus !== null && tagdbStatus.state !== 'ready' && (
        <div
          className={tagdbStatus.state === 'loading' ? 'tagdb-bar' : 'tagdb-bar tagdb-bar-warn'}
          role="status"
        >
          {tagdbStatus.detail}
        </div>
      )}

      <main className="workarea">
        <section className="pane">
          <div className="pane-bar">
            <span className="pane-title">提示词</span>
            <span className="pane-budget">
              合计 <b>{totalTokens(workspace.main, MAIN_FIELDS)}</b> / {tokenLimitFor(model)} token
            </span>
          </div>
          <PromptEditor specs={MAIN_FIELDS} values={workspace.main} onChange={onMainChange} />
          {(() => {
            const over = checkTokenLimit(workspace.main, MAIN_FIELDS, model)
            return over === null ? null : (
              <p className="pane-warn" role="alert">
                提示词 {over.total} token 超过上限 {over.limit}，最长的是「{over.longest.name}」
                （{over.longest.tokens} token）。
              </p>
            )
          })()}
        </section>
      </main>
    </div>
  )
}
