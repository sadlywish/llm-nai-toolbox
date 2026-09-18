// 出图页的纯逻辑（计划 Task 15）：格子状态、状态行文字、断线补齐、参数写回手机。
//
// 单拎出来的理由同 llmPending.ts：手机上 SSE 断得非常勤（锁屏、切后台、走出路由器范围），
// 断线期间的 `gen-progress` / `gen-image` 是真的丢了——结果落在电脑的历史里，得靠它补回来。
// 补错了会把别人那一轮的图挂到自己这一轮上，补不上则永远停在「跑图中」，两头都不能出错，
// 所以判断全在这里、全有测试；Gen.tsx 只负责把结果画出来，不许在那边再判一次。
import { applyRoundToWorkspace } from '@shared/copyInfo'
import type { GenImageEvent, GenSnapshot, RoundRecord, RunProgress, RunStatus } from '@shared/gen'
import { normalizeWorkspace, type Workspace } from '@shared/workspace'

/** 一个格子的四态：等待 / 生成中 / 成功（带文件名与 seed）/ 失败（带原因） */
export type Slot =
  | { index: number; kind: 'waiting' }
  | { index: number; kind: 'running' }
  | { index: number; kind: 'ok'; file: string; seed: number }
  | { index: number; kind: 'failed'; reason: string }

/** 失败记录没写原因时的兜底。空白格子最难受：人分不清是没出还是出坏了 */
const UNKNOWN_FAILURE = '这张没出来'

/** 历史里找不到自己那一轮时的收尾原因（电脑中途关掉、保存目录被换过都会走到这儿） */
export const MISSING_ROUND_REASON = '和电脑断开的这段时间里这一轮结束了，没在历史里找到它'

/** 还在跑（含 429 暂停等人工确认）。只有这两个状态需要断线补齐 */
export function isLiveStatus(status: RunStatus | undefined): boolean {
  return status === 'running' || status === 'paused'
}

/**
 * 每一格现在是什么状态。
 *
 * `images` 里只认 roundId 对得上这一轮的：SSE 是广播的，电脑自己发起的那一轮手机同样收得到
 * （能看见电脑在出什么图是有意的），但它的图绝不能填进手机这一轮的格子里。
 */
export function slotsOf(progress: RunProgress | null, images: readonly GenImageEvent[]): Slot[] {
  if (progress === null) return []
  const mine = new Map<number, GenImageEvent>()
  for (const img of images) if (img.roundId === progress.roundId) mine.set(img.index, img)

  return Array.from({ length: Math.max(0, progress.total) }, (_, index): Slot => {
    const img = mine.get(index)
    if (img !== undefined) {
      // file 为空的 ok 记录在正常路径上不存在，真出现了也不能拿它去拼图片地址（只会拿到 404）
      if (img.status === 'ok' && img.file !== '') return { index, kind: 'ok', file: img.file, seed: img.seed }
      return { index, kind: 'failed', reason: img.error ?? UNKNOWN_FAILURE }
    }
    // current 只在「正在发出请求」时有值：暂停与结束时是 null，那时把队首标成生成中是撒谎
    if (progress.status === 'running' && progress.current === index) return { index, kind: 'running' }
    return { index, kind: 'waiting' }
  })
}

const STATUS_WORDS: Record<RunStatus, string> = {
  idle: '准备中',
  running: '跑图中',
  paused: '已暂停',
  done: '完成',
  cancelled: '已取消',
  aborted: '已中断',
}

/**
 * 状态行那句话（界面稿第三节：`出图 · 2 / 4`）。
 *
 * 分子是 `done + failed` 而不是 done：失败的那张也已经跑过了，只报成功数的话进度会卡住不动，
 * 看起来像是死了（同桌面端 GenDialog 的那一行）。
 */
export function genStatusText(progress: RunProgress | null): string {
  if (progress === null) return '还没出过图'
  const fail = progress.failed > 0 ? ` · 失败 ${progress.failed}` : ''
  return `${STATUS_WORDS[progress.status]} · ${progress.done + progress.failed} / ${progress.total}${fail}`
}

/**
 * 要不要去历史里补一次。
 *
 * 本地还停在「跑图中 / 已暂停」而电脑那头 `busy.gen` 已经是 false，说明这一轮的结局是在断线
 * 期间发生的——那几条事件不会重发。电脑还在跑就不补：重连之后的进度事件会接着报，
 * 这时去翻历史只会拿到一份还没跑完的快照，把界面倒回去。
 */
export function needsCatchUp(progress: RunProgress | null, busyGen: boolean): boolean {
  return !busyGen && progress !== null && isLiveStatus(progress.status)
}

export interface CatchUp {
  progress: RunProgress
  images: GenImageEvent[]
  /** 历史里那一轮的完整记录；没找到为 null（图片地址与「参数写回手机」都要靠它） */
  record: RoundRecord | null
}

/** 记录里的轮次状态翻成运行状态。running/paused/interrupted 落到这里只能是没跑完就断了 */
function runStatusOf(record: RoundRecord): RunStatus {
  if (record.status === 'done' || record.status === 'cancelled' || record.status === 'aborted') return record.status
  return 'aborted'
}

/** 记录 → 进度。`live` 为 true 表示电脑那头还在跑这一轮（这时记录里的 running/paused 是真的） */
function progressOf(record: RoundRecord, live: boolean): RunProgress {
  const status: RunStatus = live && (record.status === 'running' || record.status === 'paused') ? record.status : runStatusOf(record)
  return {
    roundId: record.id,
    status,
    total: record.count,
    done: record.images.filter((i) => i.status === 'ok').length,
    failed: record.images.filter((i) => i.status === 'failed').length,
    pauseReason: null,
    abortReason: null,
    // 记录里没有「正在发哪一张」，留空即可：格子按已有的图画，空格一律是等待
    current: null,
  }
}

/**
 * 重新加载页面之后找回上次那一轮（页面被系统回收、手动刷新都会走到这儿）。
 *
 * 与 catchUpFrom 的差别：那个是「本地还停在跑图中」时的补齐，这里本地什么都没有，
 * 靠存下来的 roundId 去历史里认。同样只认 id 对得上的那一条——拿最近一轮充数会把
 * 电脑自己跑的那轮显示成「你刚才那一轮」。
 */
export function restoreRound(roundId: string, rounds: readonly RoundRecord[], busyGen: boolean): CatchUp | null {
  const record = rounds.find((r) => r.id === roundId)
  if (record === undefined) return null
  return { progress: progressOf(record, busyGen), images: imagesOf(record), record }
}

/** 事件里的图片比记录里的多一个 roundId，补上就能和 SSE 推来的那些混在一起用 */
export function imagesOf(record: RoundRecord): GenImageEvent[] {
  return record.images.map((img) => ({ ...img, roundId: record.id }))
}

/**
 * 断线期间跑完的那一轮：用 `GET /api/history?days=1` 的结果把格子补齐。
 *
 * 只认 id 对得上的那一条，不拿「最近一轮」充数：手机断线的这段时间里电脑完全可能自己又跑了一轮，
 * 拿它的图填进来就是彻头彻尾的假象。真找不到自己那一轮就把状态收成「已中断」并说明原因——
 * 让它一直转着「跑图中」比说不知道更糟。
 */
export function catchUpFrom(local: RunProgress | null, rounds: readonly RoundRecord[]): CatchUp | null {
  if (local === null || !isLiveStatus(local.status)) return null
  const record = rounds.find((r) => r.id === local.roundId)
  if (record === undefined) {
    return {
      progress: { ...local, status: 'aborted', current: null, pauseReason: null, abortReason: MISSING_ROUND_REASON },
      images: [],
      record: null,
    }
  }
  // 走到这儿说明电脑那头已经不忙了（needsCatchUp 的前提），记录里的状态就是结局
  return { progress: progressOf(record, false), images: imagesOf(record), record }
}

/**
 * 新到的一张并进已有的那批。
 *
 * 换了一轮就只留新的那张：电脑同时只跑一轮（服务端那把锁），所以 roundId 一变就说明上一轮
 * 已经过去了，留着只会在手机上白占内存。同一格重复推来（重试之后又成功）以最后一条为准。
 */
export function mergeImage(images: readonly GenImageEvent[], next: GenImageEvent): GenImageEvent[] {
  if (images.length > 0 && images[0].roundId !== next.roundId) return [next]
  const at = images.findIndex((img) => img.index === next.index)
  if (at < 0) return [...images, next]
  const merged = [...images]
  merged[at] = next
  return merged
}

/**
 * 「参数写回手机」：把那一轮的快照整套写回手机这一份工作区，seed 用点开的这张的并改成固定。
 *
 * applyRoundToWorkspace 是就地改的（桌面端在 immer 的 draft 上跑），手机这边是普通的 React
 * 状态，原地改 React 认不出变化、界面不重画——先深拷一份再改，传进来的那份一个字都不动。
 * normalizeWorkspace 顺带就是一份深拷贝（同 llmPending.ts 的 applyFilled）。
 */
export function applyRoundToMobile(ws: Workspace, snapshot: GenSnapshot, seed: number): Workspace {
  const next = normalizeWorkspace(ws)
  applyRoundToWorkspace(next, snapshot, seed)
  return next
}
