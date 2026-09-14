// 移植自画师串工具箱 src/main/danbooru/cache.ts；本项目加了 taginfo 一种磁盘缓存
import { createHash } from 'crypto'
import { join } from 'path'
import { JsonStore } from '../store'

/**
 * 内存 LRU + TTL 缓存（spec §13.3：补全结果、posts 各用一份，容量与 TTL 各自配置）。
 *
 * 用 Map 的插入顺序当 LRU 链表：命中时 delete 再 set 把该键挪到末尾（「最近」端），
 * 容量超限时淘汰 Map 里最靠前的（最久未被访问的）键，不必额外维护双向链表。
 */
export class MemoryLruCache<K, V> {
  private readonly store = new Map<K, { value: V; expiresAt: number }>()

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: K): V | undefined {
    const entry = this.store.get(key)
    if (entry === undefined) return undefined
    if (this.now() >= entry.expiresAt) {
      // 过期项顺手删掉而不是留着等下次 set 覆盖，避免过期键长期占着 LRU 名额
      this.store.delete(key)
      return undefined
    }
    this.store.delete(key)
    this.store.set(key, entry)
    return entry.value
  }

  set(key: K, value: V): void {
    this.store.delete(key)
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs })
    if (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value
      if (oldestKey !== undefined) this.store.delete(oldestKey)
    }
  }

  get size(): number {
    return this.store.size
  }
}

export type DiskCacheKind = 'wiki' | 'artist' | 'taginfo'

/**
 * wiki / artists 磁盘缓存的文件名（spec §13.3，TTL 7 天）。
 *
 * tag 来自渲染进程，IPC 是渲染进程可任意调用的边界，不能假设调用方老实——
 * 必须防住 `../`、路径分隔符这类穿越尝试，理由与计划 4 的读图通道一致。
 * 用哈希做文件名最省事：输出只含十六进制字符，天然不可能拼出穿越路径，
 * 不需要再额外维护一份「禁止字符」黑名单，顺带避开大小写不敏感文件系统上
 * `Foo`/`foo` 撞名的问题。`kind` 前缀区分 wiki 与 artist 两种缓存，
 * 避免同一个 tag 的两份数据落进同一个文件互相覆盖。
 */
export function tagCacheFileName(kind: DiskCacheKind, tag: string): string {
  const hash = createHash('sha256').update(tag, 'utf-8').digest('hex')
  return `${kind}-${hash}.json`
}

interface DiskEntry<T> {
  savedAt: number
  value: T
}

function isDiskEntry(v: unknown): boolean {
  return typeof v === 'object' && v !== null && 'savedAt' in v && typeof v.savedAt === 'number' && 'value' in v
}

/**
 * wiki / artists 的磁盘缓存。落盘复用 `JsonStore` 的原子写（先写 .tmp 再
 * rename），不另写一套，理由与计划 4 一致：这条写入路径没必要重新踩一遍
 * 「跑图中途崩溃留下半截文件」的坑。
 *
 * get() 返回 `T | undefined`：`undefined` 表示「没缓存或已过期」，
 * `T` 本身允许是 `null`（wiki 场景下 null 表示「已确认没有 wiki 条目」）——
 * 两者必须能区分，否则「查过一次、确认没有」会被当成「没查过」反复打请求。
 *
 * 过期判断用 `>=`（「已过去的时间达到 TTL」即算过期），与 `MemoryLruCache`
 * 同一套边界语义——两者原先一个用 `>` 一个用 `>=`，「恰好等于 TTL」时一个
 * 判命中一个判过期，排查「为什么内存缓存过期了磁盘还没过期」会白费一轮。
 */
export class DiskTagCache<T> {
  constructor(
    private readonly kind: DiskCacheKind,
    private readonly dir: string,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private storeFor(tag: string): JsonStore<DiskEntry<T> | null> {
    const file = join(this.dir, tagCacheFileName(this.kind, tag))
    return new JsonStore<DiskEntry<T> | null>(file, () => null, isDiskEntry)
  }

  get(tag: string): T | undefined {
    const entry = this.storeFor(tag).read()
    if (entry === null) return undefined
    if (this.now() - entry.savedAt >= this.ttlMs) return undefined
    return entry.value
  }

  set(tag: string, value: T): void {
    this.storeFor(tag).write({ savedAt: this.now(), value })
  }
}
