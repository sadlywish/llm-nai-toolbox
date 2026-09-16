// 指令区：固定在工作台底部（界面稿第二节方案 A 的 .m-dock）。
//
// 五个开关一个不少，与桌面端指令区逐条对应、语义完全一致（规格 §6 那张表）：
// 多角色 / 在现有内容上修改 / 透明背景 / 画风 / 回填后自动生成。
// 平时收在指令框上方的一行摘要里，点开是完整面板——手机屏幕放不下六行控件加一个输入框。
// 开关值存在手机本地那份工作区的 console 里，跟电脑上的指令区互不影响（规格 §4）。
import { useEffect, useState } from 'react'
import { clearStalePreset, currentPresetOf, presetSelectionStale } from '@shared/consoleRun'
import { MULTI_CHARACTER_MODES } from '@shared/llm'
import type { StylePreset } from '@shared/styles'
import type { ConsoleOptions, StyleMode, Workspace } from '@shared/workspace'
import { MULTI_LABELS, STYLE_MODE_LABELS } from '@renderer/llmLabels'
import { optionsSummary } from '../optionsSummary'
import { useKeyboardInset } from '../useKeyboardInset'

const STYLE_MODES: readonly StyleMode[] = ['none', 'preset', 'current']

interface Props {
  workspace: Workspace
  /** 共用的画风列表（`GET /api/styles`）；null = 还没拉到 */
  presets: StylePreset[] | null
  running: boolean
  /** 发过至少一轮，给一个回日志页的入口 */
  hasLog: boolean
  onChange: (update: (w: Workspace) => Workspace) => void
  onSend: () => void
  onOpenLog: () => void
  /** 「去画风页换」：跳到画风标签（预设是电脑与手机共用的那一条） */
  onOpenStyles: () => void
  /** 出图。Task 15 接上之前是 undefined，生成按钮就是灰的 */
  onGenerate?: () => void
}

/** 一行一个开关。开关画成「开 / 关」按钮而不是 checkbox：手指的落点大一圈，状态也看得更清 */
function ToggleRow({
  label,
  on,
  disabled,
  hint,
  onToggle,
}: {
  label: string
  on: boolean
  disabled: boolean
  hint?: string
  onToggle: (v: boolean) => void
}): JSX.Element {
  return (
    <div className="opt-row">
      <span className="opt-label">
        {label}
        {hint !== undefined && <span className="field-hint">{hint}</span>}
      </span>
      <button type="button" className={on ? 'btn sm on' : 'btn sm'} aria-pressed={on} disabled={disabled} onClick={() => onToggle(!on)}>
        {on ? '开' : '关'}
      </button>
    </div>
  )
}

export default function Console({
  workspace,
  presets,
  running,
  hasLog,
  onChange,
  onSend,
  onOpenLog,
  onOpenStyles,
  onGenerate,
}: Props): JSX.Element {
  const [optionsOpen, setOptionsOpen] = useState(false)
  const inset = useKeyboardInset()

  const opts = workspace.console
  const preset = currentPresetOf(opts, presets ?? [])

  // 当前预设被电脑那头删掉或清空时，预设变「未选择」、预设档退回「不覆盖」（同桌面端指令区）。
  // 画风列表还没拉到时不判断，免得刚进页面就把选择误清掉
  useEffect(() => {
    if (presets === null || !presetSelectionStale(opts, presets)) return
    onChange((w) => {
      const nextOpts = { ...w.console }
      clearStalePreset(nextOpts, presets)
      return { ...w, console: nextOpts }
    })
  }, [presets, opts, onChange])

  function setOption<K extends keyof ConsoleOptions>(key: K, value: ConsoleOptions[K]): void {
    onChange((w) => ({ ...w, console: { ...w.console, [key]: value } }))
  }

  const summary = optionsSummary(opts, preset?.name ?? '')

  return (
    // 软键盘顶上来时把这一条让到键盘上面：iOS 不缩布局视口，不让的话指令框就在键盘底下
    <div className="dock" style={{ marginBottom: inset > 0 ? inset : undefined }}>
      <div className="dock-sum">
        <button type="button" className="sum-text" onClick={() => setOptionsOpen(true)}>
          {summary}
        </button>
        {hasLog && (
          <button type="button" className="sum-link" onClick={onOpenLog}>
            日志
          </button>
        )}
        <button type="button" className="sum-link" onClick={() => setOptionsOpen(true)}>
          选项 ▾
        </button>
      </div>

      <textarea
        className="ask"
        value={opts.instruction}
        disabled={running}
        placeholder="想画什么，直接说"
        spellCheck={false}
        onChange={(e) => setOption('instruction', e.target.value)}
      />

      <div className="dock-row">
        <button type="button" className="btn pri" disabled={running || opts.instruction.trim() === ''} onClick={onSend}>
          {running ? '运行中…' : '发送'}
        </button>
        <span className="grow" />
        <label className="run-count">
          跑图
          <input
            type="number"
            inputMode="numeric"
            min={1}
            value={workspace.runCount}
            onChange={(e) => {
              const v = e.target.valueAsNumber
              // 输入过程中的空值会先经过 NaN，不接住会把 NaN 写进工作区
              if (Number.isNaN(v) || v < 1) return
              onChange((w) => ({ ...w, runCount: Math.floor(v) }))
            }}
          />
        </label>
        <button type="button" className="btn gen" disabled={onGenerate === undefined} onClick={onGenerate}>
          生成
        </button>
      </div>

      {optionsOpen && (
        // 点遮罩收起。用 target === currentTarget 而不是给面板加 stopPropagation（同 EditSheet）
        <div
          className="sheet-mask"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOptionsOpen(false)
          }}
        >
          <div className="sheet">
            <div className="sheet-head">
              <b>LLM 选项</b>
              <span className="grow" />
              <button type="button" className="btn sm" onClick={() => setOptionsOpen(false)}>
                收起 ▴
              </button>
            </div>

            {running && <p className="hint">这一轮正在跑，选项要等它结束才能改。</p>}

            <label className="field">
              <span>多角色</span>
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

            <ToggleRow
              label="在现有内容上修改"
              on={opts.editExisting}
              disabled={running}
              hint="把手机这一份当「现有参数」发过去"
              onToggle={(v) => setOption('editExisting', v)}
            />
            <ToggleRow label="透明背景" on={opts.transparent} disabled={running} onToggle={(v) => setOption('transparent', v)} />

            <label className="field">
              <span>画风</span>
              <select
                value={opts.styleMode}
                disabled={running}
                onChange={(e) => {
                  const mode = STYLE_MODES.find((m) => m === e.target.value)
                  if (mode !== undefined) setOption('styleMode', mode)
                }}
              >
                {STYLE_MODES.map((m) => (
                  <option key={m} value={m} disabled={m === 'preset' && preset === null}>
                    {m === 'preset' && preset === null ? `${STYLE_MODE_LABELS.preset}（未选择预设）` : STYLE_MODE_LABELS[m]}
                  </option>
                ))}
              </select>
            </label>

            {/* 预设在画风页里选，这里只显示是哪条——它是电脑与手机共用的那一条（规格 §4「画风共用」） */}
            <div className="opt-row">
              <span className="preset-line">
                预设 {preset === null ? <span className="dim">未选择</span> : <span className="ok">● {preset.name}</span>}
              </span>
              <button type="button" className="btn sm" disabled={running} onClick={onOpenStyles}>
                去画风页换
              </button>
            </div>

            <ToggleRow
              label="回填后自动生成"
              on={opts.autoGenerate}
              disabled={running}
              hint={onGenerate === undefined ? '出图还没接上，这一档先只记着' : '回填成功后直接按跑图次数出图'}
              onToggle={(v) => setOption('autoGenerate', v)}
            />
          </div>
        </div>
      )}
    </div>
  )
}
