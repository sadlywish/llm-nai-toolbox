import { useEffect, useMemo, useRef, useState } from 'react'
import { CHARACTER_FIELDS, MAIN_FIELDS, orderSpecs } from '@shared/fields'
import GenDialog from './components/GenDialog'
import GenRunDialogs from './components/GenRunDialogs'
import HistoryRail from './components/HistoryRail'
import LlmConsole from './components/LlmConsole'
import LlmLogDrawer from './components/LlmLogDrawer'
import MagicBook from './components/MagicBook'
import NaiUsageBar from './components/NaiUsageBar'
import PromptPane from './components/PromptPane'
import SettingsPage from './components/SettingsPage'
import StyleManager from './components/StyleManager'
import Toolbar from './components/Toolbar'
import WikiRail from './components/WikiRail'
import { useConfig } from './state/config'
import { initGenSubscriptions, useGen } from './state/gen'
import { initLlmEvents } from './state/llm'
import { initStylesPersistence, useStyles } from './state/styles'
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
  const hasNaiToken = useConfig((s) => s.hasNaiToken)
  const tagdbStatus = useTagdb((s) => s.status)
  const initTagdb = useTagdb((s) => s.init)
  const loadStyles = useStyles((s) => s.load)
  const presets = useStyles((s) => s.presets)
  // 顶栏的视图切换。不持久化：每次启动回到工作台（没保存过设置时回到设置，见下）
  const [view, setView] = useState<'workbench' | 'styles' | 'magicbook' | 'settings'>('workbench')
  // 设置页有没保存的修改时，「设置」标签挂黄点——切去别的标签也看得见
  const [settingsDirty, setSettingsDirty] = useState(false)

  useEffect(() => {
    void window.api.appVersion().then(setVersion)
  }, [])

  // init() 里既主动问一次当前状态，又订阅后续广播——广播可能在这个组件
  // 挂载之前就发出去了，只订阅会错过那第一条（见 useTagdb 的 JSDoc）
  useEffect(() => initTagdb(), [initTagdb])

  useEffect(() => {
    void loadConfig()
    void loadWorkspace()
    void loadStyles()
  }, [loadConfig, loadWorkspace, loadStyles])

  useEffect(() => initWorkspacePersistence(), [])
  useEffect(() => initStylesPersistence(), [])
  // 日志与一轮的结束都经 llm:event 推来；订阅挂在 App 上，切到画风维护视图时照样收
  useEffect(() => initLlmEvents(), [])
  // 出图进度、单张结果、seed 回填都经事件推来；挂在 App 上，切到画风维护视图时照样收
  useEffect(() => initGenSubscriptions(), [])

  /**
   * 从没保存过设置时，启动后自动切到设置标签（规格 §14.3）。
   *
   * 判据是 config.json 在不在，不是「配置等于默认值」。firstPromptDone 让这件事
   * 一辈子只发生一次：不加的话，用户切去工作台后任何一次 configExists 仍为
   * false 的重渲染都可能把他拽回设置页，变成走不开。
   */
  const firstPromptDone = useRef(false)
  useEffect(() => {
    if (!configLoaded || configExists || firstPromptDone.current) return
    firstPromptDone.current = true
    setView('settings')
  }, [configLoaded, configExists])

  // 必须 memo：PromptEditor 以字段集引用作为重建依据，每次渲染换新数组会让
  // 编辑器不停重建、光标跳回开头。顺序串变了才换引用。
  const mainSpecs = useMemo(() => orderSpecs(MAIN_FIELDS, config.promptOrder), [config.promptOrder])
  const charSpecs = useMemo(
    () => orderSpecs(CHARACTER_FIELDS, config.naiCharPromptOrder),
    [config.naiCharPromptOrder],
  )

  // 配置读不回来时照样放出工作台（按默认配置，顶部已写明）；工作区读不回来时停在载入中，顶部同样写明原因
  const workbench = view === 'workbench' && workspace !== null && (configLoaded || configLoadError !== null) ? workspace : null

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-title">llm-nai-toolbox</span>
        {version !== '' && <span className="app-version">v{version}</span>}
        <div className="view-switch" role="tablist">
          <button type="button" role="tab" className={view === 'workbench' ? 'is-on' : ''} onClick={() => setView('workbench')}>
            工作台
          </button>
          <button type="button" role="tab" className={view === 'styles' ? 'is-on' : ''} onClick={() => setView('styles')}>
            画风维护
          </button>
          <button type="button" role="tab" className={view === 'magicbook' ? 'is-on' : ''} onClick={() => setView('magicbook')}>
            魔法书
          </button>
          <button type="button" role="tab" className={view === 'settings' ? 'is-on' : ''} onClick={() => setView('settings')}>
            设置
            {settingsDirty && (
              <span className="tab-dirty" title="有未保存的修改">
                ●
              </span>
            )}
          </button>
        </div>
        <NaiUsageBar hasNaiToken={hasNaiToken} percentPerImage={config.naiUsagePercentPerImage} />
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

      {workbench !== null && (
        <Toolbar />
      )}

      {view === 'styles' && (
        <main className="workarea">
          <StyleManager onOpenWorkbench={() => setView('workbench')} />
        </main>
      )}
      {view === 'magicbook' && <MagicBook />}
      {view === 'workbench' && (
        // 版面 A：左历史竖栏 ｜ 中间一列 ｜ 右 WIKI 竖栏（可整体收起）
        <div className="body">
          {workbench !== null && <HistoryRail />}
          <div className="center">
            {/* 日志抽屉的遮罩只盖这一块：工作区。指令区不被盖住 */}
            <div className="stage">
              <main className="workarea">
                {workbench !== null ? (
                  <PromptPane
                    workspace={workbench}
                    mainSpecs={mainSpecs}
                    charSpecs={charSpecs}
                    maxCharacters={config.naiMaxCharacters}
                    update={updateWorkspace}
                  />
                ) : (
                  <div className="placeholder">载入中…</div>
                )}
              </main>
              {workbench !== null && <LlmLogDrawer />}
            </div>
            {/* 指令区固定在中间一列底部，不随工作区滚动 */}
            {workbench !== null && (
              <LlmConsole
                workspace={workbench}
                config={config}
                presets={presets}
                mainSpecs={mainSpecs}
                charSpecs={charSpecs}
                update={updateWorkspace}
                onOpenStyles={() => setView('styles')}
              />
            )}
          </div>
          {workbench !== null && <WikiRail />}
        </div>
      )}

      {/* 常驻挂载、不在设置标签时只隐藏：切走标签草稿与分组展开状态都得留着 */}
      <SettingsPage active={view === 'settings'} onDirtyChange={setSettingsDirty} />

      {/* 出图弹窗与暂停/中止弹框是全局浮层：切到画风维护、设置视图照样弹 */}
      <GenDialog mainSpecs={mainSpecs} charSpecs={charSpecs} update={updateWorkspace} />
      <GenRunDialogs
        onOpenSettings={() => {
          // 出图弹窗是盖住整个窗口的浮层，不关掉它就看不见设置页
          useGen.getState().closeDialog()
          setView('settings')
        }}
      />
    </div>
  )
}
