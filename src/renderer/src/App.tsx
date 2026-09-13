import { useEffect, useMemo, useRef, useState } from 'react'
import { CHARACTER_FIELDS, MAIN_FIELDS, orderSpecs } from '@shared/fields'
import PromptPane from './components/PromptPane'
import SettingsDrawer from './components/SettingsDrawer'
import { useConfig } from './state/config'
import { useTagdb } from './state/tagdb'
import { initWorkspacePersistence, useWorkspace } from './state/workspace'

export default function App(): JSX.Element {
  const [version, setVersion] = useState('')
  const workspace = useWorkspace((s) => s.workspace)
  const workspaceLoadError = useWorkspace((s) => s.loadError)
  const workspaceSaveError = useWorkspace((s) => s.saveError)
  const dismissWorkspaceSaveError = useWorkspace((s) => s.dismissSaveError)
  const loadWorkspace = useWorkspace((s) => s.load)
  const updateWorkspace = useWorkspace((s) => s.update)
  const config = useConfig((s) => s.config)
  const configLoaded = useConfig((s) => s.loaded)
  const configLoadError = useConfig((s) => s.loadError)
  const loadConfig = useConfig((s) => s.load)
  const configExists = useConfig((s) => s.configExists)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const tagdbStatus = useTagdb((s) => s.status)
  const initTagdb = useTagdb((s) => s.init)

  useEffect(() => {
    void window.api.appVersion().then(setVersion)
  }, [])

  // init() 里既主动问一次当前状态，又订阅后续广播——广播可能在这个组件
  // 挂载之前就发出去了，只订阅会错过那第一条（见 useTagdb 的 JSDoc）
  useEffect(() => initTagdb(), [initTagdb])

  useEffect(() => {
    void loadConfig()
    void loadWorkspace()
  }, [loadConfig, loadWorkspace])

  useEffect(() => initWorkspacePersistence(), [])

  /**
   * 从没保存过设置时，启动后自动弹设置抽屉（规格 §14.3）。
   *
   * 判据是 config.json 在不在，不是「配置等于默认值」。firstPromptDone 让这件事
   * 一辈子只发生一次：不加的话，用户手动关掉抽屉后任何一次 configExists 仍为
   * false 的重渲染都可能把它再弹出来，变成关不掉。
   */
  const firstPromptDone = useRef(false)
  useEffect(() => {
    if (!configLoaded || configExists || firstPromptDone.current) return
    firstPromptDone.current = true
    setSettingsOpen(true)
  }, [configLoaded, configExists])

  // 必须 memo：PromptEditor 以字段集引用作为重建依据，每次渲染换新数组会让
  // 编辑器不停重建、光标跳回开头。顺序串变了才换引用。
  const mainSpecs = useMemo(() => orderSpecs(MAIN_FIELDS, config.promptOrder), [config.promptOrder])
  const charSpecs = useMemo(
    () => orderSpecs(CHARACTER_FIELDS, config.naiCharPromptOrder),
    [config.naiCharPromptOrder],
  )

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-title">llm-nai-toolbox</span>
        {version !== '' && <span className="app-version">v{version}</span>}
        <span className="header-spacer" />
        <button type="button" className="header-button" onClick={() => setSettingsOpen(true)}>
          设置
        </button>
      </header>

      {tagdbStatus !== null && tagdbStatus.state !== 'ready' && (
        <div
          className={tagdbStatus.state === 'loading' ? 'tagdb-bar' : 'tagdb-bar tagdb-bar-warn'}
          role="status"
        >
          {tagdbStatus.detail}
        </div>
      )}

      {configLoadError !== null && (
        <div className="banner-error" role="alert">
          {configLoadError}（已按默认配置运行）
        </div>
      )}
      {workspaceLoadError !== null && (
        <div className="banner-error" role="alert">
          {workspaceLoadError}
        </div>
      )}
      {workspaceSaveError !== null && (
        <div className="banner-error" role="alert">
          {workspaceSaveError}
          <button type="button" onClick={dismissWorkspaceSaveError}>
            知道了
          </button>
        </div>
      )}

      <main className="workarea">
        {/* 配置读不回来时照样放出界面（按默认配置，顶部已写明）；
            工作区读不回来时停在载入中，顶部同样写明原因 */}
        {workspace !== null && (configLoaded || configLoadError !== null) ? (
          <PromptPane
            workspace={workspace}
            mainSpecs={mainSpecs}
            charSpecs={charSpecs}
            maxCharacters={config.naiMaxCharacters}
            update={updateWorkspace}
          />
        ) : (
          <div className="placeholder">载入中…</div>
        )}
      </main>

      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
