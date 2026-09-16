// LLM 日志页：发送之后看这一轮跑到哪了（界面稿第三节左边那张）。
//
// 行的样子照桌面端日志（`12:30:09 [I] search_tags 结果: …`）；顶上的状态与右上角的「中止」
// 在外壳的顶栏上，这一页只管行本身。回填成功会自动收起这一页回到工作台，所以这里不做任何回填。
import { useLayoutEffect, useRef } from 'react'
import type { LlmPhase, LogLine } from '../llmPending'

interface Props {
  phase: LlmPhase
  lines: LogLine[]
}

function lineClass(line: LogLine): string {
  if (line.ok === true) return 'ln ok'
  if (line.level === 'W') return 'ln w'
  if (line.level === 'E') return 'ln e'
  return 'ln'
}

export default function LlmLog({ phase, lines }: Props): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  // 贴着底部时跟着新行滚；往上翻着看的时候不打扰
  const stickToBottom = useRef(true)

  useLayoutEffect(() => {
    const el = box.current
    if (el !== null && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [lines])

  const running = phase.kind === 'running'

  return (
    <>
      <div
        className="log"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8
        }}
      >
        {lines.length === 0 && <p className="hint">{running ? '等电脑那头的第一行…' : '这一轮没有日志。'}</p>}
        {lines.map((line) => (
          <div key={line.seq} className={lineClass(line)}>
            <span className="t">{line.time}</span> <span className="lv">[{line.level}]</span> {line.text}
          </div>
        ))}
      </div>
      <p className="hint">回填的是手机上这一份，电脑上那份不动。</p>
    </>
  )
}
