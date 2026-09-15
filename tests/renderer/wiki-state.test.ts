import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
})

const api = {
  tagdbLookup: vi.fn(async (_tag: string) => null as unknown),
  tagdbComplete: vi.fn(async () => ({ ok: true, items: [] })),
  danbooruTagInfo: vi.fn(async (tag: string) => ({ ok: true, tag: { name: tag, category: 0, postCount: 100 } })),
  danbooruWiki: vi.fn(async (tag: string) => ({ ok: true, wiki: { title: tag, body: `body of ${tag}` } })),
  danbooruArtist: vi.fn(async (tag: string) => ({ ok: true, artist: { name: tag, otherNames: [], urls: [], isBanned: false, isDeleted: false } })),
  danbooruTags: vi.fn(async (input: { nameMatches: string }) => ({ ok: true, tags: [{ name: input.nameMatches, postCount: 25, category: 1 }] })),
  danbooruPosts: vi.fn(async () => ({ ok: true, posts: [{ id: 1, previewUrl: 'p', largeUrl: null, originalUrl: 'o' }] })),
  danbooruSearchArtistsByOtherName: vi.fn(async () => ({ ok: true, items: [] })),
  danbooruSearchArtistsByUrl: vi.fn(async () => ({ ok: true, items: [] })),
  tagdbGloss: vi.fn(async (tag: string) => (tag === 'ahoge' ? { g: '头顶翘起的一撮呆毛', trap: '与 ahegao 无关', cat: '头发/hair styles' } : null) as unknown),
}
vi.stubGlobal('window', { api })

async function freshStore(): Promise<typeof import('../../src/renderer/src/state/wiki')> {
  vi.resetModules()
  return import('../../src/renderer/src/state/wiki')
}

beforeEach(() => {
  store.clear()
  vi.clearAllMocks()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('持久化与默认值', () => {
  it('localStorage 空时：展开、跟随开、标签源', async () => {
    const { useWiki } = await freshStore()
    expect(useWiki.getState()).toMatchObject({ collapsed: false, followCursor: true, source: 'tag' })
  })

  it('读回已存的选择；切换时写回', async () => {
    store.set('wiki.collapsed', '1')
    store.set('wiki.follow-cursor', '0')
    store.set('wiki.source', 'artist')
    const { useWiki } = await freshStore()
    expect(useWiki.getState()).toMatchObject({ collapsed: true, followCursor: false, source: 'artist' })
    useWiki.getState().toggleCollapsed()
    expect(store.get('wiki.collapsed')).toBe('0')
  })
})

describe('跟随光标', () => {
  it('收起时不查本地库、不发任何请求（规格 R2）', async () => {
    store.set('wiki.collapsed', '1')
    const { useWiki } = await freshStore()
    useWiki.getState().onCursorWord('long hair', false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.tagdbLookup).not.toHaveBeenCalled()
    expect(api.danbooruWiki).not.toHaveBeenCalled()
  })

  it('跟随关闭时同样不发请求', async () => {
    store.set('wiki.follow-cursor', '0')
    const { useWiki } = await freshStore()
    useWiki.getState().onCursorWord('long hair', false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.danbooruWiki).not.toHaveBeenCalled()
  })

  it('400ms 防抖：连续移动只查最后一个词；同一个词不重复查', async () => {
    const { useWiki } = await freshStore()
    useWiki.getState().onCursorWord('a', false)
    await vi.advanceTimersByTimeAsync(200)
    useWiki.getState().onCursorWord('b', false)
    await vi.advanceTimersByTimeAsync(399)
    expect(api.danbooruWiki).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await vi.runAllTimersAsync()
    expect(api.danbooruWiki).toHaveBeenCalledTimes(1)
    expect(api.danbooruWiki).toHaveBeenCalledWith('b')
    useWiki.getState().onCursorWord('b', false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.danbooruWiki).toHaveBeenCalledTimes(1)
  })

  it('画师前缀或本地库分类为 artist → 画师源；否则标签源', async () => {
    const { useWiki } = await freshStore()
    useWiki.getState().onCursorWord('artist:wlop', true)
    await vi.runAllTimersAsync()
    expect(useWiki.getState().entry?.source).toBe('artist')
    expect(api.danbooruArtist).toHaveBeenCalledWith('wlop')

    api.tagdbLookup.mockResolvedValueOnce({ tag: 'ask', category: 'artist', zh: [], count: 5 })
    useWiki.getState().onCursorWord('ask', false)
    await vi.runAllTimersAsync()
    expect(useWiki.getState().entry).toMatchObject({ tag: 'ask', source: 'artist' })

    useWiki.getState().onCursorWord('long hair', false)
    await vi.runAllTimersAsync()
    expect(useWiki.getState().entry).toMatchObject({ tag: 'long_hair', source: 'tag' })
    expect(useWiki.getState().source).toBe('tag')
  })

  it('权重数字、强调括号先清掉；清完为空不查', async () => {
    const { useWiki } = await freshStore()
    useWiki.getState().onCursorWord('1.2', false)
    await vi.runAllTimersAsync()
    expect(api.tagdbLookup).not.toHaveBeenCalled()
    useWiki.getState().onCursorWord('{smile}', false)
    await vi.runAllTimersAsync()
    expect(useWiki.getState().entry?.tag).toBe('smile')
  })
})

describe('show：标签源', () => {
  it('并发取词条信息、正文、本地库、最新 6 张例图（不按评分排序）', async () => {
    api.tagdbLookup.mockResolvedValueOnce({ tag: 'long_hair', category: 'general', zh: ['长发'], count: 9 })
    const { useWiki } = await freshStore()
    useWiki.getState().show('Long Hair', 'tag')
    await vi.runAllTimersAsync()
    expect(api.danbooruPosts).toHaveBeenCalledTimes(1)
    expect(api.danbooruPosts).toHaveBeenCalledWith({ tag: 'long_hair', limit: 6, page: 1 })
    const e = useWiki.getState().entry!
    expect(e.tag).toBe('long_hair')
    expect(e.local).toEqual({ status: 'ready', value: { tag: 'long_hair', category: 'general', zh: ['长发'], count: 9 } })
    expect(e.tagInfo).toEqual({ status: 'ready', value: { name: 'long_hair', category: 0, postCount: 100 } })
    expect(e.wiki).toEqual({ status: 'ready', value: { title: 'long_hair', body: 'body of long_hair' } })
    expect(e.tagPosts.status).toBe('ready')
  })

  it('例图请求失败：只落在例图区块（error），不再重试', async () => {
    api.danbooruPosts.mockResolvedValueOnce({ ok: false, error: { kind: 'http', message: 'Danbooru 返回 500' } } as never)
    const { useWiki } = await freshStore()
    useWiki.getState().show('x', 'tag')
    await vi.runAllTimersAsync()
    expect(api.danbooruPosts).toHaveBeenCalledTimes(1)
    expect(useWiki.getState().entry?.tagPosts).toEqual({ status: 'error', message: 'Danbooru 返回 500' })
  })

  it('D 站失败只落在对应区块（error），其余照常', async () => {
    api.danbooruWiki.mockResolvedValueOnce({ ok: false, error: { kind: 'network', message: '网络错误：x' } } as never)
    const { useWiki } = await freshStore()
    useWiki.getState().show('x', 'tag')
    await vi.runAllTimersAsync()
    const e = useWiki.getState().entry!
    expect(e.wiki).toEqual({ status: 'error', message: '网络错误：x' })
    expect(e.tagInfo.status).toBe('ready')
  })

  it('过期结果丢弃：先查 a 再查 b，a 的正文晚回来也不覆盖 b', async () => {
    let releaseA: (v: unknown) => void = () => {}
    api.danbooruWiki.mockImplementationOnce(() => new Promise((r) => (releaseA = r)) as never)
    const { useWiki } = await freshStore()
    useWiki.getState().show('a', 'tag')
    useWiki.getState().show('b', 'tag')
    await vi.runAllTimersAsync()
    releaseA({ ok: true, wiki: { title: 'a', body: 'A' } })
    await vi.runAllTimersAsync()
    const e = useWiki.getState().entry!
    expect(e.tag).toBe('b')
    expect(e.wiki).toEqual({ status: 'ready', value: { title: 'b', body: 'body of b' } })
  })

  it('标签源同时取中文说明；没有说明时是 ready(null)', async () => {
    const { useWiki } = await freshStore()
    useWiki.getState().show('ahoge', 'tag')
    await vi.runAllTimersAsync()
    expect(api.tagdbGloss).toHaveBeenCalledWith('ahoge')
    expect(useWiki.getState().entry!.gloss).toEqual({
      status: 'ready',
      value: { g: '头顶翘起的一撮呆毛', trap: '与 ahegao 无关', cat: '头发/hair styles' },
    })
    useWiki.getState().show('long_hair', 'tag')
    await vi.runAllTimersAsync()
    expect(useWiki.getState().entry!.gloss).toEqual({ status: 'ready', value: null })
  })
})

describe('show：画师源', () => {
  it('例图等画师条目回来后用规范名取；按帖子数分档（25 张 / 每页 20 → 2 页，退化为 1、2、2 页）', async () => {
    api.danbooruArtist.mockResolvedValueOnce({ ok: true, artist: { name: 'manzai_sugar', otherNames: [], urls: [], isBanned: false, isDeleted: false } })
    const { useWiki } = await freshStore()
    useWiki.getState().show('Manzai Sugar', 'artist')
    await vi.runAllTimersAsync()
    expect(api.danbooruTags).toHaveBeenCalledWith({ nameMatches: 'manzai_sugar', limit: 10 })
    const pages = api.danbooruPosts.mock.calls.map((c) => (c as unknown as [{ page: number; tag: string }])[0])
    expect(pages.map((p) => p.page)).toEqual([1, 2, 2])
    expect(pages.every((p) => p.tag === 'manzai_sugar')).toBe(true)
    const e = useWiki.getState().entry!
    expect(e.artistPostCount).toBe(25)
    expect(e.bucketsCollapsed).toBe(true)
    expect(e.buckets?.map((b) => b.posts.status)).toEqual(['ready', 'ready', 'ready'])
  })

  it('画师源不取中文说明，gloss 恒为 ready(null)', async () => {
    const { useWiki } = await freshStore()
    useWiki.getState().show('wlop', 'artist')
    expect(useWiki.getState().entry!.gloss).toEqual({ status: 'ready', value: null })
    await vi.runAllTimersAsync()
    expect(api.tagdbGloss).not.toHaveBeenCalled()
  })
})

describe('切换数据源与搜索联想', () => {
  it('setSource 切换并按新源重查当前词', async () => {
    const { useWiki } = await freshStore()
    useWiki.getState().show('wlop', 'tag')
    await vi.runAllTimersAsync()
    useWiki.getState().setSource('artist')
    await vi.runAllTimersAsync()
    expect(useWiki.getState().entry).toMatchObject({ tag: 'wlop', source: 'artist' })
    expect(store.get('wiki.source')).toBe('artist')
  })

  it('标签源联想查本地库的一般/角色/作品三类；画师源查本地画师 + D 站别名，链接那一路只在像链接时发', async () => {
    const { useWiki } = await freshStore()
    useWiki.getState().setQuery('twin')
    await vi.advanceTimersByTimeAsync(250)
    await vi.runAllTimersAsync()
    const prefers = api.tagdbComplete.mock.calls.map((c) => (c as unknown as [{ prefer: string }])[0].prefer).sort()
    expect(prefers).toEqual(['character', 'general', 'series'])
    expect(api.tagdbComplete).toHaveBeenCalledWith({ query: 'twin', prefer: 'general', limit: 20, glossMax: 20 })
    expect(api.tagdbComplete).toHaveBeenCalledWith({ query: 'twin', prefer: 'character', limit: 20 })

    api.tagdbComplete.mockClear()
    useWiki.getState().setSource('artist')
    useWiki.getState().setQuery('wl')
    await vi.runAllTimersAsync()
    expect(api.tagdbComplete).toHaveBeenCalledWith({ query: 'wl', prefer: 'artist', limit: 20 })
    expect(api.danbooruSearchArtistsByOtherName).toHaveBeenCalledWith({ query: 'wl', limit: 20 })
    expect(api.danbooruSearchArtistsByUrl).not.toHaveBeenCalled()
    useWiki.getState().setQuery('pixiv.net/users/1')
    await vi.runAllTimersAsync()
    expect(api.danbooruSearchArtistsByUrl).toHaveBeenCalledTimes(1)
  })
})
