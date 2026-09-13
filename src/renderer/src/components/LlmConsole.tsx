import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { applyFill } from '@shared/applyFill'
import type { ApiType, AppConfig } from '@shared/config'
import { buildRunInput, presetSelectionStale, selectStyleMode } from '@shared/consoleRun'
import { MULTI_CHARACTER_MODES, type MultiCharacterMode } from '@shared/llm'
import { usableStyles, type StylePreset } from '@shared/styles'
import type { ConsoleOptions, StyleMode, Workspace } from '@shared/workspace'
import { statusText, statusTone, useLlm } from '../state/llm'

interface Props {
  workspace: Workspace
  config: AppConfig
  /** null = 画风预设还没载入 */
  presets: StylePreset[] | null
  update: (fn: (draft: Workspace) => void) => void
  /** 预设下拉里的「去维护画风…」 */
  onOpenStyles: () => void
}

const API_LABELS: Record<ApiType, string> = { claude: 'Claude', openai: 'OpenAI 兼容' }

const MULTI_LABELS: Record<MultiCharacterMode, string> = {
  off: '关闭',
  auto: '位置由模型安排',
  coords: '手动指定坐标',
}

const STYLE_MODES: readonly StyleMode[] = ['none', 'preset', 'current']

/** 预设下拉末尾「去维护画风…」的取值；预设 id 由 newId 生成，不会撞上 */
const OPEN_STYLES = '__open_styles__'

/**
 * 指令区，固定在窗口底部。日志在 LlmLogDrawer 里，从这里的顶边向上展开。
 * 界面稿：docs/superpowers/specs/2026-09-14-llm-console-drawer-mockup.html（第 4 版；控件与文案同第 3 版）。
 * 指令区的输入与开关都存在工作区里（workspace.console），随工作区保存。
 */
export default function LlmConsole({ workspace, config, presets, update, onOpenStyles }: Props): JSX.Element {
  const phase = useLlm((s) => s.phase)
  const hasLog = useLlm((s) => s.phase.kind !== 'idle' || s.lines.length > 0)
  const logOpen = useLlm((s) => s.logOpen)
  const run = useLlm((s) => s.run)
  const abort = useLlm((s) => s.abort)
  const openLog = useLlm((s) => s.openLog)

  const opts = workspace.console
  const running = phase.kind === 'running'
  const usable = useMemo(() => usableStyles(presets ?? []), [presets])
  const tone = statusTone(phase)
  const status = statusText(phase)

  // 选着的预设被删掉或清空时，画风退回「不覆盖」。预设还没载入时不判断，免得启动时误退
  useEffect(() => {
    if (presets !== null && presetSelectionStale(opts, presets)) {
      update((ws) => {
        ws.console.styleMode = 'none'
      })
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
    void run(buildRunInput(workspace, presets ?? []), (fill) => update((ws) => applyFill(ws, fill)))
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
                if (mode !== undefined) update((ws) => selectStyleMode(ws.console, mode, presets ?? []))
              }}
            >
              <option value="none">不覆盖</option>
              <option value="preset" disabled={usable.length === 0}>
                {usable.length === 0 ? '用选用的预设覆盖（还没有预设）' : '用选用的预设覆盖'}
              </option>
              <option value="current">用当前 artist 块覆盖</option>
            </select>
          </label>
          {opts.styleMode === 'preset' && (
            <label>
              预设
              <select
                value={opts.presetId}
                disabled={running}
                onChange={(e) => {
                  if (e.target.value === OPEN_STYLES) onOpenStyles()
                  else setOption('presetId', e.target.value)
                }}
              >
                {usable.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
                <option disabled>──────────</option>
                <option value={OPEN_STYLES}>去维护画风…</option>
              </select>
            </label>
          )}
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
