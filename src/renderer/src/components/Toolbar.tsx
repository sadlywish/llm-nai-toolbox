import type { RunProgress } from '@shared/gen'
import { useGen } from '../state/gen'
import { useWiki } from '../state/wiki'

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

/**
 * 工具栏：状态、429 暂停时的「继续」、红字错误。贯穿全宽。
 * 跑图次数与「生成 / 取消」在参数区最上面（GenerateBar）。
 */
export default function Toolbar(): JSX.Element {
  const progress = useGen((s) => s.progress)
  const resume = useGen((s) => s.resume)
  const runError = useGen((s) => s.runError)
  const dismissRunError = useGen((s) => s.dismissRunError)
  const wikiCollapsed = useWiki((s) => s.collapsed)
  const toggleWiki = useWiki((s) => s.toggleCollapsed)

  return (
    <div className="toolbar">
      {/* 429 暂停弹框可以关掉（关掉等于「稍后再说」），关掉后队列仍暂停，工具栏上必须留一个继续入口 */}
      {progress?.status === 'paused' && (
        <button type="button" className="btn btn-sm" onClick={() => void resume()}>
          继续
        </button>
      )}

      <span className="toolbar-progress">{statusText(progress)}</span>

      {runError !== null && (
        <span className="toolbar-error" role="alert">
          {runError}
          <button type="button" className="link-button" onClick={dismissRunError}>
            知道了
          </button>
        </span>
      )}

      <button
        type="button"
        className={`btn btn-sm wiki-toggle ${wikiCollapsed ? '' : 'is-on'}`}
        title={wikiCollapsed ? '展开 WIKI 栏' : '收起 WIKI 栏（跟随光标一起暂停）'}
        onClick={toggleWiki}
      >
        {wikiCollapsed ? '◂ WIKI' : 'WIKI ▸'}
      </button>
    </div>
  )
}
