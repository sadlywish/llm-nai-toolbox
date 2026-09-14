import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'

/** 当日目录名。用本地时间而不是 UTC：用户看到的「今天」是本地的今天 */
export function dateDirName(now: Date): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 当日目录内的下一个序号。
 *
 * 扫描已有文件名取最大值 +1，不用内存计数器——应用重启、用户手删文件、
 * 多次会话交替跑图，任何一种都会把计数器搞乱，而扫描永远是对的。
 */
export function nextSequence(dir: string): number {
  if (!existsSync(dir)) return 1

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch (e) {
    // 目录不存在是正常情况（当天第一张图），从 1 开始。
    // 其余错误（权限、I/O、路径不是目录）必须抛出去：
    // 把它们当成「空目录」会返回 1，随后 saveImage 就用 00001 覆盖掉
    // 目录里已有的那张图——静默丢掉一张用户已经花了 API 额度生成的图，
    // 远比让这次保存明确失败糟糕。抛出去之后队列会把它记成失败写进索引，
    // 用户至少看得见
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return 1
    throw e
  }

  let next = 1
  for (const name of entries) {
    const m = /^(\d+)-/.exec(name)
    if (m) next = Math.max(next, parseInt(m[1], 10) + 1)
  }
  return next
}

export interface SavedImage {
  filePath: string
  fileName: string
  /** 当日目录的绝对路径，`_index.json` 也落在这里 */
  dateDir: string
}

/** 按 `<根目录>/YYYY-MM-DD/<5位序号>-<seed>.<ext>` 写一张图 */
export function saveImage(
  rootDir: string,
  bytes: Buffer,
  mimeType: string,
  seed: number | null,
  now: Date = new Date(),
): SavedImage {
  const dateDir = join(rootDir, dateDirName(now))
  mkdirSync(dateDir, { recursive: true })

  const ext = mimeType === 'image/webp' ? 'webp' : 'png'
  const seq = String(nextSequence(dateDir)).padStart(5, '0')
  const fileName = `${seq}-${seed === null ? 'noseed' : seed}.${ext}`
  const filePath = join(dateDir, fileName)

  writeFileSync(filePath, bytes)
  return { filePath, fileName, dateDir }
}
