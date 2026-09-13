import { useLayoutEffect, useRef } from 'react'
import { useLlm, type ConsoleLine } from '../state/llm'

function lineClass(line: ConsoleLine): string {
  if (line.ok === true) return 'ln ok'
  if (line.level === 'W') return 'ln w'
  if (line.level === 'E') return 'ln e'
  return 'ln'
}

/**
 * LLM 日志抽屉：贴着底部指令区的顶边向上展开，遮罩盖住指令区上方。
 * 界面稿：docs/superpowers/specs/2026-09-14-llm-console-drawer-mockup.html（第 4 版）。
 *
 * 开合由 useLlm.logOpen 决定：发送时打开、回填成功后收起；点遮罩或 × 只是收起，这一轮照常跑。
 */
export default function LlmLogDrawer(): JSX.Element | null {
  const open = useLlm((s) => s.logOpen)
  const lines = useLlm((s) => s.lines)
  const running = useLlm((s) => s.phase.kind === 'running')
  const clear = useLlm((s) => s.clear)
  const close = useLlm((s) => s.closeLog)

  const logRef = useRef<HTMLDivElement>(null)
  // 日志贴着底部时跟着新行滚；往上翻着看的时候不打扰。每次打开、每次新发一轮都从底部看起
  const stickToBottom = useRef(true)
  // 同设置抽屉：按下与松开都在遮罩上才收起，免得在日志里拖选文字、松手落到遮罩上时被误关
  const downOnBackdrop = useRef(false)

  useLayoutEffect(() => {
    if (open) stickToBottom.current = true
  }, [open, running])

  useLayoutEffect(() => {
    const el = logRef.current
    if (el !== null && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [lines, open])

  if (!open) return null

  return (
    <div
      className="log-backdrop"
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) close()
      }}
    >
      <aside className="log-drawer">
        <div className="log-drawer-head">
          <span>LLM 日志</span>
          <span className="grow" />
          {!running && (
            <button type="button" className="btn btn-sm" onClick={clear}>
              清空
            </button>
          )}
          <button type="button" className="drawer-close" title="收起" onClick={close}>
            ×
          </button>
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
      </aside>
    </div>
  )
}
