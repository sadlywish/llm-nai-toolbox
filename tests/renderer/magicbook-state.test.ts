import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const TREE = {
  ok: true,
  total: 7,
  groups: [
    { top: '画面构成', n: 3, subs: [{ cat: '画面构成/image composition', sub: 'image composition', n: 3 }] },
    { top: '头发', n: 4, subs: [{ cat: '头发/hair styles', sub: 'hair styles', n: 3 }, { cat: '头发/hair color', sub: 'hair color', n: 1 }] },
  ],
}
const item = (t: string, cat: string) => ({ t, g: `${t} 的释义`, c: 1, cat, trap: false, vs: false })
const api = {
  magicbookTree: vi.fn(async () => TREE as unknown),
  magicbookList: vi.fn(async (cat: string) => ({ ok: true, items: [item(`first_of_${cat}`, cat)] }) as unknown),
  magicbookSearch: vi.fn(async (query: string, cat?: string) => ({
    ok: true,
    result: { total: 2, byCat: { '头发/hair styles': 1, '画面构成/image composition': 1 }, items: cat ? [item('only', cat)] : [item('a', '头发/hair styles'), item('b', '画面构成/image composition')] },
    query,
  }) as unknown),
  tagdbGloss: vi.fn(async (tag: string) => (tag === 'ahegao' ? { g: '表情', cat: '头发/hair styles' } : null) as unknown),
  tagdbLookup: vi.fn(async () => null as unknown),
  writeClipboardText: vi.fn(async () => undefined),
  danbooruTagInfo: vi.fn(async (tag: string) => ({ ok: true, tag: { name: tag, category: 0, postCount: 1 } })),
  danbooruWiki: vi.fn(async (tag: string) => ({ ok: true, wiki: { title: tag, body: 'b' } })),
  danbooruPosts: vi.fn(async () => ({ ok: true, posts: [] })),
}
vi.stubGlobal('window', { api })

async function fresh(): Promise<typeof import('../../src/renderer/src/state/magicbook')> {
  vi.resetModules()
  return import('../../src/renderer/src/state/magicbook')
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('init', () => {
  it('取树；展开第一组并打开它条数最多的一类；重复调用不再请求', async () => {
    const { useMagicBook } = await fresh()
    useMagicBook.getState().init()
    await vi.runAllTimersAsync()
    const s = useMagicBook.getState()
    expect(s.tree).toEqual({ status: 'ready', value: { groups: TREE.groups, total: 7 } })
    expect(s.expanded).toEqual(['画面构成'])
    expect(s.activeCat).toBe('画面构成/image composition')
    expect(api.magicbookList).toHaveBeenCalledWith('画面构成/image composition')
    expect(s.list).toEqual({ status: 'ready', value: [item('first_of_画面构成/image composition', '画面构成/image composition')] })
    useMagicBook.getState().init()
    expect(api.magicbookTree).toHaveBeenCalledTimes(1)
  })

  it('数据不可用：tree 是 error，带主进程给的说明', async () => {
    api.magicbookTree.mockResolvedValueOnce({ ok: false, detail: '找不到 tag_browse.json' })
    const { useMagicBook } = await fresh()
    useMagicBook.getState().init()
    await vi.runAllTimersAsync()
    expect(useMagicBook.getState().tree).toEqual({ status: 'error', message: '找不到 tag_browse.json' })
  })
})

describe('检索', () => {
  it('250ms 防抖后请求；进入检索记下原分类、切到全部命中；清空后回到原分类并重新取列表', async () => {
    const { useMagicBook } = await fresh()
    useMagicBook.getState().init()
    await vi.runAllTimersAsync()
    api.magicbookList.mockClear()
    useMagicBook.getState().setQuery('俯视')
    expect(useMagicBook.getState()).toMatchObject({ prevCat: '画面构成/image composition', activeCat: null, search: { status: 'loading' } })
    await vi.advanceTimersByTimeAsync(249)
    expect(api.magicbookSearch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await vi.runAllTimersAsync()
    expect(api.magicbookSearch).toHaveBeenCalledWith('俯视', undefined)
    expect(useMagicBook.getState().search?.status).toBe('ready')

    useMagicBook.getState().setQuery('')
    expect(useMagicBook.getState()).toMatchObject({ search: null, prevCat: null, activeCat: '画面构成/image composition' })
    expect(api.magicbookList).toHaveBeenCalledWith('画面构成/image composition')
  })

  it('检索中点分类：带分类重新请求，旧结果留着直到新结果回来', async () => {
    const { useMagicBook } = await fresh()
    useMagicBook.getState().setQuery('hair')
    await vi.runAllTimersAsync()
    let release: (v: unknown) => void = () => {}
    api.magicbookSearch.mockImplementationOnce(() => new Promise((r) => (release = r)) as never)
    useMagicBook.getState().openCat('头发/hair styles')
    expect(useMagicBook.getState().activeCat).toBe('头发/hair styles')
    expect(api.magicbookSearch).toHaveBeenLastCalledWith('hair', '头发/hair styles')
    expect(useMagicBook.getState().search?.status).toBe('ready')
    release({ ok: true, result: { total: 2, byCat: { '头发/hair styles': 1 }, items: [item('only', '头发/hair styles')] } })
    await vi.runAllTimersAsync()
    const s = useMagicBook.getState().search
    expect(s?.status === 'ready' && s.value.items.map((i) => i.t)).toEqual(['only'])
  })

  it('过期响应丢弃：先搜 a 再搜 b，a 晚回来不覆盖 b', async () => {
    let releaseA: (v: unknown) => void = () => {}
    api.magicbookSearch.mockImplementationOnce(() => new Promise((r) => (releaseA = r)) as never)
    const { useMagicBook } = await fresh()
    useMagicBook.getState().setQuery('a')
    await vi.advanceTimersByTimeAsync(250)
    useMagicBook.getState().setQuery('b')
    await vi.runAllTimersAsync()
    releaseA({ ok: true, result: { total: 99, byCat: {}, items: [] } })
    await vi.runAllTimersAsync()
    const s = useMagicBook.getState().search
    expect(s?.status === 'ready' && s.value.total).toBe(2)
  })
})

describe('选中、定位、复制', () => {
  it('select：词条初始化并并发取本地库、中文说明与 D 站', async () => {
    const { useMagicBook } = await fresh()
    useMagicBook.getState().select('Long Hair')
    expect(useMagicBook.getState().selected).toBe('long_hair')
    await vi.runAllTimersAsync()
    const e = useMagicBook.getState().entry!
    expect(e.tag).toBe('long_hair')
    expect(e.gloss).toEqual({ status: 'ready', value: null })
    expect(e.wiki.status).toBe('ready')
    expect(api.tagdbLookup).toHaveBeenCalledWith('long_hair')
  })

  it('locate：清空检索，选中该标签，按中文说明里的分类展开并打开那一类', async () => {
    const { useMagicBook } = await fresh()
    useMagicBook.getState().setQuery('俯视')
    await vi.runAllTimersAsync()
    useMagicBook.getState().locate('ahegao')
    await vi.runAllTimersAsync()
    const s = useMagicBook.getState()
    expect(s).toMatchObject({ query: '', search: null, selected: 'ahegao', activeCat: '头发/hair styles' })
    expect(s.expanded).toContain('头发')
    expect(api.magicbookList).toHaveBeenLastCalledWith('头发/hair styles')
  })

  it('copy：下划线换空格写剪贴板，「已复制」约 1.5 秒后消失', async () => {
    const { useMagicBook } = await fresh()
    useMagicBook.getState().copy('long_hair')
    await vi.advanceTimersByTimeAsync(0)
    expect(api.writeClipboardText).toHaveBeenCalledWith('long hair')
    expect(useMagicBook.getState().copied).toBe('long_hair')
    await vi.advanceTimersByTimeAsync(1500)
    expect(useMagicBook.getState().copied).toBeNull()
  })
})
