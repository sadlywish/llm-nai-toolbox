import type { FieldSpec } from '@shared/fields'
import type { RunProgress } from '@shared/gen'
import type { Workspace } from '@shared/workspace'
import { useGen } from '../state/gen'

/** 按 status 分支的进度文案（照工具箱） */
function statusText(progress: RunProgress | null): string {
  if (!progress) return ''
  switch (progress.status) {
    case 'running':
      return `已完成 ${progress.done + progress.failed} / ${progress.total}`
    case 'paused':
      return '已暂停 · 并发冲突'
    case 'aborted':
      return '整批已中止'
    case 'cancelled':
      return '已取消'
    case 'done':
      return '完成'
    default:
      return ''
  }
}

interface Props {
  workspace: Workspace
  /** 按 promptOrder 排好的字段集，生成前 token 检查用 */
  mainSpecs: readonly FieldSpec[]
  charSpecs: readonly FieldSpec[]
  update: (fn: (draft: Workspace) => void) => void
}

/** 工具栏：跑图次数、生成、继续（暂停时）、取消、状态。照画师串工具箱，贯穿全宽 */
export default function Toolbar({ workspace, mainSpecs, charSpecs, update }: Props): JSX.Element {
  const progress = useGen((s) => s.progress)
  const generate = useGen((s) => s.generate)
  const resume = useGen((s) => s.resume)
  const cancel = useGen((s) => s.cancel)
  const runError = useGen((s) => s.runError)
  const dismissRunError = useGen((s) => s.dismissRunError)

  const busy = progress?.status === 'running' || progress?.status === 'paused'
  const paused = progress?.status === 'paused'

  return (
    <div className="toolbar">
      <label className="field toolbar-runcount">
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

      <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void generate(workspace, mainSpecs, charSpecs)}>
        生成
      </button>

      {/* 固定 seed 时点「生成」前一眼能看到：每张都会是同一个 seed */}
      {workspace.params.seedMode === 'fixed' && <span className="seed-fixed-chip">固定 seed</span>}

      {/* 429 暂停弹框可以关掉（关掉等于「稍后再说」），关掉后队列仍暂停，工具栏上必须留一个继续入口 */}
      {paused && (
        <button type="button" className="btn btn-sm" onClick={() => void resume()}>
          继续
        </button>
      )}

      <button type="button" className="btn btn-sm" disabled={!busy} onClick={() => void cancel()}>
        取消
      </button>

      <span className="toolbar-progress">{statusText(progress)}</span>

      {runError !== null && (
        <span className="toolbar-error" role="alert">
          {runError}
          <button type="button" className="link-button" onClick={dismissRunError}>
            知道了
          </button>
        </span>
      )}
    </div>
  )
}
