import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DanbooruClient, DanbooruClientOptions } from '../../../src/main/danbooru/client'
import {
  Gate,
  artistOtherNameLikeUrl,
  artistUrl,
  artistUrlMatchesUrl,
  createDanbooruClient,
  postsUrl,
  scheduleDispatchTimes,
  tagInfoUrl,
  tagsUrl,
  wikiUrl,
} from '../../../src/main/danbooru/client'

/** 造一个返回指定状态与文本体的假 fetch，与 nai/client.test.ts 的 fakeFetch 同思路 */
function fakeFetchRaw(status: number, text: string): typeof fetch {
  return (async () => new Response(text, { status })) as unknown as typeof fetch
}

function fakeFetchJson(status: number, body: unknown): typeof fetch {
  return fakeFetchRaw(status, JSON.stringify(body))
}

describe('请求头', () => {
  it('每个请求都带可识别的 User-Agent，否则会被 Cloudflare 挡成 403', async () => {
    // 实测：同一个 URL 不带 UA 返回 403 加一整页「Just a moment...」挑战页 HTML，
    // 带上返回 200。少了这个头，错误分类只能把它归成「403 + 一大段 HTML」，
    // 界面上显示一坨看不懂的东西，而真因（少一个请求头）完全指不出来
    const seen: Array<Record<string, string>> = []
    const spyFetch = (async (_url: string, init?: RequestInit) => {
      const h = init?.headers
      seen.push(h && !Array.isArray(h) && !(h instanceof Headers) ? { ...h } : {})
      return new Response('[]', { status: 200 })
    }) as unknown as typeof fetch

    await makeClient(spyFetch).tags('modare', 5)

    expect(seen).toHaveLength(1)
    const ua = seen[0]['User-Agent']
    expect(typeof ua).toBe('string')
    expect(ua.length).toBeGreaterThan(0)
    // 必须能认出是本工具：Danbooru 的 API 策略要求 UA 可识别，
    // 而通用的 node/undici 默认 UA 正是被挡的那一类
    expect(ua).toContain('llm-nai-toolbox')
  })
})

describe('认证（Basic 头；用户撞到匿名限流后配置 login+apiKey 提升额度）', () => {
  /** 造一个记录每次请求头的假 fetch，与「请求头」describe 里的写法同思路 */
  function spyingFetch(seen: Array<Record<string, string>>): typeof fetch {
    return (async (_url: string, init?: RequestInit) => {
      const h = init?.headers
      seen.push(h && !Array.isArray(h) && !(h instanceof Headers) ? { ...h } : {})
      return new Response('[]', { status: 200 })
    }) as unknown as typeof fetch
  }

  it('配了 login + apiKey 时，请求带 Authorization: Basic <正确的 base64> 头', async () => {
    const seen: Array<Record<string, string>> = []
    await makeClient(spyingFetch(seen), { login: 'alice', apiKey: 'secret-key' }).tags('modare', 5)

    expect(seen).toHaveLength(1)
    expect(seen[0].Authorization).toBe(`Basic ${Buffer.from('alice:secret-key').toString('base64')}`)
  })

  it('login、apiKey 都为空时不带 Authorization 头（现状不受影响）', async () => {
    const seen: Array<Record<string, string>> = []
    await makeClient(spyingFetch(seen)).tags('modare', 5)

    expect(seen).toHaveLength(1)
    expect('Authorization' in seen[0]).toBe(false)
  })

  it('只配了 login 没配 apiKey 时，同样不带 Authorization 头（半份凭据不生效）', async () => {
    const seen: Array<Record<string, string>> = []
    await makeClient(spyingFetch(seen), { login: 'alice' }).tags('modare', 5)

    expect(seen).toHaveLength(1)
    expect('Authorization' in seen[0]).toBe(false)
  })

  it('只配了 apiKey 没配 login 时，同样不带 Authorization 头（半份凭据不生效）', async () => {
    const seen: Array<Record<string, string>> = []
    await makeClient(spyingFetch(seen), { apiKey: 'secret-key' }).tags('modare', 5)

    expect(seen).toHaveLength(1)
    expect('Authorization' in seen[0]).toBe(false)
  })

  it('构造出来的 URL 里不含 apiKey 的任何片段（安全底线：key 走 Basic 头，绝不进 URL）', async () => {
    const seenUrls: string[] = []
    const urlSpy = (async (url: string) => {
      seenUrls.push(url)
      return new Response('[]', { status: 200 })
    }) as unknown as typeof fetch
    const c = makeClient(urlSpy, { login: 'alice', apiKey: 'secret-key' })

    // 五个端点各打一次，逐一确认没有一条 URL 带上 key
    await c.tags('modare', 5)
    await c.tags('a', 5)
    await c.wiki('a')
    await c.artist('a')
    await c.posts('a', 5, 1)

    expect(seenUrls).toHaveLength(5)
    for (const url of seenUrls) {
      expect(url).not.toContain('secret-key')
    }
  })
})

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ast-danbooru-client-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 默认关掉节流等待（bucketCapacity: Infinity，令牌桶永远有余量可用）与
 * 真实定时器（sleepImpl 直接 resolve），单独测节流的用例再自己覆盖这两项 */
function makeClient(fetchImpl: typeof fetch, over: Partial<DanbooruClientOptions> = {}): DanbooruClient {
  return createDanbooruClient({
    cacheDir: dir,
    fetchImpl,
    now: () => 0,
    sleepImpl: async () => {},
    bucketCapacity: Infinity,
    ...over,
  })
}

describe('URL 构造（spec §13 的表，逐字照抄参数名）', () => {
  it('画师列表：name_matches 后缀通配符 *，category=1，order=count', () => {
    const url = tagsUrl('as10', 20)
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://danbooru.donmai.us/tags.json')
    expect(u.searchParams.get('search[name_matches]')).toBe('as10*')
    expect(u.searchParams.get('search[category]')).toBe('1')
    expect(u.searchParams.get('search[order]')).toBe('count')
    expect(u.searchParams.get('limit')).toBe('20')
  })

  it('wiki：tag 编码后放进路径，而不是查询串', () => {
    expect(wikiUrl('foo')).toBe('https://danbooru.donmai.us/wiki_pages/foo.json')
  })

  it('wiki：带斜杠的 tag 编码后不会打到别的路径上', () => {
    const url = wikiUrl('foo/bar')
    // 不编码的话会变成 /wiki_pages/foo/bar.json——多出一层不存在的路径
    expect(url).toBe('https://danbooru.donmai.us/wiki_pages/foo%2Fbar.json')
    expect(url).not.toContain('/wiki_pages/foo/bar')
  })

  it('wiki：带 artist: 前缀的 tag 冒号也被编码', () => {
    const url = wikiUrl('artist:foo')
    expect(url).toBe('https://danbooru.donmai.us/wiki_pages/artist%3Afoo.json')
  })

  it('artist：search[name] 编码', () => {
    const url = artistUrl('foo bar')
    expect(new URL(url).searchParams.get('search[name]')).toBe('foo bar')
  })

  it('artist：带 only= 一次性要回 urls/is_banned/is_deleted（spec §13.0，避免再打一次 /artist_urls.json）', () => {
    const url = artistUrl('foo')
    const only = new URL(url).searchParams.get('only')
    expect(only).not.toBeNull()
    // 逐个断言字段名而不是断言整串字面量，免得跟字段顺序这种实现细节绑死
    for (const field of ['id', 'name', 'other_names', 'urls', 'is_banned', 'is_deleted']) {
      expect(only?.split(',')).toContain(field)
    }
  })

  it('按别名检索：search[any_other_name_like] 前后包裹通配符，只回精简字段（实测 *tang73* 命中 manzai_sugar）', () => {
    const url = artistOtherNameLikeUrl('tang73', 20)
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://danbooru.donmai.us/artists.json')
    expect(u.searchParams.get('search[any_other_name_like]')).toBe('*tang73*')
    expect(u.searchParams.get('limit')).toBe('20')
    const only = u.searchParams.get('only')
    for (const field of ['id', 'name', 'other_names', 'urls']) {
      expect(only?.split(',')).toContain(field)
    }
  })

  it('按别名检索：查询词里的特殊字符编码后能还原（通配符包裹不破坏编码）', () => {
    const url = artistOtherNameLikeUrl('a b&c/d', 10)
    // 断言解码后等于「通配符包裹原值」，而不是拼字面量——同上面 query 编码
    // 测试的理由一致，不该跟编码实现细节（%2F 还是 /）绑死
    expect(new URL(url).searchParams.get('search[any_other_name_like]')).toBe('*a b&c/d*')
  })

  it('按链接检索：search[url_matches] 前后包裹通配符（实测 *pixiv.net/users/14730603* 命中 manzai_sugar，且确认支持通配符）', () => {
    const url = artistUrlMatchesUrl('pixiv.net/users/14730603', 20)
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://danbooru.donmai.us/artists.json')
    expect(u.searchParams.get('search[url_matches]')).toBe('*pixiv.net/users/14730603*')
    expect(u.searchParams.get('limit')).toBe('20')
  })

  it('按链接检索：用户输入里本来就带的 * 按字面处理，不转义', () => {
    // spec 明确：通配符包裹由客户端加，用户输入里已有的 * 不做特殊处理——
    // 它本来就是 Danbooru 通配语法的一部分
    const url = artistUrlMatchesUrl('*.pixiv.net', 10)
    expect(new URL(url).searchParams.get('search[url_matches]')).toBe('**.pixiv.net*')
  })

  it('posts：tags/limit/page 齐全，且 tag 的空格归一为下划线', () => {
    const url = postsUrl('foo bar', 5, 2)
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://danbooru.donmai.us/posts.json')
    // 这里曾经断言原样透传 'foo bar'——那正是 bug 本身：`tags=` 里的空格是
    // 「多个 tag 之间的分隔符」，`tags=manzai sugar` 的语义是「同时含 manzai
    // 和 sugar 两个 tag」，实测返回 0 条。而画师条目那边一切正常，
    // 表现就是「这个画师明明有图，例图却一张不显示」
    expect(u.searchParams.get('tags')).toBe('foo_bar')
    expect(u.searchParams.get('limit')).toBe('5')
    expect(u.searchParams.get('page')).toBe('2')
  })

  it('wiki / tags 的 tag 同样归一，三处用的是同一套规则', () => {
    expect(wikiUrl('manzai sugar')).toContain('/wiki_pages/manzai_sugar.json')
    expect(new URL(tagsUrl('manzai sugar', 5)).searchParams.get('search[name_matches]')).toBe(
      'manzai_sugar*',
    )
    expect(new URL(postsUrl('manzai sugar', 5, 1)).searchParams.get('tags')).toBe('manzai_sugar')
  })
})

describe('错误分类（与 NAI 客户端同规矩：永远返回结果对象，永不 reject）', () => {
  it('网络异常归为 network', async () => {
    const boom = (async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch
    const r = await makeClient(boom).wiki('foo')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('network')
  })

  it('超时归为 timeout', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const slow = (async () => {
      throw abortErr
    }) as unknown as typeof fetch
    const r = await makeClient(slow).artist('foo')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('timeout')
  })

  it('非 200（且非 wiki 的 404）状态码归为 http，带响应体前缀', async () => {
    const r = await makeClient(fakeFetchRaw(500, 'server exploded')).tags('foo', 20)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe('http')
      expect(r.error.message).toContain('server exploded')
    }
  })

  it('JSON 解析失败归为 invalid', async () => {
    const r = await makeClient(fakeFetchRaw(200, '不是 json')).tags('modare', 5)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('invalid')
  })

  it('响应形状不符（不是数组）归为 invalid', async () => {
    const r = await makeClient(fakeFetchJson(200, { not: 'an array' })).posts('foo', 20, 1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('invalid')
  })

  it('响应头已到但 body 流中途断开时归为 network，而不是让 promise reject', async () => {
    const brokenResponse = {
      ok: true,
      status: 200,
      text: () => Promise.reject(new Error('stream aborted')),
    } as unknown as Response
    const brokenFetch = (async () => brokenResponse) as unknown as typeof fetch
    const r = await makeClient(brokenFetch).wiki('foo')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('network')
  })

  it.each([
    ['tags-nameMatches 空串', (c: DanbooruClient) => c.tags('', 10)],
    ['tags-nameMatches 非字符串', (c: DanbooruClient) => c.tags(42 as unknown as string, 10)],
    ['wiki-tag 空串', (c: DanbooruClient) => c.wiki('')],
    ['wiki-tag 非字符串', (c: DanbooruClient) => c.wiki(42 as unknown as string)],
    ['artist-tag 非字符串', (c: DanbooruClient) => c.artist(42 as unknown as string)],
    ['posts-limit 不合法', (c: DanbooruClient) => c.posts('foo', -1, 1)],
    ['posts-tag 非字符串', (c: DanbooruClient) => c.posts(42 as unknown as string, 10, 1)],
    ['按别名检索-query 空串', (c: DanbooruClient) => c.searchArtistsByOtherName('', 20)],
    [
      '按别名检索-query 非字符串',
      (c: DanbooruClient) => c.searchArtistsByOtherName(42 as unknown as string, 20),
    ],
    ['按别名检索-limit 不合法', (c: DanbooruClient) => c.searchArtistsByOtherName('a', 0)],
    ['按链接检索-query 空串', (c: DanbooruClient) => c.searchArtistsByUrl('', 20)],
    ['按链接检索-limit 不合法', (c: DanbooruClient) => c.searchArtistsByUrl('a', -1)],
  ])('%s：非法入参直接返回 invalid，不发请求（IPC 边界不保证调用方老实）', async (_label, call) => {
    let called = false
    const spy = (async () => {
      called = true
      return new Response('[]', { status: 200 })
    }) as unknown as typeof fetch
    const r = await call(makeClient(spy))
    expect(called).toBe(false)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('invalid')
  })
})

describe('tags（内存 LRU，与检索同一档 TTL 10 分钟；跟随光标来回移动会反复取同一 tag 的 post_count）', () => {
  it('解析画师列表', async () => {
    const body = [{ name: 'as109', post_count: 42, category: 1 }]
    const r = await makeClient(fakeFetchJson(200, body)).tags('as10', 20)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.tags).toEqual([{ name: 'as109', postCount: 42, category: 1 }])
  })

  it('二次调用命中内存 LRU，不再发请求', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response(JSON.stringify([{ name: 'a', post_count: 1, category: 1 }]), { status: 200 })
    }) as unknown as typeof fetch
    const c = makeClient(fetchImpl)
    await c.tags('a', 20)
    await c.tags('a', 20)
    expect(calls).toBe(1)
  })

  it('超过 10 分钟 TTL 后重新发请求', async () => {
    let calls = 0
    let now = 0
    const fetchImpl = (async () => {
      calls++
      return new Response(JSON.stringify([{ name: 'a', post_count: 1, category: 1 }]), { status: 200 })
    }) as unknown as typeof fetch
    const c = makeClient(fetchImpl, { now: () => now })
    await c.tags('a', 20)
    now = 10 * 60 * 1000 + 1
    await c.tags('a', 20)
    expect(calls).toBe(2)
  })

  it('limit 不同不会互相命中缓存（同检索缓存键漏 limit 的教训）', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response(JSON.stringify([{ name: 'a', post_count: 1, category: 1 }]), { status: 200 })
    }) as unknown as typeof fetch
    const c = makeClient(fetchImpl)
    await c.tags('a', 10)
    await c.tags('a', 20)
    expect(calls).toBe(2)
  })
})

describe('wiki（磁盘缓存，TTL 7 天）', () => {
  it('200 时解析 title/body', async () => {
    const r = await makeClient(fakeFetchJson(200, { title: 'Foo', body: 'body text' })).wiki('foo')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.wiki).toEqual({ title: 'Foo', body: 'body text' })
  })

  it('404 时返回 wiki: null（不是错误，是 spec §13 表里回退到 artists.json 的信号）', async () => {
    const r = await makeClient(fakeFetchRaw(404, '')).wiki('nobody')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.wiki).toBeNull()
  })

  it('200 但 body 是空串时也归一为 wiki: null（spec §13：「为空」包含 404 与空 body 两种，对用户没区别）', async () => {
    const r = await makeClient(fakeFetchJson(200, { title: 'Foo', body: '' })).wiki('empty_body')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.wiki).toBeNull()
  })

  it('body 是纯空白字符时同样归一为 wiki: null（trim 后为空）', async () => {
    const r = await makeClient(fakeFetchJson(200, { title: 'Foo', body: '   \n  ' })).wiki('blank_body')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.wiki).toBeNull()
  })

  it('body 非空白时不受影响，正常返回', async () => {
    const r = await makeClient(fakeFetchJson(200, { title: 'Foo', body: '  正文  ' })).wiki('real')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.wiki).toEqual({ title: 'Foo', body: '  正文  ' })
  })

  it('二次调用命中磁盘缓存，不再发请求；确认过没有 wiki 的结果也会被缓存', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch
    const c = makeClient(fetchImpl)
    const r1 = await c.wiki('nobody')
    const r2 = await c.wiki('nobody')
    expect(calls).toBe(1)
    expect(r1.ok && r1.wiki).toBeNull()
    expect(r2.ok && r2.wiki).toBeNull()
  })

  it('body 为空串归一后的结果同样被缓存，不再发请求', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response(JSON.stringify({ title: 'Foo', body: '' }), { status: 200 })
    }) as unknown as typeof fetch
    const c = makeClient(fetchImpl)
    await c.wiki('empty_body')
    await c.wiki('empty_body')
    expect(calls).toBe(1)
  })

  it('超过 7 天 TTL 后重新发请求', async () => {
    let calls = 0
    let now = 0
    const fetchImpl = (async () => {
      calls++
      return new Response(JSON.stringify({ title: 'a', body: 'b' }), { status: 200 })
    }) as unknown as typeof fetch
    const c = makeClient(fetchImpl, { now: () => now })
    await c.wiki('foo')
    now = 7 * 24 * 60 * 60 * 1000 + 1
    await c.wiki('foo')
    expect(calls).toBe(2)
  })
})

describe('artist（磁盘缓存；spec §13.0：画师条目是画师 TAG 的主数据源，不是 wiki 的回退）', () => {
  it('查到画师时取 other_names、urls（含 is_active 为 true 的）与 is_banned/is_deleted', async () => {
    const body = [
      {
        name: 'foo',
        other_names: ['bar', 123, 'baz'],
        urls: [
          { url: 'https://example.com/a', is_active: true },
          { not_url: 'x' },
          { url: 'https://example.com/b', is_active: true },
        ],
        is_banned: true,
        is_deleted: false,
      },
    ]
    const r = await makeClient(fakeFetchJson(200, body)).artist('foo')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.artist).toEqual({
      name: 'foo',
      otherNames: ['bar', 'baz'],
      urls: ['https://example.com/a', 'https://example.com/b'],
      isBanned: true,
      isDeleted: false,
    })
  })

  it('urls 里 is_active: false 的链接是已失效的，过滤掉不展示死链（实测 haku89 案例：urls 是对象数组，含 is_active）', async () => {
    const body = [
      {
        name: 'foo',
        other_names: [],
        urls: [
          { url: 'https://example.com/active', is_active: true },
          { url: 'https://example.com/dead', is_active: false },
        ],
      },
    ]
    const r = await makeClient(fakeFetchJson(200, body)).artist('foo')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.artist?.urls).toHaveLength(1)
    expect(r.artist?.urls).toEqual(['https://example.com/active'])
  })

  it('urls 里 is_active 字段缺失时按有效处理（宁可多显示，也不因为字段将来消失就整体不见）', async () => {
    const body = [{ name: 'foo', other_names: [], urls: [{ url: 'https://example.com/a' }] }]
    const r = await makeClient(fakeFetchJson(200, body)).artist('foo')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.artist?.urls).toEqual(['https://example.com/a'])
  })

  it('空数组表示没有该画师条目，artist 为 null（不是错误）', async () => {
    const r = await makeClient(fakeFetchJson(200, [])).artist('nobody')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.artist).toBeNull()
  })

  it('响应里没有 urls 字段时安全降级为没有链接，而不是报错（字段名终究可能随 Danbooru 版本变化，见 client.ts 注释）', async () => {
    const body = [{ name: 'foo', other_names: [] }]
    const r = await makeClient(fakeFetchJson(200, body)).artist('foo')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.artist).not.toBeNull()
    expect(r.artist?.urls).toHaveLength(0)
    expect(r.artist?.urls).toEqual([])
  })

  it('urls 字段存在但不是数组时同样安全降级为没有链接，而不是报错', async () => {
    const body = [{ name: 'foo', other_names: [], urls: 'not-an-array' }]
    const r = await makeClient(fakeFetchJson(200, body)).artist('foo')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.artist).not.toBeNull()
    expect(r.artist?.urls).toHaveLength(0)
    expect(r.artist?.urls).toEqual([])
  })

  it('is_banned/is_deleted 字段缺失时默认为 false', async () => {
    const body = [{ name: 'foo', other_names: [] }]
    const r = await makeClient(fakeFetchJson(200, body)).artist('foo')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.artist?.isBanned).toBe(false)
    expect(r.artist?.isDeleted).toBe(false)
  })

  it('is_deleted 为 true 时能正确读出', async () => {
    const body = [{ name: 'foo', other_names: [], is_banned: false, is_deleted: true }]
    const r = await makeClient(fakeFetchJson(200, body)).artist('foo')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.artist?.isDeleted).toBe(true)
  })
})

describe('searchArtistsByOtherName / searchArtistsByUrl（画师预览搜索框的别名/链接两路检索）', () => {
  it('按别名检索：解析出多条，other_names/urls 的过滤规则与 artist() 一致（is_active:false 的链接被滤掉）', async () => {
    const body = [
      {
        name: 'manzai_sugar',
        other_names: ['tang7390', 123, '满载SUGAR'],
        urls: [
          { url: 'https://example.com/active', is_active: true },
          { url: 'https://example.com/dead', is_active: false },
        ],
      },
      { name: 'other_artist', other_names: [], urls: [] },
    ]
    const r = await makeClient(fakeFetchJson(200, body)).searchArtistsByOtherName('tang73', 20)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.items).toHaveLength(2)
    expect(r.items[0]).toEqual({
      name: 'manzai_sugar',
      otherNames: ['tang7390', '满载SUGAR'],
      urls: ['https://example.com/active'],
    })
  })

  it('按链接检索：同样的解析规则，空数组表示没有命中（不是错误）', async () => {
    const r = await makeClient(fakeFetchJson(200, [])).searchArtistsByUrl('nobody.example.com/x', 20)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.items).toHaveLength(0)
    expect(r.items).toEqual([])
  })

  it('响应里缺 name 字段的条目被跳过，不因为一条形状不对就让整批查询失败', async () => {
    const body = [{ other_names: [] }, { name: 'foo', other_names: [] }]
    const r = await makeClient(fakeFetchJson(200, body)).searchArtistsByOtherName('foo', 20)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.items).toHaveLength(1)
    expect(r.items[0].name).toBe('foo')
  })

  it('非 200 归为 http，JSON 解析失败归为 invalid——与其余端点同一套错误分类', async () => {
    const httpErr = await makeClient(fakeFetchRaw(500, 'boom')).searchArtistsByOtherName('a', 20)
    expect(httpErr.ok).toBe(false)
    if (!httpErr.ok) expect(httpErr.error.kind).toBe('http')

    const invalidErr = await makeClient(fakeFetchRaw(200, '不是 json')).searchArtistsByUrl('a', 20)
    expect(invalidErr.ok).toBe(false)
    if (!invalidErr.ok) expect(invalidErr.error.kind).toBe('invalid')
  })

  it('二次调用命中内存 LRU，不再发请求（与检索同一档 10 分钟 TTL）', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response(JSON.stringify([{ name: 'a', other_names: [], urls: [] }]), { status: 200 })
    }) as unknown as typeof fetch
    const c = makeClient(fetchImpl)
    await c.searchArtistsByOtherName('a', 20)
    await c.searchArtistsByOtherName('a', 20)
    expect(calls).toBe(1)
  })

  it('别名、链接两路即便查询词相同也不会互相命中缓存——缓存键必须带维度前缀', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response(JSON.stringify([{ name: 'a', other_names: [], urls: [] }]), { status: 200 })
    }) as unknown as typeof fetch
    const c = makeClient(fetchImpl)
    await c.searchArtistsByOtherName('same-query', 20)
    await c.searchArtistsByUrl('same-query', 20)
    expect(calls).toBe(2)
  })
})

describe('posts（内存缓存，TTL 30 分钟）', () => {
  it('preview_file_url 缺失时保留 null，交给渲染层回退到 largeUrl（spec §13.1）', async () => {
    const body = [
      {
        id: 1,
        preview_file_url: 'https://cdn/a.jpg',
        large_file_url: 'https://cdn/a-large.jpg',
        file_url: 'https://cdn/a-original.jpg',
      },
      { id: 2, large_file_url: 'https://cdn/b-large.jpg' },
    ]
    const r = await makeClient(fakeFetchJson(200, body)).posts('foo', 20, 1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.posts).toHaveLength(2)
    expect(r.posts[1]).toEqual({
      id: 2,
      previewUrl: null,
      largeUrl: 'https://cdn/b-large.jpg',
      originalUrl: null,
    })
  })

  it('file_url 存在时取到 originalUrl——它是未压缩原图，largeUrl 只是压缩过的 sample', async () => {
    const body = [
      {
        id: 1,
        preview_file_url: 'https://cdn/a.jpg',
        large_file_url: 'https://cdn/a-large.jpg',
        file_url: 'https://cdn/a-original.jpg',
      },
    ]
    const r = await makeClient(fakeFetchJson(200, body)).posts('foo', 20, 1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.posts).toHaveLength(1)
    expect(r.posts[0]).toEqual({
      id: 1,
      previewUrl: 'https://cdn/a.jpg',
      largeUrl: 'https://cdn/a-large.jpg',
      originalUrl: 'https://cdn/a-original.jpg',
    })
  })

  it('file_url 非字符串（如 null）时 originalUrl 为 null，不当成解析失败', async () => {
    const body = [{ id: 1, large_file_url: 'https://cdn/a-large.jpg', file_url: null }]
    const r = await makeClient(fakeFetchJson(200, body)).posts('foo', 20, 1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.posts).toHaveLength(1)
    expect(r.posts[0].originalUrl).toBeNull()
  })

  it('同一 tag 同一 page 命中缓存；换 page 不命中', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response(JSON.stringify([{ id: 1 }]), { status: 200 })
    }) as unknown as typeof fetch
    const c = makeClient(fetchImpl)
    await c.posts('foo', 20, 1)
    await c.posts('foo', 20, 1)
    await c.posts('foo', 20, 2)
    expect(calls).toBe(2)
  })

  it('超过 30 分钟 TTL 后重新发请求', async () => {
    let calls = 0
    let now = 0
    const fetchImpl = (async () => {
      calls++
      return new Response(JSON.stringify([{ id: 1 }]), { status: 200 })
    }) as unknown as typeof fetch
    const c = makeClient(fetchImpl, { now: () => now })
    await c.posts('foo', 20, 1)
    now = 30 * 60 * 1000 + 1
    await c.posts('foo', 20, 1)
    expect(calls).toBe(2)
  })
})

describe('scheduleDispatchTimes（令牌桶排队的纯逻辑，spec §13.3：容量 6，每 1000ms 回补 1 个）', () => {
  it('空数组返回空数组', () => {
    expect(scheduleDispatchTimes([], 6, 1000)).toEqual([])
  })

  it('冷启动连发 6 个（不超过容量）全部立即发出，间隔为 0——这正是令牌桶相对刚性间隔的意义所在', () => {
    const dispatches = scheduleDispatchTimes([0, 0, 0, 0, 0, 0], 6, 1000)
    expect(dispatches).toHaveLength(6)
    expect(dispatches).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('第 7 个请求超出容量，要等到第一个令牌回补（约 1000ms 之后）', () => {
    const dispatches = scheduleDispatchTimes([0, 0, 0, 0, 0, 0, 0], 6, 1000)
    expect(dispatches).toHaveLength(7)
    expect(dispatches).toEqual([0, 0, 0, 0, 0, 0, 1000])
  })

  it('持续高频到达（连发 20 个）时，超出容量的部分严格按回补间隔排开，长期速率收敛到 1/秒', () => {
    const dispatches = scheduleDispatchTimes(new Array(20).fill(0) as number[], 6, 1000)
    expect(dispatches).toHaveLength(20)
    // 前 6 个吃的是冷启动的满桶，立即发出
    expect(dispatches.slice(0, 6)).toEqual([0, 0, 0, 0, 0, 0])
    // 第 7 个之后每一个都恰好比前一个晚 1000ms——长期均值 1/秒
    for (let i = 6; i < dispatches.length; i++) {
      expect(dispatches[i] - dispatches[i - 1]).toBe(1000)
    }
    // 第 20 个（下标 19）：容量 6 之外还有 14 个请求，each 隔 1000ms
    expect(dispatches[19]).toBe(14_000)
  })

  it('空闲很久之后令牌桶回补但不超过容量——空闲 1 小时后仍只能突发 6 个，不会攒出几千个', () => {
    // 先打满一次容量耗光令牌，空闲 1 小时后再来一批 7 个请求
    const arrivals = [0, 0, 0, 0, 0, 0, ...new Array(7).fill(3_600_000)] as number[]
    const dispatches = scheduleDispatchTimes(arrivals, 6, 1000)
    expect(dispatches).toHaveLength(13)
    // 空闲期间回补的令牌被容量 6 封顶：这一批里前 6 个立即发出
    expect(dispatches.slice(6, 12)).toEqual(new Array(6).fill(3_600_000))
    // 第 7 个（超出回补上限）仍要再等 1000ms，证明没有攒出 3600 个令牌
    expect(dispatches[12]).toBe(3_600_000 + 1000)
  })

  it('单个请求总是在到达时立即发出，不受历史状态影响（每次调用都是全新的满桶）', () => {
    expect(scheduleDispatchTimes([1000], 6, 1000)).toEqual([1000])
  })

  it('参数可任意配置（非生产默认值）：超出容量后仍按对应的回补间隔顺延，顺延会累积', () => {
    const arrivals = [0, 0, 0, 0, 0]
    const dispatches = scheduleDispatchTimes(arrivals, 2, 300)
    expect(dispatches).toHaveLength(5)
    // 前 2 个吃满容量立即发出，之后每一个都比前一个至少晚 300ms
    expect(dispatches.slice(0, 2)).toEqual([0, 0])
    for (let i = 2; i < dispatches.length; i++) {
      expect(dispatches[i] - dispatches[i - 1]).toBeGreaterThanOrEqual(300)
    }
  })
})

describe('Gate（运行期节流：包一层真实等待的令牌桶）', () => {
  it('按到达时刻调用时，实际等待的时长与 scheduleDispatchTimes 算出的一致', async () => {
    const arrivals = [0, 0, 0, 0, 0, 0, 0, 1000]
    const recordedDelays: number[] = []
    let now = 0
    const gate = new Gate(
      6,
      1000,
      () => now,
      async (ms) => {
        recordedDelays.push(ms)
      },
    )
    for (const t of arrivals) {
      now = t
      await gate.wait()
    }
    const dispatches = scheduleDispatchTimes(arrivals, 6, 1000)
    const expectedDelays = dispatches
      .map((d, i) => d - arrivals[i])
      .filter((d) => d > 0) // 只有需要等待时才会调用注入的 sleep
    expect(recordedDelays).toEqual(expectedDelays)
  })

  it('容量以内（令牌充足）时不调用 sleep', async () => {
    let sleepCalls = 0
    let now = 0
    const gate = new Gate(6, 1000, () => now, async () => {
      sleepCalls++
    })
    for (let i = 0; i < 6; i++) {
      await gate.wait()
    }
    now = 1000
    await gate.wait()
    expect(sleepCalls).toBe(0)
  })

  it('超出容量的下一次调用要等待回补', async () => {
    let sleepCalls = 0
    const delays: number[] = []
    const now = 0 // 固定时钟：6 次之内都不该等待，第 7 次必须等待
    const gate = new Gate(6, 1000, () => now, async (ms) => {
      sleepCalls++
      delays.push(ms)
    })
    for (let i = 0; i < 6; i++) {
      await gate.wait()
    }
    await gate.wait()
    expect(sleepCalls).toBe(1)
    expect(delays).toEqual([1000])
  })
})

describe('全局节流：不同端点共用同一个令牌桶', () => {
  it('A 端点连续两次调用耗光令牌后，B 端点的下一次调用仍要等待回补——证明是同一个桶而不是各端点各自计数', async () => {
    const delays: number[] = []
    let now = 0
    const fetchImpl = (async () => new Response('[]', { status: 200 })) as unknown as typeof fetch
    const c = createDanbooruClient({
      cacheDir: dir,
      fetchImpl,
      now: () => now,
      sleepImpl: async (ms) => {
        delays.push(ms)
      },
      bucketCapacity: 2,
      refillIntervalMs: 300,
    })

    await c.tags('a', 10) // 第 1 个令牌，立即发出
    await c.tags('b', 10) // 第 2 个令牌，容量（2）耗尽，仍立即发出
    now = 50
    await c.wiki('c') // 换成另一个端点，但令牌已被 A 耗尽，仍要等回补，不是各端点各自一份配额
    expect(delays).toEqual([250])
  })
})

describe('tagInfo（标签源词条头，磁盘缓存）', () => {
  it('URL：search[name] 精确匹配、归一空格、只要 name/category/post_count、limit=1', () => {
    const u = new URL(tagInfoUrl('long hair'))
    expect(u.pathname).toBe('/tags.json')
    expect(u.searchParams.get('search[name]')).toBe('long_hair')
    expect(u.searchParams.get('only')).toBe('name,category,post_count')
    expect(u.searchParams.get('limit')).toBe('1')
  })

  it('解析精确同名的那一条；空数组表示 D 站没有这个标签（tag: null，不是错误）', async () => {
    const hit = await makeClient(fakeFetchJson(200, [{ name: 'long_hair', category: 0, post_count: 950000 }])).tagInfo('long hair')
    expect(hit).toEqual({ ok: true, tag: { name: 'long_hair', category: 0, postCount: 950000 } })
    const miss = await makeClient(fakeFetchJson(200, [])).tagInfo('no_such_tag_x')
    expect(miss).toEqual({ ok: true, tag: null })
  })

  it('二次调用命中磁盘缓存，不再发请求；确认没有的结果也缓存', async () => {
    let calls = 0
    const f = (async () => {
      calls++
      return new Response('[]', { status: 200 })
    }) as unknown as typeof fetch
    const client = makeClient(f)
    await client.tagInfo('nothing_here')
    await client.tagInfo('nothing here')
    expect(calls).toBe(1)
  })

  it('非 200 归为 http', async () => {
    const r = await makeClient(fakeFetchRaw(503, 'down')).tagInfo('x')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('http')
  })
})

describe('posts 排序（标签源：评分最高）', () => {
  it('order=score 时 tags 为「归一后的 tag + 空格 + order:score」', () => {
    const u = new URL(postsUrl('long hair', 6, 1, 'score'))
    expect(u.searchParams.get('tags')).toBe('long_hair order:score')
    expect(u.searchParams.get('limit')).toBe('6')
  })

  it('不传 order 时与原来一致', () => {
    expect(new URL(postsUrl('long hair', 20, 3)).searchParams.get('tags')).toBe('long_hair')
  })

  it('同一 tag 同一页，带不带 order 不互相命中缓存', async () => {
    let calls = 0
    const f = (async () => {
      calls++
      return new Response('[]', { status: 200 })
    }) as unknown as typeof fetch
    const client = makeClient(f)
    await client.posts('a', 6, 1, 'score')
    await client.posts('a', 6, 1)
    expect(calls).toBe(2)
  })

  it('不认识的 order 归为 invalid，不发请求', async () => {
    let calls = 0
    const f = (async () => {
      calls++
      return new Response('[]', { status: 200 })
    }) as unknown as typeof fetch
    const r = await makeClient(f).posts('a', 6, 1, 'random' as never)
    expect(r.ok).toBe(false)
    expect(calls).toBe(0)
  })
})

describe('baseUrl 覆盖（集成测试桩）', () => {
  it('请求发到桩地址，路径与查询串保持正式地址的形状', async () => {
    const seen: string[] = []
    const f = (async (url: string) => {
      seen.push(url)
      return new Response('[]', { status: 200 })
    }) as unknown as typeof fetch
    await makeClient(f, { baseUrl: 'http://127.0.0.1:9999/' }).tags('wlop', 5)
    expect(seen[0].startsWith('http://127.0.0.1:9999/tags.json?')).toBe(true)
  })
})
