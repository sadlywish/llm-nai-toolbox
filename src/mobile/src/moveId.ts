// 画风列表的上移/下移（计划 Task 17）：按 id 在数组里与相邻一项互换位置，到头（已经是第一条
// 还要上移、已经是最后一条还要下移）就不动。单独抽成纯函数是为了能直接单元测试——这种边界
// 判断错一步，界面上都是「点了没反应」或「挪错行」，光看截图分不出是谁的锅。
export function moveId(ids: string[], id: string, delta: -1 | 1): string[] {
  const i = ids.indexOf(id)
  if (i === -1) return ids
  const j = i + delta
  if (j < 0 || j >= ids.length) return ids
  const next = ids.slice()
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}
