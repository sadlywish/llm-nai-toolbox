import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { applyFill } from '@shared/applyFill'
import type { ApiType, AppConfig } from '@shared/config'
import { buildRunInput, presetSelectionStale, selectStyleMode } from '@shared/consoleRun'
import { MULTI_CHARACTER_MODES, type MultiCharacterMode } from '@shared/llm'
import { usableStyles, type StylePreset } from '@shared/styles'
import type { ConsoleOptions, StyleMode, Workspace } from '@shared/workspace'
import { statusText, statusTone, useLlm, type ConsoleLine } from '../state/llm'

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

function lineClass(line: ConsoleLine): string {
  if (line.ok === true) return 'ln ok'
  if (line.level === 'W') return 'ln w'
  if (line.level === 'E') return 'ln e'
  return 'ln'
}

/**
 * 指令区 + 日志区。界面稿：docs/superpowers/specs/2026-09-13-llm-console-mockup.html（第 3 版）。
 * 指令区的输入与开关都存在工作区里（workspace.console），随工作区保存。
 */
export default function LlmConsole({ workspace, config, presets, update, onOpenStyles }: Props): JSX.Element {
  const phase = useLlm((s) => s.phase)
  const lines = useLlm((s) => s.lines)
  const run = useLlm((s) => s.run)
  const abort = useLlm((s) => s.abort)
  const clear = useLlm((s) => s.clear)

  const opts = workspace.console
  const running = phase.kind === 'running'
  const usable = useMemo(() => usableStyles(presets ?? []), [presets])
  const tone = statusTone(phase)

  // 选着的预设被删掉或清空时，画风退回「不覆盖」。预设还没载入时不判断，免得启动时误退
  useEffect(() => {
    if (presets !== null && presetSelectionStale(opts, presets)) {
      update((ws) => {
        ws.console.styleMode = 'none'
      })
    }
  }, [presets, opts, update])

  // 日志贴着底部时跟着新行滚；往上翻着看的时候不打扰
  const logRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  useLayoutEffect(() => {
    const el = logRef.current
    if (el !== null && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [lines])

  function setOption<K extends keyof ConsoleOptions>(key: K, value: ConsoleOptions[K]): void {
    update((ws) => {
      ws.console[key] = value
    })
  }

  function send(): void {
    if (running) return
    stickToBottom.current = true
    // update 是 store 的稳定引用：这一轮跑完时即使切到了画风维护视图，回填照样写进工作区
    void run(buildRunInput(workspace, presets ?? []), (fill) => update((ws) => applyFill(ws, fill)))
  }

  return (
    <section className="pane llm-console">
      <div className="pane-bar">
        <span>LLM</span>
        <span>
          {API_LABELS[config.apiType]} · {config.model}
        </span>
      </div>

      <div className="ask2">
        <textarea
          value={opts.instruction}
          disabled={running}
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

      {(phase.kind !== 'idle' || lines.length > 0) && (
        <div className="console">
          <div className="con-head">
            <span className={tone === null ? undefined : `state-${tone}`}>
              {running && <span className="spin" />}
              {statusText(phase)}
            </span>
            <span className="grow" />
            {running ? (
              <button type="button" className="btn btn-danger" onClick={abort}>
                中止
              </button>
            ) : (
              <button type="button" className="btn" onClick={clear}>
                清空
              </button>
            )}
          </div>
          <div
            className="log"
            ref={logRef}
            onScroll={(e) => {
              const el = e.currentTarget
              stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8
            }}
          >
            {lines.map((line) => (
              <div key={line.seq} className={lineClass(line)}>
                <span className="t">{line.time}</span> <span className="lv">[{line.level}]</span> {line.text}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
