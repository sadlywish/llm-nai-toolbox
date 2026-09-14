import type { FieldSpec } from '@shared/fields'
import type { Workspace } from '@shared/workspace'
import { useGen } from '../state/gen'

interface Props {
  workspace: Workspace
  /** 按 promptOrder 排好的字段集，生成前 token 检查用 */
  mainSpecs: readonly FieldSpec[]
  charSpecs: readonly FieldSpec[]
  update: (fn: (draft: Workspace) => void) => void
}

/**
 * 参数区最上面的跑图次数 + 大「生成」按钮（界面稿 2026-09-14-generate-button-mockup 第一部分方案 B）。
 * 配色参照 WebUI 默认的 Gradio 主题：空闲时橘色主按钮；跑图中（含 429 暂停）同一位置换成灰色「取消」。
 */
export default function GenerateBar({ workspace, mainSpecs, charSpecs, update }: Props): JSX.Element {
  const progress = useGen((s) => s.progress)
  const starting = useGen((s) => s.starting)
  const generate = useGen((s) => s.generate)
  const cancel = useGen((s) => s.cancel)

  // 有进度就按进度判断；还没收到第一条进度时用 starting 补上「点了生成、进度未到」的空档，免得按钮变回「生成」被连点
  const busy = progress !== null ? progress.status === 'running' || progress.status === 'paused' : starting !== null
  // 取消后队列立刻报 cancelled，但在途那张要等它回来这一轮才真正结束（starting 那时才清）。
  // 这段时间主进程仍在途，点「生成」只会被在途保护挡回来，所以显示不可点的「取消中…」
  const stopping = progress?.status === 'cancelled' && starting !== null

  return (
    <div className="gen-cta">
      <label className="field gen-cta-runcount">
        <span>跑图次数</span>
        <input
          type="number"
          min={1}
          value={workspace.runCount}
          onChange={(e) => {
            const v = e.target.valueAsNumber
            // 非法输入（空值、负数）不落盘，保留上一个合法值
            if (Number.isNaN(v) || v < 1) return
            update((ws) => {
              ws.runCount = Math.floor(v)
            })
          }}
        />
      </label>
      {busy ? (
        <button type="button" className="big-btn is-cancel" onClick={() => void cancel()}>
          取消
        </button>
      ) : stopping ? (
        <button type="button" className="big-btn is-cancel" disabled>
          取消中…
        </button>
      ) : (
        <button type="button" className="big-btn is-generate" onClick={() => void generate(workspace, mainSpecs, charSpecs)}>
          生成
        </button>
      )}
    </div>
  )
}
