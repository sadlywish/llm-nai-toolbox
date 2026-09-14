/** 轮次时间：本地时间 MM-DD HH:mm。历史竖栏与出图弹窗标题共用；不是合法时间时原样返回 */
export function formatRoundTime(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
