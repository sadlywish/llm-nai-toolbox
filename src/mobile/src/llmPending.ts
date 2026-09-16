// 手机端这一轮 LLM 的纯逻辑：发送时记下什么、断线之后要不要补上回填、回填怎么写进工作区。
//
// 单拎出来是因为这几件事判错的代价最大：判松了会把电脑那边跑的那一轮写进手机的工作区，
// 判紧了会让锁屏期间跑完的那一轮白跑一次（手机上 SSE 断得非常勤：锁屏、切后台、走出路由器范围）。
// 界面部分（Console.tsx / LlmLog.tsx）只负责显示，不许在那边再判一次。
import { applyFill } from '@shared/applyFill'
import type { ApiType } from '@shared/config'
import { buildRunInput, pendingRequestOf, type PendingLlmRequest } from '@shared/consoleRun'
import type { FillResult, LlmLogLine, LlmRunInput, LlmRunResult } from '@shared/llm'
import { attachLlm, normalizeWorkspaceLlm, type LlmRequestInfo } from '@shared/llmProvenance'
import type { StylePreset } from '@shared/styles'
import { normalizeWorkspace, type Workspace } from '@shared/workspace'
import { readKey, writeKey } from './state'

/**
 * 还没结算的那一轮，存 localStorage：页面被系统回收、用户手动刷新之后照样认得出
 * 「刚才发出去的那一轮还没收到结果」。键里带 `:v1`，同 MOBILE_STATE_KEY 的理由。
 */
export const MOBILE_PENDING_KEY = 'nai-mobile:v1:llm-pending'

/** 发送那一刻记下的东西。有这条记录本身就是「这一轮还没应用过」的标记，结算完就删掉 */
export interface PendingRun {
  runId: string
  /** 按下发送那一刻的请求选项，回填时补上轮数与用时写进溯源 */
  request: PendingLlmRequest
}

/**
 * 按下发送那一刻取的全部东西。两者必须同一时刻取：跑的途中改指令区不该影响这一轮的记录。
 * api 取自 `GET /api/meta` 的 `llm`（只有类型与模型名），记进溯源的「LLM 请求」里——
 * 编一个假的会在出图历史里显示成错的模型。
 */
export function planRun(
  ws: Workspace,
  presets: readonly StylePreset[],
  api: { apiType: ApiType; model: string },
): { input: LlmRunInput; request: PendingLlmRequest } {
  return { input: buildRunInput(ws, presets), request: pendingRequestOf(ws, presets, api) }
}

/**
 * 存回来的待办形状不对就当没有。
 *
 * 校验借 normalizeWorkspaceLlm 做：请求记录的形状归它管，这边再抄一份校验，
 * 将来 LlmRequestInfo 加字段时一定会漏掉一处。轮数与用时是结算时才知道的，先塞 0 占位。
 */
function parsePending(raw: unknown): PendingRun | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const { runId, request } = raw as Record<string, unknown>
  if (typeof runId !== 'string' || runId === '') return null
  const parsed = normalizeWorkspaceLlm({
    request: { ...(typeof request === 'object' && request !== null ? request : {}), llmRounds: 0, elapsedMs: 0 },
    fingerprint: '',
    stale: false,
  })
  if (parsed === null) return null
  const { llmRounds: _rounds, elapsedMs: _elapsed, ...rest } = parsed.request
  return { runId, request: rest }
}

export function loadPending(): PendingRun | null {
  return parsePending(readKey(MOBILE_PENDING_KEY))
}

/** 立刻落盘，不走防抖：发出去之后页面随时可能被系统回收，丢了这条就等于丢掉那一轮的回填 */
export function savePending(pending: PendingRun): void {
  writeKey(MOBILE_PENDING_KEY, pending)
}

export function clearPending(): void {
  writeKey(MOBILE_PENDING_KEY, null)
}

/** 一轮的结局，可能来自 SSE 的 `llm-finished`，也可能来自重连后查的 `GET /api/llm/last` */
export interface FinishedRun {
  runId: string
  result: LlmRunResult
}

export type FinishDecision =
  /** 不是自己发的那一轮，或者已经结算过了：什么都不做，尤其不能动工作区 */
  | { kind: 'ignore' }
  /** 是自己那一轮，但没有可回填的内容（失败、中止、模型没给参数）：收尾显示原因，工作区不动 */
  | { kind: 'settle'; result: LlmRunResult }
  /** 是自己那一轮且回填成功：应用 fill，并按发送那一刻的记录 + 本轮轮数用时写进溯源 */
  | { kind: 'apply'; result: LlmRunResult; fill: FillResult; request: LlmRequestInfo }

/**
 * 这一轮的结局要不要落到手机这一份工作区上。
 *
 * 只认 runId 对得上的那一轮：SSE 是广播的，电脑自己发起的那一轮手机同样收得到
 * （能看见电脑在跑什么是有意的），但它的回填绝不能写进手机这一份。
 */
export function decideFinished(pending: PendingRun | null, finished: FinishedRun | null): FinishDecision {
  if (pending === null || finished === null || pending.runId !== finished.runId) return { kind: 'ignore' }
  const result = finished.result
  if (result.status !== 'filled') return { kind: 'settle', result }
  return {
    kind: 'apply',
    result,
    fill: result.fill,
    request: { ...pending.request, llmRounds: result.rounds, elapsedMs: result.elapsedMs },
  }
}

/**
 * 回填写进手机这一份工作区，返回新的一份。
 *
 * applyFill 与 attachLlm 都是就地改的（桌面端那边在 immer 的 draft 上跑），而手机这边是普通的
 * React 状态：先深拷一份再改，传进来的那份一个字都不动——原地改的话 React 认不出变化，界面不重画。
 * normalizeWorkspace 顺带就是一份深拷贝，不必再写一个只会漏字段的 clone。
 * 回填与记来源必须在同一份上做完：指纹取的是回填之后的内容，紧接着的自动生成才不会被当成手改过。
 */
export function applyFilled(ws: Workspace, fill: FillResult, request: LlmRequestInfo): Workspace {
  const next = normalizeWorkspace(ws)
  applyFill(next, fill)
  attachLlm(next, request, false)
  return next
}

export type LlmPhase =
  | { kind: 'idle' }
  /** round 为 0：还没进第一轮（在备齐标签数据） */
  | { kind: 'running'; round: number; maxRounds: number }
  | { kind: 'done'; result: LlmRunResult }

/** 日志区的一行，加一个递增序号给 React 当 key，以及「已回填」那行的绿色标记 */
export interface LogLine extends LlmLogLine {
  seq: number
  ok?: boolean
}

/**
 * 日志页顶上那条状态（界面稿第三节：`运行中 · 第 2 / 10 轮`）。
 * 与桌面端 renderer/src/state/llm.ts 的 statusText 逐条对应；那个文件 import 了 zustand，
 * 手机端不能引（只复用 @shared/* 与 @renderer 下的纯函数），所以这里照抄一份。
 */
export function statusTitle(phase: LlmPhase): string {
  if (phase.kind === 'idle') return ''
  if (phase.kind === 'running') return phase.round > 0 ? `运行中 · 第 ${phase.round} / ${phase.maxRounds} 轮` : '运行中'
  const r = phase.result
  if (r.status === 'filled') return `✓ 已回填 · ${r.rounds} 轮 · 用时 ${Math.round(r.elapsedMs / 1000)}s`
  if (r.status === 'noParams') return `✕ 模型没有给出参数 · ${r.rounds} 轮`
  // 0 轮就失败的（发送被 409 挡回来、电脑那头没填 Key）没有「第几轮」可说，直接写服务端给的那句话
  if (r.status === 'failed') return r.rounds > 0 ? `✕ 请求失败 · 第 ${r.rounds} 轮` : `✕ ${r.message}`
  return r.rounds > 0 ? `■ 已中止 · 停在第 ${r.rounds} 轮` : '■ 已中止'
}
