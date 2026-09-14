import { mkdtempSync, readdirSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DiskTagCache, MemoryLruCache, tagCacheFileName } from '../../../src/main/danbooru/cache'

describe('MemoryLruCache', () => {
  it('未缓存过时返回 undefined', () => {
    const c = new MemoryLruCache<string, number>(2, 1000)
    expect(c.get('a')).toBeUndefined()
  })

  it('写入后能读回', () => {
    const c = new MemoryLruCache<string, number>(2, 1000)
    c.set('a', 1)
    expect(c.get('a')).toBe(1)
  })

  it('超过 TTL 后视为未命中', () => {
    let now = 0
    const c = new MemoryLruCache<string, number>(2, 1000, () => now)
    c.set('a', 1)
    now = 1001
    expect(c.get('a')).toBeUndefined()
  })

  it('未超过 TTL 时仍命中；恰好等于 TTL 视为过期', () => {
    let now = 0
    const c = new MemoryLruCache<string, number>(2, 1000, () => now)
    c.set('a', 1)
    now = 999
    expect(c.get('a')).toBe(1)
    now = 1000
    expect(c.get('a')).toBeUndefined()
  })

  it('超过容量时淘汰最久未被访问的键', () => {
    const c = new MemoryLruCache<string, number>(2, 1_000_000)
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3) // 触发淘汰：a 最久未被访问
    expect(c.get('b')).toBe(2)
    expect(c.get('c')).toBe(3)
    expect(c.get('a')).toBeUndefined()
  })

  it('get 命中会把键挪到最近端，之后不会被优先淘汰', () => {
    const c = new MemoryLruCache<string, number>(2, 1_000_000)
    c.set('a', 1)
    c.set('b', 2)
    c.get('a') // a 变成最近访问过的
    c.set('c', 3) // 该淘汰 b，而不是刚被访问过的 a
    expect(c.get('a')).toBe(1)
    expect(c.get('c')).toBe(3)
    expect(c.get('b')).toBeUndefined()
  })
})

describe('tagCacheFileName — 文件名生成', () => {
  it('正常 tag 生成的文件名只含安全字符', () => {
    const name = tagCacheFileName('wiki', 'some_artist')
    expect(name).toMatch(/^wiki-[0-9a-f]{64}\.json$/)
  })

  it('wiki 与 artist 两种前缀对同一个 tag 生成不同的文件名，不会互相覆盖', () => {
    expect(tagCacheFileName('wiki', 'x')).not.toBe(tagCacheFileName('artist', 'x'))
  })

  it('taginfo 前缀与 wiki、artist 互不撞名', () => {
    const a = tagCacheFileName('taginfo', 'long_hair')
    expect(a.startsWith('taginfo-')).toBe(true)
    expect(a).not.toBe(tagCacheFileName('wiki', 'long_hair'))
    expect(a).not.toBe(tagCacheFileName('artist', 'long_hair'))
  })

  // tag 来自渲染进程，IPC 是渲染进程可任意调用的边界，不能假设调用方老实——
  // 下面这组恶意输入必须生成同样只含安全字符的文件名，不能把 `../` 或路径
  // 分隔符原样带进结果里
  it.each([
    ['等于 ..', '..'],
    ['等于 .', '.'],
    ['含 .. 路径段', '../../../etc/passwd'],
    ['含正斜杠', 'a/b/c'],
    ['含反斜杠', 'a\\b\\c'],
    ['Windows 绝对路径', 'C:\\evil'],
    ['POSIX 绝对路径', '/etc/evil'],
    ['空字符串', ''],
  ])('恶意 tag（%s）生成的文件名不含路径分隔符或 ..', (_label, tag) => {
    const name = tagCacheFileName('wiki', tag)
    expect(name).toMatch(/^wiki-[0-9a-f]{64}\.json$/)
    expect(name).not.toMatch(/[/\\]/)
    expect(name).not.toContain('..')
  })
})

describe('DiskTagCache', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ast-danbooru-cache-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('写入后能读回', () => {
    const cache = new DiskTagCache<{ title: string }>('wiki', dir, 1000)
    cache.set('some_artist', { title: 'x' })
    expect(cache.get('some_artist')).toEqual({ title: 'x' })
  })

  it('未缓存过返回 undefined', () => {
    const cache = new DiskTagCache<{ title: string }>('wiki', dir, 1000)
    expect(cache.get('nope')).toBeUndefined()
  })

  it('缓存值为 null（已确认没有 wiki 条目）与「从未查过」可区分', () => {
    // wiki() 需要把 404 缓存成 null，代表「查过、确认没有」；这必须能跟
    // 「压根没缓存过」区分开，否则会被反复当成没查过再打一次请求
    const cache = new DiskTagCache<{ title: string } | null>('wiki', dir, 1000)
    cache.set('no_wiki_artist', null)
    expect(cache.get('no_wiki_artist')).toBeNull()
    expect(cache.get('never_queried')).toBeUndefined()
  })

  it('超过 TTL 后视为未命中', () => {
    let now = 0
    const cache = new DiskTagCache<{ v: number }>('wiki', dir, 1000, () => now)
    cache.set('a', { v: 1 })
    now = 1001
    expect(cache.get('a')).toBeUndefined()
  })

  it('未超过 TTL 时仍命中', () => {
    let now = 0
    const cache = new DiskTagCache<{ v: number }>('wiki', dir, 1000, () => now)
    cache.set('a', { v: 1 })
    now = 999
    expect(cache.get('a')).toEqual({ v: 1 })
  })

  // 边界语义要与 MemoryLruCache 一致（见 cache.ts 的类注释）：恰好等于 TTL
  // 视为过期，不能一个用 >、一个用 >=，否则两层缓存对同一个「刚好到期」的
  // 时刻会给出相反的答案
  it('恰好等于 TTL 视为过期（边界语义与 MemoryLruCache 一致）', () => {
    let now = 0
    const cache = new DiskTagCache<{ v: number }>('wiki', dir, 1000, () => now)
    cache.set('a', { v: 1 })
    now = 1000
    expect(cache.get('a')).toBeUndefined()
  })

  it('wiki 与 artist 两种缓存对同一个 tag 各自独立，互不覆盖', () => {
    const wikiCache = new DiskTagCache<{ kind: string }>('wiki', dir, 1000)
    const artistCache = new DiskTagCache<{ kind: string }>('artist', dir, 1000)
    wikiCache.set('same_tag', { kind: 'wiki' })
    artistCache.set('same_tag', { kind: 'artist' })
    expect(wikiCache.get('same_tag')).toEqual({ kind: 'wiki' })
    expect(artistCache.get('same_tag')).toEqual({ kind: 'artist' })
  })

  // 有效性验证见任务报告：临时把 tagCacheFileName 改回「不哈希、直接拼接
  // tag」，重跑本用例，file 落进了 dir 两级之外的真实目录（`join` 会把
  // `wiki-../../../evil` 前缀当成一层字面目录名，再被后续的 `..` 依次消耗、
  // 上溯），证明这里的哈希化不是摆设。恢复实现后重跑保持绿色
  it('恶意 tag 写入后，文件确实落在缓存目录内，不会逃逸到目录之外', () => {
    const cache = new DiskTagCache<{ v: number }>('wiki', dir, 1000)
    const maliciousTags = ['../../../evil', 'a/b/c', 'a\\b\\c', '..', '.', 'C:\\evil']

    for (const tag of maliciousTags) {
      cache.set(tag, { v: 1 })
    }

    // 断言长度在先：.every() 在空数组上恒为 true，不能只看后面的逐项断言
    const entries = readdirSync(dir)
    expect(entries).toHaveLength(maliciousTags.length)
    expect(entries.every((e) => /^wiki-[0-9a-f]{64}\.json$/.test(e))).toBe(true)
    // 逃逸如果发生，会以嵌套目录或额外顶层文件的形式表现；这里额外确认
    // 目录里没有任何子目录（哈希文件名不含分隔符，本来就不可能建出子目录）
    expect(entries.every((e) => statSync(join(dir, e)).isFile())).toBe(true)
  })
})
