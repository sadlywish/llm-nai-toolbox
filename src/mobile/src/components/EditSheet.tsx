// 点一行之后从底部弹出的编辑层（界面稿第二节「点某一块 → 底部弹层编辑」的 .m-sheet）。
//
// 手机上不做行内标红（没有 CodeMirror，也不该为了标红把它搬过来），问题改成输入框下面
// 一行行红字，跟着输入实时更新——写完再告诉人哪儿不对，人已经切走了。
import { useEffect, useRef, useState } from 'react'
import type { FieldInput } from '@shared/fields'
import { copyText } from '../clipboard'
import { fieldWarnings } from '../fieldWarnings'
import { useKeyboardInset } from '../useKeyboardInset'

interface Props {
  /** 弹层左上角那个名字，就是被点的那一行的徽章文字 */
  title: string
  value: string
  /** 决定查不查全角逗号，以及 enum 要不要画成选项按钮 */
  input: FieldInput
  /** input 为 'enum' 时的可选值（角色的 count：girl / boy / other） */
  options?: readonly string[]
  placeholder?: string
  /** 输入框下面那句固定说明，各处不同（坐标要解释写法，标签块要解释权重） */
  hint?: string
  onChange: (value: string) => void
  onClose: () => void
}

/** 换行一律换成空格：提示词的值始终是一行（同桌面端单行文本框的 flattenLineBreaks） */
function flattenLineBreaks(text: string): string {
  return text.replace(/\r\n|\r|\n/g, ' ')
}

export default function EditSheet({
  title,
  value,
  input,
  options,
  placeholder,
  hint,
  onChange,
  onClose,
}: Props): JSX.Element {
  const inset = useKeyboardInset()
  const area = useRef<HTMLTextAreaElement>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    // 用户是点了这一行才进来的，光标直接落进输入框，省一次点击；
    // enum 没有输入框（focus 一排按钮反而会盖住选项），不抢焦点
    if (input !== 'enum') area.current?.focus()
  }, [input])

  const warnings = fieldWarnings(value, input)

  const copy = (): void => {
    void copyText(value).then((ok) => {
      setCopied(ok)
      // 只是一句「已复制」的回执，两秒后自己退回去，不值得再放个关闭按钮
      if (ok) setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    // 点遮罩关闭。用 target === currentTarget 而不是给弹层加 stopPropagation：
    // 后者会把弹层内部所有冒泡到 document 的事件一起截掉
    <div
      className="sheet-mask"
      style={{ paddingBottom: inset > 0 ? inset : undefined }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="sheet">
        <div className="sheet-head">
          <b>{title}</b>
          <span className="grow" />
          <button type="button" className="btn sm" onClick={copy}>
            {copied ? '已复制' : '复制'}
          </button>
          <button type="button" className="btn sm pri" onClick={onClose}>
            完成
          </button>
        </div>

        {input === 'enum' ? (
          <div className="sheet-opts">
            {(options ?? []).map((opt) => (
              <button
                type="button"
                key={opt}
                className={opt === value ? 'btn on' : 'btn'}
                // 再点一次当前选项就清空：固定选项没有别的方式回到「没填」
                onClick={() => onChange(opt === value ? '' : opt)}
              >
                {opt}
              </button>
            ))}
          </div>
        ) : (
          <textarea
            ref={area}
            value={value}
            placeholder={placeholder}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => onChange(flattenLineBreaks(e.target.value))}
          />
        )}

        {warnings.map((w) => (
          // 同一个位置只会有一条问题，坐标当 key 稳定；用 message 当 key 的话，
          // 两处同样的全角逗号会撞成一个，红字少一行
          <p className="sheet-warn" key={`${w.from}-${w.to}`}>
            {w.message}
          </p>
        ))}

        {hint !== undefined && <p className="hint">{hint}</p>}
      </div>
    </div>
  )
}
