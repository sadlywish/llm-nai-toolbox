// 手机端这一轮出图的状态：进度、每张图、那一轮的历史记录，以及断线之后怎么把格子补齐。
//
// 路子照 useLlmRun.ts：判断全在 slots.ts 那几个纯函数里，这里只管「什么时候去问、问到了交给谁」。
// 与 LLM 那边不同的是出图的结果一定落在电脑的历史里，所以断线补偿不需要另开接口，
// 查一次 `GET /api/meta` 看电脑还忙不忙，再翻一次 `GET /api/history?days=1` 就够。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GenImageEvent, RoundRecord, RunProgress } from '@shared/gen'
import type { MobileEvent } from '@shared/mobileApi'
import type { Workspace } from '@shared/workspace'
import { messageOf, type ApiClient } from './api'
import { catchUpFrom, isLiveStatus, mergeImage, needsCatchUp, restoreRound, slotsOf, type Slot } from './slots'
import { loadGenRound, saveGenRound } from './state'

export interface GenRunHandle {
  progress: RunProgress | null
  slots: Slot[]
  /** 这一轮在历史里的那条记录：图片地址要它的 startedAt，「参数写回手机」要它的 snapshot；还没拉到为 null */
  round: RoundRecord | null
  /** 开跑被挡回来（409「电脑正在出图…」）那类失败的原话，能直接显示 */
  error: string | null
  /** 请求已经发出、还没拿到 roundId 的那一小段 */
  starting: boolean
  /** 还在跑（含 429 暂停）：决定顶上是「取消 / 继续」还是什么都不显示 */
  live: boolean
  start: (ws: Workspace, count: number) => void
  cancel: () => void
  resume: () => void
  /** SSE 事件入口，由外壳那条唯一的订阅转进来 */
  handleEvent: (e: MobileEvent) => void
  /** 断线补偿：电脑那头不忙了而本地还停在跑图中，就去历史里把这一轮补齐 */
  checkStalled: () => void
  /** 每跑完一轮 +1。顶部额度行拿它当刷新信号——出完图点数就变了 */
  finishedSignal: number
}

export function useGenRun(client: ApiClient): GenRunHandle {
  const [progress, setProgress] = useState<RunProgress | null>(null)
  const [images, setImages] = useState<GenImageEvent[]>([])
  const [round, setRound] = useState<RoundRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [finishedSignal, setFinishedSignal] = useState(0)

  // SSE 那条订阅整个连接期间只挂一次，回调里只能通过 ref 读到最新的进度（同 useLlmRun）
  const progressRef = useRef(progress)
  progressRef.current = progress
  const roundRef = useRef(round)
  roundRef.current = round
  const startingRef = useRef(false)

  /** 结局到了就让额度行再查一次。放在一处，SSE 与断线补齐两条路都走它 */
  const settle = useCallback((next: RunProgress): void => {
    const was = progressRef.current
    if (was !== null && was.roundId === next.roundId && isLiveStatus(was.status) && !isLiveStatus(next.status)) {
      setFinishedSignal((n) => n + 1)
    }
    // 换了一轮就把上一轮的记录丢掉：留着的话图片地址会拼上别人那一轮的日期目录
    if (was !== null && was.roundId !== next.roundId) setRound(null)
    // 记下轮次 id：页面被系统回收后重新加载时靠它把这一轮找回来（跑完的也要，
    // 「切出去等着，回来发现出图页一片空白」就是这么来的）
    saveGenRound(next.roundId)
    setProgress(next)
  }, [])

  const start = useCallback(
    (ws: Workspace, count: number): void => {
      // 在途标记走 ref 而不是上面那个 state：把 state 写进依赖会让 start 每次变身份，
      // 而外壳的「回填后自动生成」effect 盯着它
      if (isLiveStatus(progressRef.current?.status) || startingRef.current) return
      setError(null)
      startingRef.current = true
      setStarting(true)
      client.genStart({ workspace: ws, count }).then(
        ({ roundId }) => {
          startingRef.current = false
          setStarting(false)
          // 抢先摆好格子：SSE 这会儿可能正断着（锁屏刚回来），没有这一条的话页面会一直空着。
          // 已经收到这一轮的真进度就不要覆盖——那一条比这里编的准
          if (progressRef.current?.roundId === roundId) return
          setImages([])
          setRound(null)
          setProgress({
            roundId,
            status: 'running',
            total: count,
            done: 0,
            failed: 0,
            pauseReason: null,
            abortReason: null,
            current: null,
          })
        },
        (err: unknown) => {
          startingRef.current = false
          setStarting(false)
          // 409 时 message 是电脑那头给的中文原话（Global Constraints），原样显示，不自己编一句
          setError(messageOf(err))
        },
      )
    },
    [client],
  )

  const cancel = useCallback((): void => {
    // 结局照样经 gen-progress（status: 'cancelled'）回来，这里不自己改状态
    client.genCancel().catch((err: unknown) => setError(messageOf(err)))
  }, [client])

  const resume = useCallback((): void => {
    client.genResume().catch((err: unknown) => setError(messageOf(err)))
  }, [client])

  const checkStalled = useCallback((): void => {
    if (!isLiveStatus(progressRef.current?.status)) return
    client
      .meta()
      .then((m) => {
        if (!needsCatchUp(progressRef.current, m.busy.gen)) return
        return client.history(1).then((rounds) => {
          const caught = catchUpFrom(progressRef.current, rounds)
          if (caught === null) return
          setImages(caught.images)
          if (caught.record !== null) setRound(caught.record)
          settle(caught.progress)
        })
      })
      // 这一次没问到（还在断网、电脑没醒）就算了：下次重连或下次进出图页再问
      .catch(() => undefined)
  }, [client, settle])

  // 重新加载之后把上次那一轮接回来（页面被系统回收、手动刷新都会走到这儿）。
  // 只做一次，且只在本地还什么都没有时做：SSE 已经推来进度的话那份更新
  useEffect(() => {
    const saved = loadGenRound()
    if (saved === null) return undefined
    let alive = true
    void Promise.all([client.meta(), client.history(1)])
      .then(([m, rounds]) => {
        if (!alive || progressRef.current !== null) return
        const found = restoreRound(saved, rounds, m.busy.gen)
        if (found === null) return
        setImages(found.images)
        setRound(found.record)
        settle(found.progress)
      })
      // 这一次没问到（电脑没开、还在断网）就算了，不必报错：出图页照旧显示「还没出过图」
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [client, settle])

  const handleEvent = useCallback(
    (e: MobileEvent): void => {
      if (e.kind === 'gen-progress') {
        // 电脑自己发起的那一轮也会推到这里。照收不误：同时只能跑一轮（服务端那把锁），
        // 手机上看见「电脑正在出图 2 / 4」比看见一片空白有用得多
        settle(e.progress)
        return
      }
      if (e.kind === 'gen-image') setImages((old) => mergeImage(old, e.image))
    },
    [settle],
  )

  // 那一轮在历史里的记录：`POST /api/gen/start` 只回一个 roundId，而图片地址要的是那一轮的
  // 开始时间（`GET /api/image?round=<ISO>`），「参数写回手机」要的是它的快照。轮次记录在开跑前
  // 就落盘了（GenRunner.start 里的 index.startRound），所以这时候一定查得到。
  // images.length 也在依赖里：第一次没查到（刚好在断网）时，下一张图到达会再试一次
  const roundId = progress?.roundId ?? ''
  const imageCount = images.length
  useEffect(() => {
    if (roundId === '' || roundRef.current?.id === roundId) return
    let alive = true
    client
      .history(1)
      .then((rounds) => {
        const found = rounds.find((r) => r.id === roundId)
        if (alive && found !== undefined) setRound(found)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [client, roundId, imageCount])

  return {
    progress,
    slots: slotsOf(progress, images),
    round,
    error,
    starting,
    live: isLiveStatus(progress?.status),
    start,
    cancel,
    resume,
    handleEvent,
    checkStalled,
    finishedSignal,
  }
}
