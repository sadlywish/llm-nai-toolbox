import { useEffect, useRef, useState } from 'react'
import { parseNumberInput, settleNumberInput, type NumberRange } from '../numberInput'

interface Props {
  label?: string
  value: number
  range?: NumberRange
  step?: number
  disabled?: boolean
  hint?: string
  /** 解析得出合法数字时写回；半截输入不触发 */
  onCommit: (v: number) => void
  /** 失焦后（值已经收干净）再做的事，比如宽高对齐 64 */
  onSettled?: () => void
  /** 指令区的跑图次数用：不要 .field 那套上下排布 */
  bare?: boolean
}

/**
 * 数字输入框。**输入过程中允许是空的**——手机上改数字全靠退格，受控框把 NaN 按回原值会让
 * 一位数的框根本删不掉（用户 2026-09-17 实机反馈）。所以这里存一份文本态，
 * 只有解析得出合法数字才写进工作区，失焦时把半截文本收回成当前值。
 *
 * `type="text"` 而不是 `type="number"`：安卓上数字框的退格与输入法行为各家不一，
 * 用 inputMode 给数字键盘就够了，取值规则完全由自己掌握。
 */
export default function NumberField({ label, value, range, step, disabled = false, hint, onCommit, onSettled, bare = false }: Props): JSX.Element {
  const [text, setText] = useState(String(value))
  const editing = useRef(false)

  // 外部改了值（LLM 回填、参数写回、宽高对齐）时同步过来；正在敲的半截文本不覆盖
  useEffect(() => {
    if (!editing.current) setText(String(value))
    else if (parseNumberInput(text, range) === value) setText(String(value))
    // text 不进依赖：它变一次就同步一次会把用户正在敲的内容顶掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const input = (
    <input
      type="text"
      inputMode={step !== undefined && step < 1 ? 'decimal' : 'numeric'}
      value={text}
      disabled={disabled}
      onFocus={() => {
        editing.current = true
      }}
      onChange={(e) => {
        const raw = e.target.value
        setText(raw)
        const parsed = parseNumberInput(raw, range)
        if (parsed !== null) onCommit(parsed)
      }}
      onBlur={() => {
        editing.current = false
        const settled = settleNumberInput(text, value, range)
        setText(String(settled))
        if (settled !== value) onCommit(settled)
        onSettled?.()
      }}
    />
  )

  if (bare) return input
  return (
    <label className={`field ${disabled ? 'is-disabled' : ''}`}>
      {label !== undefined && <span>{label}</span>}
      {input}
      {hint !== undefined && <span className="field-hint">{hint}</span>}
    </label>
  )
}
