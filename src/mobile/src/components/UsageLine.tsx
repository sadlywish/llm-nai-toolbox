// 顶部额度行（计划 Task 13，界面稿「参数（手机自己的一份）」页脚注：额度由桌面端代查）。
//
// 进入应用查一次；出图结束后要再查一次，但出图页是 Task 15 才做——这里先留 refreshSignal
// 这个口子，往后接的时候只要把它换成「每次出图完成就变一次的值」（自增计数器即可）就行，
// 不用改这个组件。
import { useEffect, useState } from 'react'
import type { ApiClient } from '../api'
import { formatUsageLine } from '../usageLine'

interface Props {
  client: ApiClient
  /** GET /api/meta 的 usagePercentPerImage；meta 还没拉到时先给 0（表现为不显示张数，不是显示错的张数） */
  percentPerImage: number
  /** 改变即触发重新查询 */
  refreshSignal?: number
}

type State = { kind: 'loading' } | { kind: 'ready'; text: string; low: boolean } | { kind: 'error'; message: string }

/** 查询失败（连不上电脑、令牌问题等）翻成能显示的一句话；不弹窗，只降级成一行灰字 */
function messageOf(err: unknown): string {
  return err instanceof Error && err.message !== '' ? err.message : '额度查询失败'
}

export default function UsageLine({ client, percentPerImage, refreshSignal }: Props): JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    let alive = true
    setState({ kind: 'loading' })
    client
      .usage()
      .then((result) => {
        if (!alive) return
        // /api/usage 永远 200，失败与否体现在 result.ok（服务端转发的 NovelAI 查询结果）
        if (!result.ok) {
          setState({ kind: 'error', message: result.error.message })
          return
        }
        const { text, low } = formatUsageLine(result.subscription, percentPerImage)
        setState({ kind: 'ready', text, low })
      })
      .catch((err: unknown) => {
        if (alive) setState({ kind: 'error', message: messageOf(err) })
      })
    return () => {
      alive = false
    }
  }, [client, percentPerImage, refreshSignal])

  if (state.kind === 'loading') return <span className="dim">额度查询中…</span>
  if (state.kind === 'error') return <span className="dim">{state.message}</span>
  return <span className={state.low ? 'low' : undefined}>{state.text}</span>
}
