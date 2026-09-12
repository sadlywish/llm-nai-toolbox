/**
 * 进程内唯一 id。
 *
 * 带一个自增计数而不是只靠时间戳：同一毫秒内连续建几个角色是常事，
 * 纯时间戳会撞号，而撞号的表现是「删掉一个角色，另一个跟着消失」。
 */
let counter = 0

export function newId(prefix: string): string {
  counter += 1
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`
}
