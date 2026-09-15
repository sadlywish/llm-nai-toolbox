import { useEffect, useRef, useState } from 'react'

interface Props {
  label: string
  /** 悬停提示：写明复制的是哪一段 */
  title: string
  /** 点击那一刻才取文字，拿到的总是最新内容 */
  getText: () => string
  disabled: boolean
}

/** 「已复制 ✓」停留的时长 */
export const COPIED_MS = 1500

/**
 * 复制到剪贴板的小按钮（界面稿 2026-09-16-copy-prompt-mockup.html 位置 B）。
 * 写剪贴板走主进程，与魔法书「复制」同一条通道；点完变绿「已复制 ✓」，1.5 秒后恢复，不弹窗。
 */
export default function CopyButton({ label, title, getText, disabled }: Props): JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )

  function copy(): void {
    void window.api.writeClipboardText(getText()).then(() => {
      setCopied(true)
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        timer.current = null
        setCopied(false)
      }, COPIED_MS)
    })
  }

  return (
    <button type="button" className={`btn btn-sm copy-btn${copied ? ' is-copied' : ''}`} title={title} disabled={disabled} onClick={copy}>
      {copied ? '已复制 ✓' : label}
    </button>
  )
}
