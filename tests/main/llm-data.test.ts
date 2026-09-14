import { describe, expect, it } from 'vitest'
import { defaultAppConfig } from '../../src/shared/config'
import type { LlmLogLine } from '../../src/shared/llm'
import type { TagdbStatus } from '../../src/shared/ipc'
import { parseBrowseDb } from '../../src/main/tagdb/browse'
import type { ExtraLoad } from '../../src/main/tagdb/extras'
import type { TagdbCategories } from '../../src/main/tagdb/loader'
import { needsWiki, prepareTagData, type ExtrasSource, type IndexSource } from '../../src/main/llm/data'
import { RunLog } from '../../src/main/llm/log'

const fail = <T>(detail: string): Promise<ExtraLoad<T>> => Promise.resolve({ ok: false, detail })
const ok = <T>(value: T, fresh = true): Promise<ExtraLoad<T>> => Promise.resolve({ ok: true, value, fresh })

function sources(over: Partial<ExtrasSource> = {}) {
  let wikiCalls = 0
  const extras: ExtrasSource = {
    browse: () => ok(parseBrowseDb({ 'a/b': [{ t: 'x', g: 'y', c: 1 }, { t: 'z', g: 'w', c: 1 }] })),
    gloss: () => ok(new Map([['smile', { g: '微笑' }]])),
    deprecated: () => fail('找不到 tag_deprecated.json，请把它放进 D'),
    characterFeatures: () => ok(new Map(), false),
    wiki: () => {
      wikiCalls++
      return ok(new Map([['x', 'y']]))
    },
    ...over,
  }
  return { extras, wikiCalls: () => wikiCalls }
}

/** 假索引：load 只计数；categories 用一个占位对象表示「已就绪」，本测试不会去读它的内容 */
interface FakeIndex extends IndexSource {
  loads: number
  status: TagdbStatus
  load(): Promise<void>
}

function index(status: TagdbStatus, categories: TagdbCategories | null): FakeIndex {
  const src: FakeIndex = {
    loads: 0,
    status,
    categories,
    load: async (): Promise<void> => {
      src.loads++
    },
  }
  return src
}

const READY: TagdbStatus = { state: 'ready', detail: '', counts: null }
const LOADED = {} as TagdbCategories

function logger() {
  const lines: LlmLogLine[] = []
  return { lines, texts: () => lines.map((l) => `[${l.level}] ${l.text}`), log: new RunLog((l) => lines.push(l)) }
}

describe('needsWiki', () => {
  it('四类任一打开「返回 wiki」就需要', () => {
    const base = { ...defaultAppConfig(), tagQueryCharacterWiki: false, tagQueryArtistWiki: false, tagQueryGeneralWiki: false, tagQuerySeriesWiki: false }
    expect(needsWiki(base)).toBe(false)
    expect(needsWiki({ ...base, tagQuerySeriesWiki: true })).toBe(true)
  })
})

describe('prepareTagData', () => {
  it('先等索引载入（载入中时写一行）；索引不可用时写明 search_tags 被摘掉及原因', async () => {
    const idx = index({ state: 'loading', detail: '正在加载', counts: null }, null)
    const loadThenMissing = idx.load
    idx.load = async () => {
      await loadThenMissing()
      idx.status = { state: 'missing', detail: '找不到 tags_index_v2.json', counts: null }
    }
    const { log, texts } = logger()
    const data = await prepareTagData(idx, sources().extras, defaultAppConfig(), log)
    expect(idx.loads).toBe(1)
    expect(data.categories).toBeNull()
    expect(texts()[0]).toBe('[I] 等待标签索引载入…')
    expect(texts()).toContain('[W] search_tags 已从工具集摘掉：找不到 tags_index_v2.json')
  })

  it('成功的只在第一次写「已加载」；失败的写明哪个功能不可用与原因', async () => {
    const { log, texts } = logger()
    const data = await prepareTagData(index(READY, LOADED), sources().extras, defaultAppConfig(), log)
    expect(data.categories).toBe(LOADED)
    expect(data.browse?.cats.size).toBe(1)
    expect(data.deprecated).toBeNull()
    expect(data.characters).not.toBeNull()
    expect(texts()).toContain('[I] 标签分类索引已加载: 1 类 2 条')
    expect(texts()).toContain('[I] 标签语义字典已加载: 1 条')
    expect(texts()).toContain('[W] 废弃标签提醒不可用：找不到 tag_deprecated.json，请把它放进 D')
    expect(texts().some((t) => t.includes('角色特征数据库已加载'))).toBe(false)
  })

  it('没开任何「返回 wiki」时不去读 tags_detail_v2.json', async () => {
    const s = sources()
    const config = {
      ...defaultAppConfig(),
      tagQueryCharacterWiki: false,
      tagQueryArtistWiki: false,
      tagQueryGeneralWiki: false,
      tagQuerySeriesWiki: false,
    }
    const data = await prepareTagData(index(READY, LOADED), s.extras, config, logger().log)
    expect(s.wikiCalls()).toBe(0)
    expect(data.wikiMap).toBeNull()
  })

  it('开了就读', async () => {
    const s = sources()
    const data = await prepareTagData(index(READY, LOADED), s.extras, defaultAppConfig(), logger().log)
    expect(s.wikiCalls()).toBe(1)
    expect(data.wikiMap?.get('x')).toBe('y')
  })
})
