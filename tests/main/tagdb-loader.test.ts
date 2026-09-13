import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { TagdbLoader, buildCompletionIndex, fillEntries } from '../../src/main/tagdb/loader'
import type { TagdbStatus } from '../../src/shared/ipc'
import { TAGDB_FILES } from '../../src/main/tagdb/paths'

function fixtureDir(content: unknown | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'tagdb-'))
  if (content !== null) {
    writeFileSync(join(dir, 'tags_index_v2.json'), JSON.stringify(content), 'utf-8')
  }
  return dir
}

const SAMPLE = {
  artists: [{ tag: 'wlop', count: 9000, zh: [], ja: [], en: ['wlop'], other: [], series: [] }],
  characters: [{ tag: 'hatsune_miku', count: 100, zh: ['初音未来'], ja: [], en: [], other: [], series: [] }],
  series: [{ tag: 'arknights', count: 50, zh: ['明日方舟'], ja: [], en: [], other: [], series: [] }],
  general: [{ tag: 'blue_hair', count: 800, zh: ['蓝发'], ja: [], en: [], other: [], series: [] }],
}

describe('fillEntries', () => {
  it('补齐真实数据里不存在的 zhFull / zhShort / zhNick', () => {
    const [e] = fillEntries([{ tag: 'x', count: 1, zh: [], ja: [], en: [], other: [], series: [] }])
    expect(e.zhFull).toEqual([])
    expect(e.zhShort).toEqual([])
    expect(e.zhNick).toEqual([])
  })

  it('入参不是数组时给空数组，不抛错', () => {
    expect(fillEntries(null)).toEqual([])
    expect(fillEntries({})).toEqual([])
  })

  it('数组元素本身不是对象时跳过，不产生 tag 为空串的垃圾条目', () => {
    const entries = fillEntries([
      'not an object',
      42,
      { tag: 'x', count: 1, zh: [], ja: [], en: [], other: [], series: [] },
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0].tag).toBe('x')
  })

  it('该是数组的字段却是字符串（如 { zh: "蓝发" }）时该字段退化成空数组，不让半个坏条目蒙混过关', () => {
    const [e] = fillEntries([
      { tag: 'x', count: 1, zh: '蓝发', ja: [], en: [], other: [], series: [] },
    ])
    expect(e.tag).toBe('x')
    expect(e.zh).toEqual([])
  })
})

describe('buildCompletionIndex', () => {
  const mk = (tag: string, extra: Record<string, string[]> = {}) => ({
    tag, count: 1, zh: [], zhFull: [], zhShort: [], zhNick: [],
    ja: [], en: [], other: [], series: [], ...extra,
  })

  it('每个词首都进桶 —— 不只是名字开头', () => {
    const idx = buildCompletionIndex([mk('blue_hair')])
    // foldForCompletion('blue_hair') === 'blue hair'，词首在 0 与 5
    expect(idx.get('bl')).toEqual([0])
    expect(idx.get('ha')).toEqual([0])
  })

  it('词中间不进桶', () => {
    const idx = buildCompletionIndex([mk('blue_hair')])
    expect(idx.get('ue')).toBeUndefined()
    expect(idx.get('ai')).toBeUndefined()
  })

  it('别名与译名也进桶', () => {
    const idx = buildCompletionIndex([mk('kitsunemimi', { zh: ['狐耳'], en: ['fox ears'] })])
    expect(idx.get('ki')).toEqual([0])
    expect(idx.get('fo')).toEqual([0])
    expect(idx.get('ea')).toEqual([0])
    expect(idx.get('狐耳')).toEqual([0])
  })

  it('同一条目在同一个桶里只出现一次', () => {
    // tag 与别名折叠后都是 'blue hair'，两次都产 'bl'
    const idx = buildCompletionIndex([mk('blue_hair', { en: ['blue hair'] })])
    expect(idx.get('bl')).toEqual([0])
  })

  it('不同条目落进同一个桶时都保留，按条目顺序', () => {
    const idx = buildCompletionIndex([mk('blue_hair'), mk('blonde_hair')])
    expect(idx.get('bl')).toEqual([0, 1])
  })

  it('空名字不产键，不抛错', () => {
    const idx = buildCompletionIndex([mk('', { en: [''] })])
    expect(idx.size).toBe(0)
  })
})

describe('TagdbLoader', () => {
  it('初始状态是 idle', () => {
    const l = new TagdbLoader(fixtureDir(SAMPLE), () => {})
    expect(l.status.state).toBe('idle')
    expect(l.categories).toBeNull()
  })

  it('加载成功后 ready，四类条目与索引都在', async () => {
    const l = new TagdbLoader(fixtureDir(SAMPLE), () => {})
    await l.load()
    expect(l.status.state).toBe('ready')
    expect(l.status.counts).toEqual({ artists: 1, characters: 1, series: 1, general: 1 })
    const c = l.categories!
    expect(c.artists.entries[0].tag).toBe('wlop')
    expect(c.general.index.entries).toHaveLength(1)
    // 两份索引都要建好。补全索引按词首建：'blue hair' 的词首是 0 与 5
    expect(c.general.completionIndex.get('bl')).toEqual([0])
    expect(c.general.completionIndex.get('ha')).toEqual([0])
  })

  it('文件不存在时是 missing，并写明是哪个文件 —— 不静默降级', async () => {
    const l = new TagdbLoader(fixtureDir(null), () => {})
    await l.load()
    expect(l.status.state).toBe('missing')
    expect(l.status.detail).toContain('tags_index_v2.json')
    expect(l.categories).toBeNull()
  })

  it('文件损坏时是 error，不是 missing —— 两种情形的处置不同', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagdb-'))
    writeFileSync(join(dir, 'tags_index_v2.json'), '{ 这不是 JSON', 'utf-8')
    const l = new TagdbLoader(dir, () => {})
    await l.load()
    expect(l.status.state).toBe('error')
    expect(l.categories).toBeNull()
  })

  it('状态变化会通知回调，且至少经过 loading → ready', async () => {
    const seen: TagdbStatus[] = []
    const l = new TagdbLoader(fixtureDir(SAMPLE), (s) => seen.push(s))
    await l.load()
    expect(seen.map((s) => s.state)).toContain('loading')
    expect(seen[seen.length - 1].state).toBe('ready')
  })

  it('重复调用 load 不会重复加载', async () => {
    const seen: string[] = []
    const l = new TagdbLoader(fixtureDir(SAMPLE), (s) => seen.push(s.state))
    await l.load()
    const n = seen.length
    await l.load()
    expect(seen.length).toBe(n)
  })

  it('文件读不了但存在时是 error，不是 missing —— 「找不到」会把人支到错误方向', async () => {
    // 造一个同名的**目录**：readFile 会失败，但 code 是 EISDIR 而非 ENOENT
    const dir = mkdtempSync(join(tmpdir(), 'tagdb-'))
    mkdirSync(join(dir, TAGDB_FILES.index))
    const l = new TagdbLoader(dir, () => {})
    await l.load()
    expect(l.status.state).toBe('error')
    expect(l.status.detail).toContain(TAGDB_FILES.index)
  })

  it('并发调用 load 时，两个调用者都等到真正加载完成', async () => {
    const l = new TagdbLoader(fixtureDir(SAMPLE), () => {})
    const first = l.load()          // 故意不 await
    await l.load()                  // 第二个调用者
    // 关键：第二个 await 返回时，加载必须**真的**完成了
    expect(l.status.state).toBe('ready')
    expect(l.categories).not.toBeNull()
    await first
  })

  it('文件能解析但四类全空时是 error —— 挂着 ready 会让补全静默失灵', async () => {
    const l = new TagdbLoader(fixtureDir({}), () => {})
    await l.load()
    expect(l.status.state).toBe('error')
    expect(l.categories).toBeNull()
    expect(l.status.detail).toContain('artists')
    expect(l.status.detail).toContain('characters')
    expect(l.status.detail).toContain('series')
    expect(l.status.detail).toContain('general')
  })

  it('只有一类为空时也是 error，不是「总量非零就 ready」—— 旧版 schema/文件截断只会让一类落空', async () => {
    const l = new TagdbLoader(fixtureDir({ ...SAMPLE, general: [] }), () => {})
    await l.load()
    expect(l.status.state).toBe('error')
    expect(l.categories).toBeNull()
    expect(l.status.detail).toContain('general')
    expect(l.status.detail).not.toContain('artists')
  })

  it('状态回调抛错时加载照常完成 —— 监听方的失败不该拖垮数据层', async () => {
    const l = new TagdbLoader(fixtureDir(SAMPLE), () => {
      throw new Error('Object has been destroyed')
    })
    await expect(l.load()).resolves.toBeUndefined()
    expect(l.status.state).toBe('ready')
    expect(l.categories).not.toBeNull()
  })
})
