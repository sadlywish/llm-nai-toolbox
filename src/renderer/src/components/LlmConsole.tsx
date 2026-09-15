import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { applyFill } from '@shared/applyFill'
import type { ApiType, AppConfig } from '@shared/config'
import { buildRunInput, clearStalePreset, currentPresetOf, presetSelectionStale } from '@shared/consoleRun'
import type { FieldSpec } from '@shared/fields'
import { MULTI_CHARACTER_MODES, type MultiCharacterMode } from '@shared/llm'
import type { StylePreset } from '@shared/styles'
import type { ConsoleOptions, StyleMode, Workspace } from '@shared/workspace'
import { useGen } from '../state/gen'
import { statusText, statusTone, useLlm } from '../state/llm'
import { useWorkspace } from '../state/workspace'

interface Props {
  workspace: Workspace
  config: AppConfig
  /** null = 画风预设还没载入 */
  presets: StylePreset[] | null
  /** 按 promptOrder 排好的字段集：「回填后自动生成」的 token 检查用 */
  mainSpecs: readonly FieldSpec[]
  charSpecs: readonly FieldSpec[]
  update: (fn: (draft: Workspace) => void) => void
  /** 「选择预设…」：切到画风维护，在那里选预设画风 */
  onOpenStyles: () => void
}

const API_LABELS: Record<ApiType, string> = { claude: 'Claude', openai: 'OpenAI 兼容' }

const MULTI_LABELS: Record<MultiCharacterMode, string> = {
  off: '关闭',
  auto: '位置由模型安排',
  coords: '手动指定坐标',
}

const STYLE_MODES: readonly StyleMode[] = ['none', 'preset', 'current']

/**
 * 指令区，固定在窗口底部。日志在 LlmLogDrawer 里，从这里的顶边向上展开。
 * 界面稿：docs/superpowers/specs/2026-09-14-llm-console-drawer-mockup.html（第 4 版；控件与文案同第 3 版）。
 * 指令区的输入与开关都存在工作区里（workspace.console），随工作区保存。
 */
export default function LlmConsole({ workspace, config, presets, mainSpecs, charSpecs, update, onOpenStyles }: Props): JSX.Element {
  const phase = useLlm((s) => s.phase)
  const hasLog = useLlm((s) => s.phase.kind !== 'idle' || s.lines.length > 0)
  const logOpen = useLlm((s) => s.logOpen)
  const run = useLlm((s) => s.run)
  const abort = useLlm((s) => s.abort)
  const openLog = useLlm((s) => s.openLog)

  const opts = workspace.console
  const running = phase.kind === 'running'
  const currentPreset = useMemo(() => currentPresetOf(opts, presets ?? []), [opts, presets])
  const tone = statusTone(phase)
  const status = statusText(phase)

  // 当前预设画风被删掉或清空时，预设变「未选择」、预设档退回「不覆盖」。预设还没载入时不判断，免得启动时误清。
  // 挂在指令区而不是画风维护：在画风维护里清空标签再重填是常事，切回工作台时才结算
  useEffect(() => {
    if (presets !== null && presetSelectionStale(opts, presets)) {
      update((ws) => clearStalePreset(ws.console, presets))
    }
  }, [presets, opts, update])

  /**
   * 指令框：光标在里面时按内容撑高，好看全整段指令；不在时回到 CSS 的固定 4 行。
   * 是否展开以 document.activeElement 为准：发送后框被禁用，Chromium 不一定补发 blur，
   * 光靠 focused 状态会让它在运行中一直撑着。focused 只用来触发重算。
   */
  const askRef = useRef<HTMLTextAreaElement>(null)
  const [focused, setFocused] = useState(false)
  useLayoutEffect(() => {
    const el = askRef.current
    if (el === null) return
    el.style.height = ''
    if (running || document.activeElement !== el) return
    const min = el.offsetHeight
    // 先压到 0 再量 scrollHeight，量到的才是内容本身的高度；再加回上下边框
    el.style.height = '0px'
    const needed = el.scrollHeight + (el.offsetHeight - el.clientHeight)
    el.style.height = `${Math.max(min, needed)}px`
  }, [focused, running, opts.instruction])

  function setOption<K extends keyof ConsoleOptions>(key: K, value: ConsoleOptions[K]): void {
    update((ws) => {
      ws.console[key] = value
    })
  }

  function send(): void {
    if (running) return
    // update 是 store 的稳定引用：这一轮跑完时即使切到了画风维护视图，回填照样写进工作区
    void run(buildRunInput(workspace, presets ?? []), (fill) => {
      update((ws) => applyFill(ws, fill))
      // 回填后自动生成：用回填之后的工作区（update 同步写 store），跑图次数照工具栏
      const ws = useWorkspace.getState().workspace
      if (ws !== null && ws.console.autoGenerate) void useGen.getState().generate(ws, mainSpecs, charSpecs)
    })
  }

  return (
    <section className="llm-dock">
      <div className="pane-bar">
        <span>LLM</span>
        {status !== '' && (
          <span className={`llm-status${tone === null ? '' : ` state-${tone}`}`}>
            {running && <span className="spin" />}
            {status}
          </span>
        )}
        {hasLog && !logOpen && (
          <button type="button" className="link-button" onClick={openLog}>
            查看日志
          </button>
        )}
        {running && (
          <button type="button" className="btn btn-danger btn-sm" onClick={abort}>
            中止
          </button>
        )}
        <span className="grow" />
        <span>
          {API_LABELS[config.apiType]} · {config.model}
        </span>
      </div>

      <div className="ask2">
        <textarea
          ref={askRef}
          value={opts.instruction}
          disabled={running}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => setOption('instruction', e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              send()
            }
          }}
        />
        <div className="opts">
          <label>
            多角色
            <select
              value={opts.multiCharacter}
              disabled={running}
              onChange={(e) => {
                const mode = MULTI_CHARACTER_MODES.find((m) => m === e.target.value)
                if (mode !== undefined) setOption('multiCharacter', mode)
              }}
            >
              {MULTI_CHARACTER_MODES.map((m) => (
                <option key={m} value={m}>
                  {MULTI_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={opts.editExisting}
              disabled={running}
              onChange={(e) => setOption('editExisting', e.target.checked)}
            />
            在现有内容上修改
          </label>
          <label>
            <input
              type="checkbox"
              checked={opts.transparent}
              disabled={running}
              onChange={(e) => setOption('transparent', e.target.checked)}
            />
            透明背景
          </label>
          <label>
            画风
            <select
              value={opts.styleMode}
              disabled={running}
              onChange={(e) => {
                const mode = STYLE_MODES.find((m) => m === e.target.value)
                if (mode !== undefined) setOption('styleMode', mode)
              }}
            >
              <option value="none">不覆盖</option>
              <option value="preset" disabled={currentPreset === null}>
                {currentPreset === null ? '用预设画风覆盖（未选择预设）' : '用预设画风覆盖'}
              </option>
              <option value="current">用当前 artist 块覆盖</option>
            </select>
          </label>
          {/* 预设在画风维护里选，这里只显示是哪条；档位不是预设档时名称变灰（界面稿 2026-09-15-style-list-mockup.html 第一节） */}
          <span className="preset-pick">
            预设
            {currentPreset === null ? (
              <span className="preset-name is-none">未选择</span>
            ) : (
              <span className={`preset-name${opts.styleMode === 'preset' ? '' : ' is-dim'}`} title={currentPreset.tags}>
                <span className="style-dot is-on" />
                <span className="preset-name-text">{currentPreset.name}</span>
              </span>
            )}
            <button type="button" className="btn btn-sm" disabled={running} onClick={onOpenStyles}>
              选择预设…
            </button>
          </span>
          <label>
            <input
              type="checkbox"
              checked={opts.autoGenerate}
              disabled={running}
              onChange={(e) => setOption('autoGenerate', e.target.checked)}
            />
            回填后自动生成
          </label>
          <span className="grow" />
          <span className="hint">Ctrl+Enter 发送</span>
          <button type="button" className="btn btn-primary" disabled={running} onClick={send}>
            发送
          </button>
        </div>
      </div>
    </section>
  )
}
