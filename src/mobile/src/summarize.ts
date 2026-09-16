// 历史列表一条的两行文字（计划 Task 16，界面稿第四节左边那张）。
//
// “今天 / 昨天 / 更早”按本地日历日比较，不是按“过去了多少小时”——晚上 23:50 出的图，
// 第二天 00:30 打开历史看到的该是“昨天”，不是因为没满 24 小时就还算“今天”。
// 需要一个 now 参数正是为了让这条边界可测：调用方（History.tsx）传 `new Date()`。
import type { RoundRecord } from '@shared/gen'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 本地日历日的零点，整天整天地比较 */
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** 今天 / 昨天 / 更早按 MM-DD（同 formatRoundTime 的日期部分，去掉年份） */
function dayLabel(d: Date, now: Date): string {
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (diffDays === 0) return '今天'
  if (diffDays === 1) return '昨天'
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 历史一条的标题与副标题：标题给时间与张数，副标题给尺寸与成功/失败数 */
export function summarize(round: RoundRecord, now: Date): { title: string; sub: string } {
  const started = new Date(round.startedAt)
  // 时间解析不了（记录损坏、手改过）时原样给出来，不能编一个假的“今天”
  const time = Number.isFinite(started.getTime())
    ? `${dayLabel(started, now)} ${pad(started.getHours())}:${pad(started.getMinutes())}`
    : round.startedAt
  const title = `${time} · ${round.count} 张`

  const ok = round.images.filter((i) => i.status === 'ok').length
  const failed = round.images.filter((i) => i.status === 'failed').length
  const p = round.snapshot.params
  // 全成功是最常见的情况：每条都带一句「失败 0」只会添乱，所以只在真有失败时才写
  const sub = `${p.width}×${p.height} · 成功 ${ok}${failed > 0 ? ` · 失败 ${failed}` : ''}`

  return { title, sub }
}
