import { useEffect, useState } from 'react'
import { useGen } from '../state/gen'

interface Props {
  /** 中止提示的「打开设置」 */
  onOpenSettings: () => void
}

/**
 * 429 暂停与整批中止两个弹框（照工具箱 RunDialogs）。由 progress.status 驱动、自动弹出；用户关掉后
 * 在同一次暂停/中止期间不再弹，但工具栏与历史条目上的「继续」「取消」一直都在。状态一旦离开
 * paused/aborted，下次再进入要重新弹，所以在这个时机把「已关闭」复位。
 */
export default function GenRunDialogs({ onOpenSettings }: Props): JSX.Element {
  const progress = useGen((s) => s.progress)
  const resume = useGen((s) => s.resume)
  const cancel = useGen((s) => s.cancel)

  const [pauseDismissed, setPauseDismissed] = useState(false)
  const [abortDismissed, setAbortDismissed] = useState(false)

  useEffect(() => {
    if (progress?.status !== 'paused') setPauseDismissed(false)
    if (progress?.status !== 'aborted') setAbortDismissed(false)
  }, [progress?.status])

  return (
    <>
      {progress?.status === 'paused' && !pauseDismissed && (
        <div className="dialog-backdrop">
          <div className="dialog">
            <button
              type="button"
              className="dialog-close"
              title="稍后再说（队列保持暂停，工具栏上随时可继续）"
              onClick={() => setPauseDismissed(true)}
            >
              ×
            </button>
            <div className="dialog-title">检测到并发冲突</div>
            <div className="dialog-body">
              <p>{progress.pauseReason}</p>
              <p>剩余 {Math.max(0, progress.total - progress.done - progress.failed)} 个任务待跑</p>
            </div>
            <div className="dialog-actions">
              <button type="button" onClick={() => void cancel()}>
                取消整批
              </button>
              <button type="button" onClick={() => void resume()}>
                继续生成
              </button>
            </div>
          </div>
        </div>
      )}

      {progress?.status === 'aborted' && !abortDismissed && (
        <div className="dialog-backdrop">
          <div className="dialog">
            <button type="button" className="dialog-close" title="关闭" onClick={() => setAbortDismissed(true)}>
              ×
            </button>
            <div className="dialog-title">整批已中止</div>
            <div className="dialog-body">
              {/* 原文是「整批已中止：<原因>」，逐字给出，免得只显示原因而让人看不出这是中止而非普通失败 */}
              <p>整批已中止：{progress.abortReason}</p>
            </div>
            <div className="dialog-actions">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setAbortDismissed(true)
                  onOpenSettings()
                }}
              >
                打开设置
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
