import {
  DANBOORU_BASE_URL,
  normalizeTag,
  type DanbooruArtistInfo,
  type DanbooruArtistResult,
  type DanbooruArtistSearchItem,
  type DanbooruArtistSearchResult,
  type DanbooruError,
  type DanbooruErrorKind,
  type DanbooruPost,
  type DanbooruPostsOrder,
  type DanbooruPostsResult,
  type DanbooruTagInfo,
  type DanbooruTagInfoResult,
  type DanbooruTagItem,
  type DanbooruTagsResult,
  type DanbooruWikiPage,
  type DanbooruWikiResult,
} from '@shared/danbooru'
import { DiskTagCache, MemoryLruCache } from './cache'

// 移植自画师串工具箱 src/main/danbooru/client.ts。本项目去掉了 autocomplete（联想走本地库），加了 tagInfo、posts 排序与 baseUrl 覆盖

/**
 * 全局节流：令牌桶，而不是刚性最小间隔。
 *
 * 曾经用刚性 1000ms 间隔（更早还试过 300ms，被 Cloudflare 判成滥用整个哑掉，
 * 见下方历史记录）。Danbooru 官方文档说得很清楚：**读请求全局限 10/秒，
 * 这是给短时突发用的；长会话建议保持在 1/秒左右**，与账号、端点无关。
 * 刚性间隔只满足了后半句，却把前半句的「允许突发」浪费掉了——选一个画师
 * 要发 6 个请求（画师条目、wiki、tags.json 取 post_count、新/中/旧三档各
 * 一页），刚性 1 秒间隔下这 6 个请求要整整 6 秒才发完，而官方明明允许它们
 * 一次性突发出去。
 *
 * 换成令牌桶：容量 6、每 1000ms 回补 1 个。冷启动时 6 个请求全部立即发出
 * （选一个画师的自然突发量一次性打完），第 7 个开始才排队等回补，长期均值
 * 仍是 1/秒——不比刚性间隔更冒险，只是不再无谓地拖慢突发场景。
 *
 * 容量没有直接取官方给的 10：那是**全局**上限，不是「本工具」的专属额度——
 * 同一 IP 上可能还有别的东西在打 Danbooru（比如用户自己的 koishi 机器人），
 * 我们看不到、也控制不了那部分流量。6 正好是「选一个画师」一次性要发的
 * 请求数，够用又给别的流量留了余量，不会一下子把全局 10/秒的硬上限用满。
 *
 * 历史教训（曾经用过 300ms 刚性间隔，≈3.3 请求/秒）：Danbooru 对匿名用户的
 * 指导量级是 1 请求/秒，300ms 给小了。开着「跟随光标」在画师串里移动，
 * 每落到一个新画师就是一轮 6 个请求，实际表现是被 Cloudflare 判成滥用、
 * 整个预览区一起哑掉，而用户看到的只是「怎么突然搜不出来了」，完全联想
 * 不到是自己移动光标太快。宁可慢一点：预览区是辅助功能，被封掉就什么都
 * 没有了。
 */
const DEFAULT_BUCKET_CAPACITY = 6
/** 每回补 1 个令牌所需的时间，默认 1000ms——长期均值 1 请求/秒（见上方注释） */
const DEFAULT_REFILL_INTERVAL_MS = 1000
// spec §13.3 没给 Danbooru 专门定超时值（那是 requestTimeoutMs 给 NAI 用的配置项）。
// 挑一个不至于让预览区卡死太久、又不会在正常网络下误伤的默认值
const DEFAULT_TIMEOUT_MS = 10_000

const SEARCH_TTL_MS = 10 * 60 * 1000
const POSTS_TTL_MS = 30 * 60 * 1000
const DISK_TTL_MS = 7 * 24 * 60 * 60 * 1000
// spec 没给容量上限，只说「LRU」；挑一个够用一次调试会话、又不会无限增长的数
const POSTS_MAX_ENTRIES = 200
// tags.json 与检索同一档 TTL（spec §13.3）：跟随光标时光标在画师词间来回
// 移动会反复取同一个 tag 的 post_count，不缓存就是每移动一次打一次网络
const TAGS_MAX_ENTRIES = 200
// 别名/链接检索是打字时跟名字检索一起并行触发的搜索型请求，容量与 TTL
// 都比照检索那一档，不必另开一档
const ARTIST_SEARCH_MAX_ENTRIES = 200

export interface DanbooruClientOptions {
  /** wiki/artists 磁盘缓存目录，由调用方传 userData 下的独立子目录（spec §13.3） */
  cacheDir: string
  /** 注入点：测试传假 fetch，不传则用全局 fetch（Node 20 内置，与 NAI 客户端同规矩） */
  fetchImpl?: typeof fetch
  /** 时钟注入点：缓存 TTL 与节流排队都要用，测试借此摆脱真实定时器 */
  now?: () => number
  /** 节流等待的实现；测试注入后不必真的等待，只记录被要求等了多久 */
  sleepImpl?: (ms: number) => Promise<void>
  /** 令牌桶容量，默认 6（spec §13.3；容量为什么不是官方给的 10，见上方
   * DEFAULT_BUCKET_CAPACITY 注释） */
  bucketCapacity?: number
  /** 每回补 1 个令牌的间隔，默认 1000ms——决定长期均值速率（spec §13.3） */
  refillIntervalMs?: number
  /** 单次请求超时，默认 10s（见上方 DEFAULT_TIMEOUT_MS 的注释） */
  timeoutMs?: number
  /** Danbooru 用户名。必须与 apiKey 同时提供才会生效——只填一项等于半份凭据，
   * 发过去大概率被判成认证失败，不如老实按匿名走（见下方 authHeader 的注释） */
  login?: string
  /** Danbooru API Key，走 Basic 认证头，绝不进 URL（见下方 authHeader 的注释） */
  apiKey?: string
  /** 只给集成测试用：把 https://danbooru.donmai.us 换成本机桩地址。生产不传 */
  baseUrl?: string
}

export interface DanbooruClient {
  tags(nameMatches: string, limit: number): Promise<DanbooruTagsResult>
  tagInfo(tag: string): Promise<DanbooruTagInfoResult>
  wiki(tag: string): Promise<DanbooruWikiResult>
  artist(tag: string): Promise<DanbooruArtistResult>
  posts(tag: string, limit: number, page: number, order?: DanbooruPostsOrder): Promise<DanbooruPostsResult>
  /** 画师预览搜索框「按别名模糊检索」那一路：search[any_other_name_like]=*q*。
   * 中文别名（如「满载SUGAR」）用官方 TAG 名搜是搜不到的，这一路专门补它 */
  searchArtistsByOtherName(query: string, limit: number): Promise<DanbooruArtistSearchResult>
  /** 「按主页链接模糊检索」那一路：search[url_matches]=*q*。
   * 实测 search[any_name_matches] 带前置通配符会 500，不能用它一把覆盖名字+别名，
   * 只能名字、别名、链接分别用各自专门的参数查 */
  searchArtistsByUrl(query: string, limit: number): Promise<DanbooruArtistSearchResult>
}

// 导出给 ipc.ts 复用：IPC 入参在到达这里的 typeof 校验之前，可能已经在
// handler 里解构入参时就抛出同步异常（入参整个是 null/undefined 时）。
// handler 层需要同一套「归为 invalid」的错误分类，而不是另造一种
export function fail(kind: DanbooruErrorKind, message: string): { ok: false; error: DanbooruError } {
  return { ok: false, error: { kind, message } }
}

// ─── URL 构造（spec §13 的表，逐字照抄参数名） ──────────────────
//
// 查询参数逐个 encodeURIComponent：tag 里可能有 `/`、`?`、`&`、空格，以及
// `artist:` 这样的冒号。键（如 `search[query]`）也一起编码——服务端会把
// query string 整体解码后再按 Rails 的 hash 记法解析，`%5B`/`%5D` 与字面的
// `[`/`]` 等价，编码更安全也不会破坏解析。

function buildQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

export function tagsUrl(nameMatches: string, limit: number): string {
  return `${DANBOORU_BASE_URL}/tags.json?${buildQuery({
    'search[name_matches]': `${normalizeTag(nameMatches)}*`,
    'search[category]': '1',
    'search[order]': 'count',
    limit: String(limit),
  })}`
}

/** 标签源词条头：精确名查分类与帖子数。search[name] 是精确匹配 */
export function tagInfoUrl(tag: string): string {
  return `${DANBOORU_BASE_URL}/tags.json?${buildQuery({
    'search[name]': normalizeTag(tag),
    only: 'name,category,post_count',
    limit: '1',
  })}`
}

export function wikiUrl(tag: string): string {
  // tag 在路径里，同样要编码——带 `/` 的 tag 不编码会直接打到别的路径上去
  return `${DANBOORU_BASE_URL}/wiki_pages/${encodeURIComponent(normalizeTag(tag))}.json`
}

export function artistUrl(tag: string): string {
  // only= 一次性把 urls/is_banned/is_deleted 也要回来，省一次 /artist_urls.json
  // 请求（spec §13.0）。**已实测可用**：/artists.json?search[name]=haku89&only=
  // id,name,other_names,urls,is_banned,is_deleted 返回 200，urls 是对象数组，
  // 每项形如 {url, is_active, ...}——见 parseArtistInfo 对 is_active 的处理。
  // 字段名终究可能随 Danbooru 版本变化，所以 parseArtistInfo 仍然把 urls
  // 缺失或不是数组的情况安全降级成「没有链接」，不因此报错或整块查不到
  return `${DANBOORU_BASE_URL}/artists.json?${buildQuery({
    'search[name]': tag,
    only: 'id,name,other_names,urls,is_banned,is_deleted',
  })}`
}

// 通配符由客户端统一包裹（*q*），不让用户自己在搜索框里打星号；用户输入里
// 本来就带的 `*` 按字面处理即可，不用转义——它本来就是 Danbooru 通配语法的
// 一部分，转义反而会让「用户就是想用通配符缩小范围」这种情况失效
function wildcard(query: string): string {
  return `*${query}*`
}

export function artistOtherNameLikeUrl(query: string, limit: number): string {
  // 实测：/artists.json?search[any_other_name_like]=*tang73* 命中
  // manzai_sugar——中文别名（如「满载SUGAR」）用官方 TAG 名搜不到，
  // 这个参数是唯一能补上别名检索的
  return `${DANBOORU_BASE_URL}/artists.json?${buildQuery({
    'search[any_other_name_like]': wildcard(query),
    only: 'id,name,other_names,urls',
    limit: String(limit),
  })}`
}

export function artistUrlMatchesUrl(query: string, limit: number): string {
  // 实测：/artists.json?search[url_matches]=*pixiv.net/users/14730603* 命中
  // manzai_sugar，且确认支持通配符——用户只输一段域名或 ID 也能命中
  return `${DANBOORU_BASE_URL}/artists.json?${buildQuery({
    'search[url_matches]': wildcard(query),
    only: 'id,name,other_names,urls',
    limit: String(limit),
  })}`
}

export function postsUrl(tag: string, limit: number, page: number, order?: DanbooruPostsOrder): string {
  // order: 是元标签，拼在 tag 后面、用空格隔开（tags= 里空格是分隔符）；tag 本身仍要先归一
  const tags = order ? `${normalizeTag(tag)} order:${order}` : normalizeTag(tag)
  return `${DANBOORU_BASE_URL}/posts.json?${buildQuery({ tags, limit: String(limit), page: String(page) })}`
}

// ─── 全局节流（spec §13.3：所有端点共用一个令牌桶） ────────────

/** 令牌桶在某一时刻的状态：剩余令牌数（可以是小数，回补是连续的）与
 * 上一次结算到的时刻 */
interface BucketState {
  tokens: number
  lastUpdate: number
}

/**
 * 纯逻辑：给定到达时刻与桶的当前状态，算出这一次该在什么时候发出、
 * 以及发出之后桶的新状态（消耗 1 个令牌）。
 *
 * 回补是连续的（`elapsed / refillIntervalMs`），不是离散地「每过 1000ms
 * 才加 1」——否则一串到达时刻紧贴着回补边界时，先后顺序会因为取整误差
 * 变得不确定。`elapsed` 允许为负（`arrival` 早于 `lastUpdate`）：这发生在
 * 一串请求挤在一起、前一个请求的发出时刻被顺延到了后一个请求的到达时刻
 * 之后，此时 `refilled` 会算出负值，效果等价于「还欠着令牌」，顺延会正确
 * 继续累积。
 */
function nextBucketDispatch(
  arrival: number,
  state: BucketState,
  capacity: number,
  refillIntervalMs: number,
): { dispatch: number; state: BucketState } {
  const elapsed = arrival - state.lastUpdate
  const refilled = Math.min(capacity, state.tokens + elapsed / refillIntervalMs)
  if (refilled >= 1) {
    return { dispatch: arrival, state: { tokens: refilled - 1, lastUpdate: arrival } }
  }
  // 令牌不够 1 个：算出还要等多久才能凑够，发出时刻顺延到那时候，
  // 顺延之后令牌立即被这次请求用掉，归零
  const dispatch = arrival + (1 - refilled) * refillIntervalMs
  return { dispatch, state: { tokens: 0, lastUpdate: dispatch } }
}

/**
 * 排队计算的纯函数版本：给定一串到达时刻，返回各自的实际发出时刻。
 * 供单测直接验证节流逻辑，不必真的等待定时器。桶从「满」开始——冷启动时
 * 允许一次性突发到 `capacity` 个请求。
 */
export function scheduleDispatchTimes(
  arrivals: number[],
  capacity: number,
  refillIntervalMs: number,
): number[] {
  // lastUpdate 设为 -Infinity 而不是某个具体时刻：这样无论第一个 arrival
  // 是什么值，elapsed 都是 +Infinity，refilled 必然封顶在 capacity——
  // 「冷启动即满桶」不必对 tokens 的初始值另作约定
  let state: BucketState = { tokens: capacity, lastUpdate: -Infinity }
  const dispatches: number[] = []
  for (const arrival of arrivals) {
    const next = nextBucketDispatch(arrival, state, capacity, refillIntervalMs)
    dispatches.push(next.dispatch)
    state = next.state
  }
  return dispatches
}

/**
 * 全局节流闸。整个 DanbooruClient 只建一个实例、被五个端点方法共用——
 * 不是每个端点各自算各自的。补全会在用户打字时高频触发，分端点节流起不到
 * 防限流的作用：被限流的后果是整个预览区一起哑掉。
 */
export class Gate {
  private tokens: number
  private lastUpdate = -Infinity

  constructor(
    private readonly capacity: number,
    private readonly refillIntervalMs: number,
    private readonly now: () => number,
    private readonly sleepImpl: (ms: number) => Promise<void>,
  ) {
    this.tokens = capacity
  }

  async wait(): Promise<void> {
    const arrival = this.now()
    const { dispatch, state } = nextBucketDispatch(
      arrival,
      { tokens: this.tokens, lastUpdate: this.lastUpdate },
      this.capacity,
      this.refillIntervalMs,
    )
    this.tokens = state.tokens
    this.lastUpdate = state.lastUpdate
    const delay = dispatch - arrival
    if (delay > 0) await this.sleepImpl(delay)
  }
}

// ─── HTTP 调用与响应解析 ────────────────────────────────────
//
// 错误处理与 NAI 客户端同规矩：永远返回结果对象、永不 reject。网络失败、
// 超时、非 200、JSON 解析失败、响应形状不符，全部归类成可展示的错误。

type HttpOutcome =
  | { kind: 'network'; error: DanbooruError }
  | { kind: 'response'; status: number; text: string }

/**
 * Danbooru 要求带一个可识别的 User-Agent。
 *
 * **不带 UA 会被 Cloudflare 挡下**——返回的不是 JSON 而是 403 加一整页
 * 「Just a moment...」的挑战页 HTML，于是错误分类只能把它归成「返回 403 +
 * 一大段 HTML」，界面上显示的是一坨看不懂的东西，而真因（少一个请求头）
 * 完全指不出来。实测：同一个 URL 不带 UA 返回 403，带上返回 200。
 */
export const DANBOORU_USER_AGENT = 'llm-nai-toolbox/0.9.3 (NovelAI prompt tool)'

async function throttledGet(
  fetchImpl: typeof fetch,
  gate: Gate,
  timeoutMs: number,
  url: string,
  authHeader: string | null,
): Promise<HttpOutcome> {
  await gate.wait()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': DANBOORU_USER_AGENT,
        // 用查询参数传 key（Danbooru 也支持）会让它顺着 URL 钻进缓存键、
        // 错误文案里的响应体前缀、以及将来任何打印 URL 的日志；Basic 头
        // 不参与 URL 构造，天然避开这些地方
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      signal: controller.signal,
    })
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return {
        kind: 'network',
        error: {
          kind: 'timeout',
          message: `Danbooru 请求超时（${Math.round(timeoutMs / 1000)} 秒）`,
        },
      }
    }
    return {
      kind: 'network',
      error: { kind: 'network', message: `网络错误：${e instanceof Error ? e.message : String(e)}` },
    }
  } finally {
    clearTimeout(timer)
  }

  let text: string
  try {
    text = await response.text()
  } catch (e) {
    // 响应头已到，但 body 流中途断开；必须兜住，否则会打破
    // 「永远返回结果对象、永不 reject」的承诺
    return {
      kind: 'network',
      error: { kind: 'network', message: `读取响应失败：${e instanceof Error ? e.message : String(e)}` },
    }
  }
  return { kind: 'response', status: response.status, text }
}

function parseTagItems(text: string): DanbooruTagItem[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  return parsed
    .filter(
      (it): it is { name?: unknown; post_count?: unknown; category?: unknown } =>
        typeof it === 'object' && it !== null,
    )
    .map((it) => ({
      name: typeof it.name === 'string' ? it.name : '',
      postCount: typeof it.post_count === 'number' ? it.post_count : 0,
      category: typeof it.category === 'number' ? it.category : 0,
    }))
    .filter((it) => it.name !== '')
}

function parseWikiPage(text: string): DanbooruWikiPage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  if (!('title' in parsed) || !('body' in parsed)) return null
  return {
    title: typeof parsed.title === 'string' ? parsed.title : '',
    body: typeof parsed.body === 'string' ? parsed.body : '',
  }
}

// 下面两个提取函数从 parseArtistInfo 里抽出来，供它与 parseArtistSearchItems
// 共用——/artists.json 不管是精确查询单个画师、还是按别名/链接模糊检索一批，
// other_names、urls 这两个字段的形状是一样的，没必要写两份同样的过滤逻辑

function extractOtherNames(obj: object): string[] {
  return 'other_names' in obj && Array.isArray(obj.other_names)
    ? obj.other_names.filter((n): n is string => typeof n === 'string')
    : []
}

/** 实测 `only=` 确实带回 urls，形如
 *   [{ id, artist_id, url, created_at, updated_at, is_active }]
 * ——是**对象数组**，不是字符串数组。
 *
 * urls 缺失或不是数组时仍安全降级为空数组而不是判定响应形状不认识：
 * 字段随时可能变，少一组链接不该让整个画师条目查不出来。 */
function extractActiveUrls(obj: object): string[] {
  return 'urls' in obj && Array.isArray(obj.urls)
    ? obj.urls
        .filter((u): u is { url?: unknown; is_active?: unknown } => typeof u === 'object' && u !== null)
        // is_active 为 false 表示该链接已被标记失效。让用户点开一个死链去找
        // 画师主页，比不给链接更浪费时间，所以在这里就滤掉、不传给界面。
        // 用 `!== false` 而不是 `=== true`：字段缺失时按「有效」处理，
        // 宁可多显示一条也不要因为响应少个字段就把链接全吞了
        .filter((u) => u.is_active !== false)
        .map((u) => (typeof u.url === 'string' ? u.url : null))
        .filter((u): u is string => u !== null)
    : []
}

/** ok:false 表示响应形状不认识（分类为 invalid）；ok:true 里 artist 为 null
 * 表示查到的是空数组——即「没有这个画师条目」，不是错误 */
function parseArtistInfo(
  text: string,
): { ok: true; artist: DanbooruArtistInfo | null } | { ok: false } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false }
  }
  if (!Array.isArray(parsed)) return { ok: false }
  if (parsed.length === 0) return { ok: true, artist: null }

  const first: unknown = parsed[0]
  if (typeof first !== 'object' || first === null) return { ok: false }
  if (!('name' in first) || typeof first.name !== 'string') return { ok: false }

  const otherNames = extractOtherNames(first)
  const urls = extractActiveUrls(first)
  const isBanned = 'is_banned' in first && typeof first.is_banned === 'boolean' ? first.is_banned : false
  const isDeleted = 'is_deleted' in first && typeof first.is_deleted === 'boolean' ? first.is_deleted : false

  return { ok: true, artist: { name: first.name, otherNames, urls, isBanned, isDeleted } }
}

/** 别名/链接模糊检索返回的是一批画师，不是单个——形状与 parseArtistInfo
 * 一致（同一个 /artists.json 端点），区别只是不取第一条而是整批都要，
 * 也不需要 isBanned/isDeleted（列表阶段用不上，见 DanbooruArtistSearchItem 的注释） */
function parseArtistSearchItems(text: string): DanbooruArtistSearchItem[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null

  const items: DanbooruArtistSearchItem[] = []
  for (const raw of parsed) {
    if (typeof raw !== 'object' || raw === null) continue
    if (!('name' in raw) || typeof raw.name !== 'string') continue
    items.push({ name: raw.name, otherNames: extractOtherNames(raw), urls: extractActiveUrls(raw) })
  }
  return items
}

function parsePosts(text: string): DanbooruPost[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  return parsed
    .filter(
      (
        it,
      ): it is {
        id?: unknown
        preview_file_url?: unknown
        large_file_url?: unknown
        file_url?: unknown
      } => typeof it === 'object' && it !== null,
    )
    .map((it) => ({
      id: typeof it.id === 'number' ? it.id : 0,
      previewUrl: typeof it.preview_file_url === 'string' ? it.preview_file_url : null,
      largeUrl: typeof it.large_file_url === 'string' ? it.large_file_url : null,
      // file_url 才是原图；large_file_url 是被压缩过的 sample（见 DanbooruPost
      // 的字段注释）。解析规矩与另外两档完全一致：不是字符串就安全降级成 null
      originalUrl: typeof it.file_url === 'string' ? it.file_url : null,
    }))
}

// ─── 客户端 ─────────────────────────────────────────────────

export function createDanbooruClient(opts: DanbooruClientOptions): DanbooruClient {
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.now ?? Date.now
  const sleepImpl =
    opts.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const bucketCapacity = opts.bucketCapacity ?? DEFAULT_BUCKET_CAPACITY
  const refillIntervalMs = opts.refillIntervalMs ?? DEFAULT_REFILL_INTERVAL_MS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // 只在两者都配了的时候才生效（见 DanbooruClientOptions.login 的注释）；
  // 在客户端创建时算好一次，五个端点共用同一个值
  const authHeader =
    opts.login && opts.apiKey
      ? `Basic ${Buffer.from(`${opts.login}:${opts.apiKey}`).toString('base64')}`
      : null

  // 全局唯一一个闸，五个端点方法共用（见 Gate 的类注释）
  const gate = new Gate(bucketCapacity, refillIntervalMs, now, sleepImpl)

  const postsCache = new MemoryLruCache<string, DanbooruPost[]>(POSTS_MAX_ENTRIES, POSTS_TTL_MS, now)
  const tagsCache = new MemoryLruCache<string, DanbooruTagItem[]>(
    TAGS_MAX_ENTRIES,
    SEARCH_TTL_MS,
    now,
  )
  const wikiCache = new DiskTagCache<DanbooruWikiPage | null>('wiki', opts.cacheDir, DISK_TTL_MS, now)
  const artistCache = new DiskTagCache<DanbooruArtistInfo | null>(
    'artist',
    opts.cacheDir,
    DISK_TTL_MS,
    now,
  )
  const tagInfoCache = new DiskTagCache<DanbooruTagInfo | null>('taginfo', opts.cacheDir, DISK_TTL_MS, now)
  // 别名、链接两路检索共用一份缓存，键里带上维度前缀区分——两路查询词可能
  // 撞上同一个字符串（比如 query 恰好又像别名又像链接片段），不加维度前缀
  // 会让一路的结果被误当成另一路的缓存命中
  const artistSearchCache = new MemoryLruCache<string, DanbooruArtistSearchItem[]>(
    ARTIST_SEARCH_MAX_ENTRIES,
    SEARCH_TTL_MS,
    now,
  )

  const base = opts.baseUrl?.replace(/\/+$/, '')
  // URL 构造函数一律按正式地址拼（单测断言的就是正式地址），发请求前再换成桩地址
  const rebase = (url: string): string => (base ? base + url.slice(DANBOORU_BASE_URL.length) : url)
  const get = (url: string): Promise<HttpOutcome> => throttledGet(fetchImpl, gate, timeoutMs, rebase(url), authHeader)

  // 别名、链接两路检索的请求/校验/缓存逻辑完全一样，区别只是 URL 构造函数
  // 与缓存键的维度前缀——抽出来避免两个方法各写一遍同样的样板
  async function searchArtists(
    dimension: 'other_name' | 'url',
    query: string,
    limit: number,
    buildUrl: (query: string, limit: number) => string,
  ): Promise<DanbooruArtistSearchResult> {
    if (typeof query !== 'string' || query.length === 0) return fail('invalid', '缺少查询词')
    if (!Number.isFinite(limit) || limit <= 0) return fail('invalid', 'limit 不合法')

    const key = `${dimension} ${query} ${limit}`
    const cached = artistSearchCache.get(key)
    if (cached !== undefined) return { ok: true, items: cached }

    const r = await get(buildUrl(query, limit))
    if (r.kind === 'network') return { ok: false, error: r.error }
    if (r.status !== 200) return fail('http', `Danbooru 返回 ${r.status}：${r.text.slice(0, 500)}`)
    const items = parseArtistSearchItems(r.text)
    if (items === null) return fail('invalid', 'Danbooru 返回了无法识别的画师列表')
    artistSearchCache.set(key, items)
    return { ok: true, items }
  }

  return {
    async tags(nameMatches, limit) {
      if (typeof nameMatches !== 'string' || nameMatches.length === 0) {
        return fail('invalid', '缺少查询词')
      }
      if (!Number.isFinite(limit) || limit <= 0) return fail('invalid', 'limit 不合法')

      // 键里带上 limit，理由与检索缓存一致：漏了它，limit=5 的缓存会被
      // limit=20 的调用命中，安静地返回一份被截断的列表
      const key = `${nameMatches} ${limit}`
      const cached = tagsCache.get(key)
      if (cached !== undefined) return { ok: true, tags: cached }

      const r = await get(tagsUrl(nameMatches, limit))
      if (r.kind === 'network') return { ok: false, error: r.error }
      if (r.status !== 200) return fail('http', `Danbooru 返回 ${r.status}：${r.text.slice(0, 500)}`)
      const tags = parseTagItems(r.text)
      if (tags === null) return fail('invalid', 'Danbooru 返回了无法识别的标签列表')
      tagsCache.set(key, tags)
      return { ok: true, tags }
    },

    async tagInfo(tag) {
      if (typeof tag !== 'string' || tag.trim().length === 0) return fail('invalid', '缺少 tag')
      const key = normalizeTag(tag)
      const cached = tagInfoCache.get(key)
      if (cached !== undefined) return { ok: true, tag: cached }

      const r = await get(tagInfoUrl(key))
      if (r.kind === 'network') return { ok: false, error: r.error }
      if (r.status !== 200) return fail('http', `Danbooru 返回 ${r.status}：${r.text.slice(0, 500)}`)
      const items = parseTagItems(r.text)
      if (items === null) return fail('invalid', 'Danbooru 返回了无法识别的标签信息')
      const info = items.find((t) => t.name === key) ?? null
      tagInfoCache.set(key, info)
      return { ok: true, tag: info }
    },

    async wiki(tag) {
      if (typeof tag !== 'string' || tag.length === 0) return fail('invalid', '缺少画师名')

      // 缓存查询必须在任何网络/磁盘 I/O 之前做完类型校验（上面那行），
      // 否则非法输入也会去碰磁盘缓存文件
      const cached = wikiCache.get(tag)
      if (cached !== undefined) return { ok: true, wiki: cached }

      const r = await get(wikiUrl(tag))
      if (r.kind === 'network') return { ok: false, error: r.error }
      if (r.status === 404) {
        // 404 = 没有这个画师的 wiki 条目，很常见——大多数画师本来就没有 wiki
        // 页（spec §13.0），不是错误。也把这个「确认没有」缓存住，免得同一个
        // 画师每次都要再打一次请求才能知道它没有 wiki
        wikiCache.set(tag, null)
        return { ok: true, wiki: null }
      }
      if (r.status !== 200) return fail('http', `Danbooru 返回 ${r.status}：${r.text.slice(0, 500)}`)
      const wiki = parseWikiPage(r.text)
      if (wiki === null) return fail('invalid', 'Danbooru 返回了无法识别的 wiki 内容')

      // spec §13.0：wiki「为空」包含两种——404 与「页面存在但 body 是空串」，
      // 对用户来说没有区别（都是「wiki 这一块没内容」，不是「查不到这个
      // 画师」），都归一成同一个 null 信号。这个判断放在客户端层：调用方
      // 只该关心「有没有可显示的 wiki 正文」，不该再替它区分是 404 还是空串
      if (wiki.body.trim() === '') {
        wikiCache.set(tag, null)
        return { ok: true, wiki: null }
      }

      wikiCache.set(tag, wiki)
      return { ok: true, wiki }
    },

    async artist(tag) {
      if (typeof tag !== 'string' || tag.length === 0) return fail('invalid', '缺少画师名')

      const cached = artistCache.get(tag)
      if (cached !== undefined) return { ok: true, artist: cached }

      const r = await get(artistUrl(tag))
      if (r.kind === 'network') return { ok: false, error: r.error }
      if (r.status !== 200) return fail('http', `Danbooru 返回 ${r.status}：${r.text.slice(0, 500)}`)
      const parsed = parseArtistInfo(r.text)
      if (!parsed.ok) return fail('invalid', 'Danbooru 返回了无法识别的画师条目')
      artistCache.set(tag, parsed.artist)
      return { ok: true, artist: parsed.artist }
    },

    searchArtistsByOtherName: (query, limit) =>
      searchArtists('other_name', query, limit, artistOtherNameLikeUrl),

    searchArtistsByUrl: (query, limit) => searchArtists('url', query, limit, artistUrlMatchesUrl),

    async posts(tag, limit, page, order) {
      if (typeof tag !== 'string' || tag.length === 0) return fail('invalid', '缺少 tag')
      if (!Number.isFinite(limit) || limit <= 0) return fail('invalid', 'limit 不合法')
      if (!Number.isFinite(page) || page <= 0) return fail('invalid', 'page 不合法')
      if (order !== undefined && order !== 'score') return fail('invalid', 'order 不合法')

      const key = `${tag} ${limit} ${page} ${order ?? ''}`
      const cached = postsCache.get(key)
      if (cached !== undefined) return { ok: true, posts: cached }

      const r = await get(postsUrl(tag, limit, page, order))
      if (r.kind === 'network') return { ok: false, error: r.error }
      if (r.status !== 200) return fail('http', `Danbooru 返回 ${r.status}：${r.text.slice(0, 500)}`)
      const posts = parsePosts(r.text)
      if (posts === null) return fail('invalid', 'Danbooru 返回了无法识别的例图列表')
      postsCache.set(key, posts)
      return { ok: true, posts }
    },
  }
}
