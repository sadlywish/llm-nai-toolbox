import type { ClipboardEvent, CSSProperties, KeyboardEvent } from 'react'
import { flattenLineBreaks } from '../settingsDraft'

interface Props {
  value: string
  onChange: (value: string) => void
  /** 内容少时最少占几行 */
  minRows?: number
  /** 单行值（质量词、负面词、画面文字）：只折行显示，Enter 不换行，粘贴进来的换行变空格 */
  singleLine?: boolean
  className?: string
  placeholder?: string
  spellCheck?: boolean
  title?: string
}

/**
 * 按内容撑高的文本框（界面稿 2026-09-15-settings-tab-mockup.html 第四节）。
 *
 * 高度全交给 CSS 的 field-sizing: content（Chromium 123 起支持），不用 JS 量 scrollHeight：
 * 量高度要先把框压扁，外层滚动容器会跟着被夹住 scrollTop，边打字页面边跳。
 * 最少行数走 --min-rows，最高约一屏由 .auto-textarea 的 max-height 管，超出在框内滚动。
 */
export default function AutoTextarea({
  value,
  onChange,
  minRows = 1,
  singleLine = false,
  className,
  placeholder,
  spellCheck,
  title,
}: Props): JSX.Element {
  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    // 输入法选词时的 Enter 是确认候选词，不能拦（isComposing / keyCode 229）
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) e.preventDefault()
  }

  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>): void {
    const text = e.clipboardData.getData('text/plain')
    if (!/[\r\n]/.test(text)) return
    // 自己插入换过行的文本：光标停在粘贴处，也留在撤销栈里（直接改 value 会把光标甩到末尾）
    e.preventDefault()
    document.execCommand('insertText', false, flattenLineBreaks(text))
  }

  return (
    <textarea
      className={`auto-textarea ${className ?? ''}`}
      style={{ '--min-rows': minRows } as CSSProperties}
      rows={minRows}
      value={value}
      placeholder={placeholder}
      spellCheck={spellCheck}
      title={title}
      onKeyDown={singleLine ? handleKeyDown : undefined}
      onPaste={singleLine ? handlePaste : undefined}
      // 拖放等绕过 onPaste 的输入在这里兜底
      onChange={(e) => onChange(singleLine ? flattenLineBreaks(e.target.value) : e.target.value)}
    />
  )
}
