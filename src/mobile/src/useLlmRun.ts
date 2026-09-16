// 手机端这一轮 LLM 的状态：日志行、第几轮、结局，以及回填与断线补偿的时机。
//
// 判断全在 llmPending.ts 那几个纯函数里，这里只管「什么时候去问、问到了交给谁」。
// 桌面端同一份逻辑在 renderer/src/state/llm.ts（zustand store），手机端不引 zustand，
// 也不需要跨页面共享——外壳只有一个，一个 hook 挂在外壳上就够。
import { useCallback, useEffect, useRef, useState } from 'react'
import { fillSummary } from '@shared/applyFill'
import type { ApiType } from '@shared/config'
import type { LlmLogLine } from '@shared/llm'
import type { MobileEvent } from '@shared/mobileApi'
import type { StylePreset } from '@shared/styles'
import type { Workspace } from '@shared/workspace'
import { messageOf, type ApiClient } from './api'
import {
  applyFilled,
  clearPending,
  decideFinished,
  loadPending,
  planRun,
  savePending,
  type FinishedRun,
  type LlmPhase,
  type LogLine,
} from './llmPending'

/** 日志最多留这么多行，更早的丢掉（同桌面端 MAX_LOG_LINES）。一轮通常几十到两三百行 */
export const MAX_LOG_LINES = 2000

function clockText(d: Date): string {
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
}

export interface LlmRunHandle {
  phase: LlmPhase
  lines: LogLine[]
  running: boolean
  /** 发过至少一轮，日志页里有东西可看 */
  hasLog: boolean
  send: (ws: Workspace, presets: readonly StylePreset[]) => void
  abort: () => void
  /** SSE 事件入口，由外壳那条唯一的订阅转进来 */
  handleEvent: (e: MobileEvent) => void
  /** 断线补偿：查一次 `GET /api/llm/last`，是自己那一轮又没应用过就补上 */
  checkLast: () => void
}

interface Options {
  client: ApiClient
  /** 回填写进手机这一份工作区 */
  update: (fn: (w: Workspace) => Workspace) => void
  /** 回填成功、工作区已经写好之后：收起日志、回工作台、显示「已回填: …」 */
  onFilled: (summary: string) => void
  /** 电脑上的 LLM 类型与模型名（GET /api/meta 的 llm），记进溯源用；meta 还没到手时为 null */
  api: { apiType: ApiType; model: string } | null
}

export function useLlmRun({ client, update, onFilled, api }: Options): LlmRunHandle {
  const [phase, setPhase] = useState<LlmPhase>({ kind: 'idle' })
  const [lines, setLines] = useState<LogLine[]>([])

  // 这几个要在 SSE 订阅的回调里读到最新值，而那条订阅整个连接期间只挂一次，所以走 ref
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const updateRef = useRef(update)
  updateRef.current = update
  const filledRef = useRef(onFilled)
  filledRef.current = onFilled
  // meta 是连上之后才拉回来的：send 的 useCallback 依赖里放它会让回调反复重建，
  // 不放又会把首次渲染时的 null 永久闭包进去（实机踩过：溯源里的模型名一直是空的）
  const apiRef = useRef(api)
  apiRef.current = api
  const seq = useRef(0)

  const append = useCallback((line: LlmLogLine, ok = false): void => {
    seq.current += 1
    // 递增序号当 key：行数封顶后下标会整体移位，用下标当 key 会让整片日志重画
    const next: LogLine = ok ? { ...line, seq: seq.current, ok } : { ...line, seq: seq.current }
    setLines((old) => (old.length >= MAX_LOG_LINES ? [...old.slice(old.length - MAX_LOG_LINES + 1), next] : [...old, next]))
  }, [])

  /** 一轮的结局到了：是不是自己那一轮、要不要回填，全交给 decideFinished 判 */
  const settle = useCallback(
    (finished: FinishedRun | null): void => {
      const decision = decideFinished(loadPending(), finished)
      if (decision.kind === 'ignore') return
      // 先清待办再回填：同一轮的结局可能从两条路一起到（SSE 的 llm-finished 与 /api/llm/last），
      // 待办就是「还没应用过」的标记，清在前面第二条路才会被 decideFinished 判成 ignore
      clearPending()
      setPhase({ kind: 'done', result: decision.result })
      if (decision.kind !== 'apply') return
      const summary = fillSummary(decision.fill)
      updateRef.current((w) => applyFilled(w, decision.fill, decision.request))
      append({ time: clockText(new Date()), level: 'I', text: summary }, true)
      filledRef.current(summary)
    },
    [append],
  )

  const checkLast = useCallback((): void => {
    // 没有待结算的那一轮就不用问：/api/llm/last 给的是电脑上最近跑完的那一轮，可能根本不是手机发的
    if (loadPending() === null) return
    void client
      .llmLast()
      .then((r) => settle(r.last === null ? null : { runId: r.last.runId, result: r.last.result }))
      // 这一次没问到（还在断网、电脑没醒）就算了，下次重连或下次进页面再问
      .catch(() => undefined)
  }, [client, settle])

  const send = useCallback(
    (ws: Workspace, presets: readonly StylePreset[]): void => {
      if (phaseRef.current.kind === 'running') return
      // 入参与请求记录同一时刻取：跑的途中改指令区不影响这一轮
      // meta 还没到手时退回一个类型合法的占位：溯源里的 apiType 不合法整条来源会被丢掉
      const plan = planRun(ws, presets, apiRef.current ?? { apiType: 'claude', model: '' })
      setPhase({ kind: 'running', round: 0, maxRounds: 0 })
      // 每发一轮清一次日志：手机屏幕就这么大，上一轮的行混在里面分不清是哪一轮的
      setLines([])
      void client.llmRun(plan.input).then(
        ({ runId }) => {
          savePending({ runId, request: plan.request })
          // 存完立刻查一次：结局比这句回话还早到的话（电脑那头没填 Key，一秒就失败），
          // llm-finished 到达时待办还没存下，那一轮会一直停在「运行中」
          checkLast()
        },
        (err: unknown) => {
          // 被拒时服务端不会再发 finished（409「电脑正在出图…」就是这类），这里自己收尾。
          // message 是服务端给的、能直接显示的中文原话，原样显示，不自己编一句
          const message = messageOf(err)
          setPhase({ kind: 'done', result: { status: 'failed', rounds: 0, elapsedMs: 0, message } })
          append({ time: clockText(new Date()), level: 'E', text: `发送失败：${message}` })
        },
      )
    },
    [client, append, checkLast],
  )

  const abort = useCallback((): void => {
    if (phaseRef.current.kind !== 'running') return
    // 结局照样经 llm-finished（status: 'aborted'）回来，这里不自己改状态
    void client.llmAbort().catch((err: unknown) => {
      append({ time: clockText(new Date()), level: 'W', text: `中止没送到：${messageOf(err)}` })
    })
  }, [client, append])

  const handleEvent = useCallback(
    (e: MobileEvent): void => {
      if (e.kind === 'llm-log') {
        // 只在自己这一轮跑着的时候收行：电脑那头同时只能跑一轮（服务端那把锁），
        // 所以跑着时来的行一定是自己这一轮的；闲着时来的行是电脑自己在跑，不该混进手机的日志
        if (phaseRef.current.kind === 'running') append(e.line)
        return
      }
      if (e.kind === 'llm-round') {
        if (phaseRef.current.kind === 'running') setPhase({ kind: 'running', round: e.round, maxRounds: e.maxRounds })
        return
      }
      // 结局不看 phase：页面刷过一次的话 phase 是 idle，但那一轮的回填照样得补上
      if (e.kind === 'llm-finished') settle({ runId: e.runId, result: e.result })
    },
    [append, settle],
  )

  // 页面加载时补一次：上一次打开这个页面时发出去的那一轮，可能在锁屏期间就跑完了
  useEffect(() => checkLast(), [checkLast])

  return {
    phase,
    lines,
    running: phase.kind === 'running',
    hasLog: phase.kind !== 'idle' || lines.length > 0,
    send,
    abort,
    handleEvent,
    checkLast,
  }
}
