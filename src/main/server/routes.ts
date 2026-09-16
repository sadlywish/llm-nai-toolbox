// 手机端业务接口：meta / styles / history / usage（Task 5）、图片（Task 6）、
// 画风写接口（Task 7）、LLM 与 SSE（Task 8）、出图（Task 9）。
//
// 不 import electron：同 http.ts、devices.ts，服务层要能在 node 下单独跑测试。
import type { IncomingMessage, ServerResponse } from 'http'
import { basename } from 'path'
import pkgJson from '../../../package.json'
import { CHARACTER_FIELDS, MAIN_FIELDS, orderSpecs } from '../../shared/fields'
import { parseGenStartInput } from '../../shared/gen'
import { newId } from '../../shared/ids'
import { parseLlmRunInput, type LlmEvent, type LlmRunInput, type LlmRunResult } from '../../shared/llm'
import {
  MOBILE_API_VERSION,
  type GenRunStarted,
  type LlmRunStarted,
  type MobileEvent,
  type MobileLastLlmResult,
  type MobileLastLlmRun,
  type MobileMeta,
  type MobileStylesResult,
} from '../../shared/mobileApi'
import { MODEL_OPTIONS, NOISE_SCHEDULE_OPTIONS, SAMPLER_OPTIONS } from '../../shared/naiOptions'
import type { NaiSubscriptionResult } from '../../shared/naiUser'
import { normalizeStyles, type StylePreset } from '../../shared/styles'
import { normalizeWorkspace } from '../../shared/workspace'
import type { AppEvents } from '../appEvents'
import { errorMessage } from '../llm/http'
import { loadRecentRounds } from '../nai/index-store'
import type { PairedDevice } from './devices'
import { readJsonBody, sendError, sendJson, type ServerDeps } from './http'
import { handleImage } from './image'
import type { SseHub } from './sse'

/**
 * 各路由共用的上下文：ServerDeps 加上已经验过令牌的那台设备，再加事件出口。
 *
 * hub 从 http.ts 传进来而不是路由层自己建：一个服务只有一个 hub，所有 SSE 连接都挂在它上面，
 * 谁发起的这一轮，事件就推给当时连着的所有手机。
 */
export type ApiContext = ServerDeps & { device: PairedDevice; hub: SseHub }

function buildMeta(ctx: ApiContext): MobileMeta {
  const config = ctx.services.configStore.read()
  return {
    apiVersion: MOBILE_API_VERSION,
    appVersion: pkgJson.version,
    // orderSpecs 给的是 readonly 数组，MobileMeta 的字段是要能被手机端本地再排的普通数组，
    // 这里落地时就地拷一份，省得消费方各自 [...] 一遍
    mainFields: [...orderSpecs(MAIN_FIELDS, config.promptOrder)],
    charFields: [...orderSpecs(CHARACTER_FIELDS, config.naiCharPromptOrder)],
    models: MODEL_OPTIONS.map((m) => m.value),
    samplers: SAMPLER_OPTIONS,
    noiseSchedules: NOISE_SCHEDULE_OPTIONS,
    maxCharacters: config.naiMaxCharacters,
    maxPixels: config.naiMaxPixels,
    usagePercentPerImage: config.naiUsagePercentPerImage,
    // 只给目录名用于展示：完整路径可能带用户名之类的信息，绝不该出现在响应里（Global Constraints）
    // 只给类型与模型名：手机端把它记进出图溯源的「LLM 请求」。地址与 Key 一概不给
    llm: { apiType: config.apiType, model: config.model },
    saveDirName: basename(config.saveDir),
    // gen 直接读 GenRunner 自己的在途保护，不经事件反推——反推在「桌面端已经在跑、
    // 手机刚连上还没收到下一条事件」时会显示成闲，而且平白多一份有状态的订阅
    busy: { llm: ctx.services.llmSession.busy, gen: ctx.services.genRunner.busy },
  }
}

function buildStyles(ctx: ApiContext): MobileStylesResult {
  const styles = normalizeStyles(ctx.services.stylesStore.read())
  const workspace = normalizeWorkspace(ctx.services.workspaceStore.read())
  return { styles, presetId: workspace.console.presetId }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 画风的增删改排序四个接口共用：每次写盘前都要过 normalizeStyles（Global Constraints） */
function saveStyles(ctx: ApiContext, styles: StylePreset[]): StylePreset[] {
  const normalized = normalizeStyles(styles)
  ctx.services.stylesStore.write(normalized)
  return normalized
}

/** `POST /api/styles`：新建一条，名称/标签缺省当空字符串——真正的默认名由 normalizeStyles 兜底 */
async function handleCreateStyle(req: IncomingMessage, res: ServerResponse, ctx: ApiContext): Promise<void> {
  const body = await readJsonBody(req)
  if (!isRecord(body)) {
    sendError(res, 400, 'bad-request', '新建画风的内容不对')
    return
  }
  const created: StylePreset = {
    id: newId('st'),
    name: typeof body.name === 'string' ? body.name : '',
    tags: typeof body.tags === 'string' ? body.tags : '',
  }
  const normalized = saveStyles(ctx, [...normalizeStyles(ctx.services.stylesStore.read()), created])
  // created 那条在 normalizeStyles 里可能被改过名字（空名 → 未命名画风），所以要从落盘结果里取，
  // 不能直接回传 created——两者不一定一样
  sendJson(res, 200, normalized[normalized.length - 1])
}

/** `PATCH /api/styles/:id`：只改传进来的字段；id 不存在 404 */
async function handlePatchStyle(req: IncomingMessage, res: ServerResponse, ctx: ApiContext, id: string): Promise<void> {
  const styles = normalizeStyles(ctx.services.stylesStore.read())
  const idx = styles.findIndex((s) => s.id === id)
  if (idx === -1) {
    sendError(res, 404, 'not-found', '这个画风不存在')
    return
  }
  const body = await readJsonBody(req)
  if (!isRecord(body)) {
    sendError(res, 400, 'bad-request', '改画风的内容不对')
    return
  }
  if ('name' in body && typeof body.name !== 'string') {
    sendError(res, 400, 'bad-request', '画风名称必须是字符串')
    return
  }
  if ('tags' in body && typeof body.tags !== 'string') {
    sendError(res, 400, 'bad-request', '画风标签必须是字符串')
    return
  }
  const updated: StylePreset = {
    ...styles[idx],
    name: typeof body.name === 'string' ? body.name : styles[idx].name,
    tags: typeof body.tags === 'string' ? body.tags : styles[idx].tags,
  }
  styles[idx] = updated
  const normalized = saveStyles(ctx, styles)
  sendJson(res, 200, normalized[idx])
}

/** `DELETE /api/styles/:id`：id 不存在 404 */
function handleDeleteStyle(res: ServerResponse, ctx: ApiContext, id: string): void {
  const styles = normalizeStyles(ctx.services.stylesStore.read())
  const idx = styles.findIndex((s) => s.id === id)
  if (idx === -1) {
    sendError(res, 404, 'not-found', '这个画风不存在')
    return
  }
  styles.splice(idx, 1)
  saveStyles(ctx, styles)
  sendJson(res, 200, { ok: true })
}

/**
 * `POST /api/styles/order`：按给的 id 顺序重排。
 * ids 与现有集合但凡对不上（缺一个、多一个、重复）一律 400——顺序落盘前必须是同一批 id 的一个排列。
 */
async function handleReorderStyles(req: IncomingMessage, res: ServerResponse, ctx: ApiContext): Promise<void> {
  const body = await readJsonBody(req)
  if (!isRecord(body) || !Array.isArray(body.ids) || !body.ids.every((v) => typeof v === 'string')) {
    sendError(res, 400, 'bad-request', '排序请求的内容不对')
    return
  }
  const ids = body.ids as string[]
  const styles = normalizeStyles(ctx.services.stylesStore.read())
  const currentIds = new Set(styles.map((s) => s.id))
  const givenIds = new Set(ids)
  const matches = ids.length === styles.length && givenIds.size === ids.length && ids.every((id) => currentIds.has(id))
  if (!matches) {
    sendError(res, 400, 'bad-request', '排序列表与现有画风对不上')
    return
  }
  const byId = new Map(styles.map((s) => [s.id, s]))
  const reordered = ids.map((id) => byId.get(id)!)
  const normalized = saveStyles(ctx, reordered)
  sendJson(res, 200, { styles: normalized })
}

/**
 * `POST /api/styles/:id/preset`：选为预设。这是全服务唯一允许写 workspace.json 的接口
 * （Global Constraints）——读出桌面端工作区，只改 console.presetId，其余字段原样写回，
 * 不经过 normalizeWorkspace 重新整形，避免手机端的这一次操作意外改动桌面端别的字段。
 */
function handleSetPresetStyle(res: ServerResponse, ctx: ApiContext, id: string): void {
  const styles = normalizeStyles(ctx.services.stylesStore.read())
  if (!styles.some((s) => s.id === id)) {
    sendError(res, 404, 'not-found', '这个画风不存在')
    return
  }
  const rawWorkspace = ctx.services.workspaceStore.read()
  const workspace = isRecord(rawWorkspace) ? rawWorkspace : {}
  const consoleOptions = isRecord(workspace.console) ? workspace.console : {}
  ctx.services.workspaceStore.write({ ...workspace, console: { ...consoleOptions, presetId: id } })
  // 光落盘不够：桌面端渲染进程的工作区是内存态、按防抖存盘，它不知道磁盘被改了，
  // 指令区仍显示旧预设名，而且它下一次存盘会把这里写进去的 presetId 整个覆盖回去。
  // 发一条事件让渲染层把这个值跟过去（由 ipc.ts 广播给窗口）
  ctx.services.events.emit({ kind: 'preset-changed', presetId: id })
  sendJson(res, 200, { presetId: id })
}

/** ?days= 不是正整数就交给调用方用 config.historyDays 兜底，不报错——这是展示态的查询参数，不值得为它 400 */
function parseDays(raw: string | null): number | undefined {
  if (raw === null) return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** 额度查询要真的打一次 NovelAI；手机端进页面、出图结束各刷新一次，短时间内连着点
 * 很容易把同一个数打两次上去，所以按请求发起方（同一个 ServerDeps 实例）缓存 60 秒 */
const USAGE_CACHE_MS = 60_000
const usageCache = new WeakMap<ServerDeps['fetchUsage'], { at: number; result: NaiSubscriptionResult }>()

async function fetchUsageCached(ctx: ApiContext): Promise<NaiSubscriptionResult> {
  const cached = usageCache.get(ctx.fetchUsage)
  if (cached !== undefined && Date.now() - cached.at < USAGE_CACHE_MS) return cached.result
  const result = await ctx.fetchUsage()
  usageCache.set(ctx.fetchUsage, { at: Date.now(), result })
  return result
}

/** 电脑正在跑一轮时给手机的回话。这句会被原样显示，所以得是完整的中文一句话（Global Constraints） */
const LLM_BUSY_MESSAGE = '电脑正在跑一轮 LLM，等它结束再试'

/**
 * 最近一次跑完的那一轮，每台服务只留一条，新的覆盖旧的。
 *
 * 挂在 hub 上（一个服务实例只有一个 hub，换端口重启也还是同一个）而不是做成模块级单例：
 * 测试里会同时起好几台服务，单例会让它们互相看见对方的结果。进程重启就没了，可以接受——
 * 那时手机端页面也早就重新加载过了。
 */
const lastLlmRuns = new WeakMap<SseHub, MobileLastLlmRun>()

/**
 * 日志与轮次的 `LlmEvent` → `MobileEvent`。两套类型没有合并是有意的：SSE 这条通道只走手机端
 * 用得上的字段，主进程内部的事件将来加了什么，不该自动漏到局域网上去。
 *
 * 收尾事件不走这里：它要额外带上 runId，而且推出去之前得先记进 `lastLlmRuns`。
 */
function toMobileEvent(e: Exclude<LlmEvent, { kind: 'finished' }>): MobileEvent {
  if (e.kind === 'log') return { kind: 'llm-log', line: e.line }
  return { kind: 'llm-round', round: e.round, maxRounds: e.maxRounds }
}

/**
 * 开跑并把这一轮的事件转推给所有 SSE 连接，返回这一轮的 runId。不返回 Promise：调用方那时
 * 已经回过话了，这一轮的成败只经 SSE（与 `GET /api/llm/last`）送达。
 *
 * 回填结果也只经 `llm-finished` 给手机，服务端绝不写 workspace.json（Global Constraints）——
 * 桌面端那份工作区是桌面端的，手机自己应用自己那一份。
 */
function startLlmRun(ctx: ApiContext, input: LlmRunInput): string {
  const runId = newId('run')
  const startedAt = Date.now()
  // 收尾只走这一个口子：先记下来再推。手机锁屏、切后台都会把 SSE 断掉，断线期间跑完的话这条
  // 事件就永远收不到了；记下来手机重连后查一次 /api/llm/last 就能把回填补上，不必重发一轮
  const finish = (result: LlmRunResult): void => {
    lastLlmRuns.set(ctx.hub, { runId, finishedAt: new Date().toISOString(), result })
    ctx.hub.push({ kind: 'llm-finished', runId, result })
  }
  const run = ctx.services.llmSession.run(input, (e) => {
    if (e.kind === 'finished') finish(e.result)
    else ctx.hub.push(toMobileEvent(e))
  })
  void run.catch((err: unknown) => {
    // runLlm 自己兜住了所有失败（返回 failed/aborted），能抛到这里的是依赖没接上一类的问题。
    // 不接住的话：主进程里多一个未处理的 rejection，手机那头还会一直等一条永远不来的收尾事件
    finish({ status: 'failed', rounds: 0, elapsedMs: Date.now() - startedAt, message: errorMessage(err) })
  })
  return runId
}

/**
 * `POST /api/llm/run`：校验入参 → 开跑 → 立刻回 `{ ok: true }`。
 *
 * 不等这一轮跑完：一轮动辄几十秒到几分钟，手机上的 HTTP 请求等不住（浏览器、路由器、
 * 手机息屏都会把它掐了），进度与结果一律走 SSE。
 */
async function handleLlmRun(req: IncomingMessage, res: ServerResponse, ctx: ApiContext): Promise<void> {
  const input = parseLlmRunInput(await readJsonBody(req))
  if (typeof input === 'string') {
    // parseLlmRunInput 给的理由是写给开发者看的（'llm:run 缺少指令文本'），不适合直接显示；
    // 能发出不合法入参的只有版本对不上的手机端页面，就照这个提示写
    sendError(res, 400, 'bad-request', '手机发来的指令内容不对，可能是手机上的页面太旧，刷新一下再试')
    return
  }
  // 先问 busy 再开跑：run 在忙时抛的 BusyError 只能从 Promise 里接，而这里必须当场决定回 200 还是 409。
  // 这两句之间没有 await，中间插不进另一轮
  if (ctx.services.llmSession.busy) {
    sendError(res, 409, 'busy', LLM_BUSY_MESSAGE)
    return
  }
  const started: LlmRunStarted = { runId: startLlmRun(ctx, input) }
  sendJson(res, 200, started)
}

/** `POST /api/llm/abort`：没有在途那一轮时也回 200——手机上重复点「中止」不该看到报错 */
function handleLlmAbort(res: ServerResponse, ctx: ApiContext): void {
  ctx.services.llmSession.abort()
  sendJson(res, 200, { ok: true })
}

/**
 * 把总线上的出图事件转推给 SSE，返回退订函数。
 *
 * 这个订阅由服务的生命周期持有（http.ts 里启动时挂、停止时退），不放在请求处理里：
 * 每处理一个请求挂一次的话，同一条进度会被推给手机好几遍，而且请求结束也没人退订。
 *
 * 出图事件本来就是广播性质的（桌面端也是广播给所有窗口），所以桌面端自己发起的那一轮
 * 手机同样会看到进度——这是有意的，手机上正好能看见电脑在跑什么。
 *
 * `gen-seed` 不转推：那是回填桌面端参数区用的，手机端那份工作区是手机自己的
 * （Global Constraints：服务端绝不写 workspace.json），它按自己发出去的参数记 seed。
 */
export function forwardGenEvents(events: AppEvents, hub: SseHub): () => void {
  return events.on((e) => {
    if (e.kind === 'gen-progress') hub.push({ kind: 'gen-progress', progress: e.progress })
    else if (e.kind === 'gen-image') hub.push({ kind: 'gen-image', image: e.image })
  })
}

/** 电脑正在出图时给手机的回话。同 LLM_BUSY_MESSAGE，会被原样显示，得是完整的中文一句话 */
const GEN_BUSY_MESSAGE = '电脑正在出图，等这一轮结束再试'

/**
 * `POST /api/gen/start`：校验入参 → 开跑 → 立刻回 `{ roundId }`。
 *
 * 同 LLM，不等这一轮跑完：一轮几十张图能跑十几分钟，手机上的 HTTP 请求等不住，
 * 进度与每张图一律走 SSE。
 *
 * 配置与 Token 在开跑那一刻从电脑这边读，手机发来的只有提示词与张数；明文 Token
 * 不进任何响应与事件（Global Constraints）。出图**只用手机发来的那份参数**，
 * 服务端绝不写 workspace.json。
 */
async function handleGenStart(req: IncomingMessage, res: ServerResponse, ctx: ApiContext): Promise<void> {
  const input = parseGenStartInput(await readJsonBody(req))
  if (typeof input === 'string') {
    // parseGenStartInput 给的理由是写给开发者看的（'gen:start 入参无效'），不适合直接显示；
    // 同 handleLlmRun，能发出不合法入参的只有版本对不上的手机端页面
    sendError(res, 400, 'bad-request', '手机发来的出图参数不对，可能是手机上的页面太旧，刷新一下再试')
    return
  }
  // 先问 busy 再开跑：GenRunner 在忙时抛的错只能从 Promise 里接，而这里必须当场决定回 200 还是 409。
  // 桌面端与手机端共用同一个 GenRunner，所以桌面端在跑时手机也会走到这里。
  // 这句到 start() 之间没有 await，中间插不进另一轮
  if (ctx.services.genRunner.busy) {
    sendError(res, 409, 'busy', GEN_BUSY_MESSAGE)
    return
  }
  const config = ctx.services.configStore.read()
  const token = ctx.services.secrets.read('naiToken').trim()

  // roundId 是 GenRunner 内部生成的，而 start() 的 Promise 要整轮跑完才 resolve，这里必须立刻回话。
  // RunQueue 开跑第一件事就是同步发一条 running 进度，所以在 start() 这次调用返回之前
  // 就能从总线上接到带 roundId 的那一条——临时挂一个订阅把它抓出来，抓完立刻退订
  let roundId: string | null = null
  const off = ctx.services.events.on((e) => {
    if (e.kind === 'gen-progress' && roundId === null) roundId = e.progress.roundId
  })
  let run: Promise<unknown>
  try {
    run = ctx.services.genRunner.start(input, config, token)
  } finally {
    // start() 的同步段里要是抛了（理论上不会，async 函数只会 reject），订阅也不能留下
    off()
  }
  void run.catch((err: unknown) => {
    // 队列自己兜住了每一张的失败，能抛到这里的是开跑前的预检（没设保存目录、没填 Token）
    // 与落盘一类的问题。不接住的话主进程里就多一个未处理的 rejection；
    // 预检失败那条由下面的分支当场回给手机，这里只管已经开跑的那一轮
    if (roundId !== null) console.warn('[mobile] 这一轮出图出错了：', err)
  })

  if (roundId === null) {
    // 一条进度都没发出来，说明这一轮在建队列之前就被预检拦下了，那条 Promise 此刻已经 settle，
    // await 它只过一个微任务，不会把响应吊在整轮上。预检的话本来就是写给用户看的，原样转给手机
    const message = await run.then(() => '这一轮出图没能开始', errorMessage)
    sendError(res, 500, 'server', message)
    return
  }
  const started: GenRunStarted = { roundId }
  sendJson(res, 200, started)
}

/**
 * 手机端业务接口的分发。返回 false 表示这条路径（或这个方法）不是这里认识的 API，
 * 调用方（http.ts）据此落到统一的 404。
 */
export async function handleApi(req: IncomingMessage, res: ServerResponse, ctx: ApiContext): Promise<boolean> {
  const { pathname, searchParams } = new URL(req.url ?? '/', 'http://localhost')

  if (pathname === '/api/meta' && req.method === 'GET') {
    sendJson(res, 200, buildMeta(ctx))
    return true
  }
  if (pathname === '/api/styles' && req.method === 'GET') {
    sendJson(res, 200, buildStyles(ctx))
    return true
  }
  if (pathname === '/api/styles' && req.method === 'POST') {
    await handleCreateStyle(req, res, ctx)
    return true
  }
  // /order 是固定路径，必须排在 /api/styles/:id 的通配匹配之前，否则 'order' 会被当成 id
  if (pathname === '/api/styles/order' && req.method === 'POST') {
    await handleReorderStyles(req, res, ctx)
    return true
  }
  const presetMatch = /^\/api\/styles\/([^/]+)\/preset$/.exec(pathname)
  if (presetMatch !== null && req.method === 'POST') {
    handleSetPresetStyle(res, ctx, decodeURIComponent(presetMatch[1]))
    return true
  }
  const styleIdMatch = /^\/api\/styles\/([^/]+)$/.exec(pathname)
  if (styleIdMatch !== null && req.method === 'PATCH') {
    await handlePatchStyle(req, res, ctx, decodeURIComponent(styleIdMatch[1]))
    return true
  }
  if (styleIdMatch !== null && req.method === 'DELETE') {
    handleDeleteStyle(res, ctx, decodeURIComponent(styleIdMatch[1]))
    return true
  }
  if (pathname === '/api/history' && req.method === 'GET') {
    const config = ctx.services.configStore.read()
    const days = parseDays(searchParams.get('days')) ?? config.historyDays
    sendJson(res, 200, loadRecentRounds(config.saveDir, days))
    return true
  }
  if (pathname === '/api/usage' && req.method === 'GET') {
    sendJson(res, 200, await fetchUsageCached(ctx))
    return true
  }
  if (pathname === '/api/image' && req.method === 'GET') {
    await handleImage(req, res, ctx)
    return true
  }
  if (pathname === '/api/llm/run' && req.method === 'POST') {
    await handleLlmRun(req, res, ctx)
    return true
  }
  if (pathname === '/api/llm/abort' && req.method === 'POST') {
    handleLlmAbort(res, ctx)
    return true
  }
  if (pathname === '/api/llm/last' && req.method === 'GET') {
    const last: MobileLastLlmResult = { last: lastLlmRuns.get(ctx.hub) ?? null }
    sendJson(res, 200, last)
    return true
  }
  if (pathname === '/api/gen/start' && req.method === 'POST') {
    await handleGenStart(req, res, ctx)
    return true
  }
  // 取消与继续在没有在途那一轮时都是空操作（GenRunner 里的 queue 为 null），照
  // /api/llm/abort 一样回 200：手机上重复点、或者电脑那头刚好跑完，都不该看到报错
  if (pathname === '/api/gen/cancel' && req.method === 'POST') {
    ctx.services.genRunner.cancel()
    sendJson(res, 200, { ok: true })
    return true
  }
  if (pathname === '/api/gen/resume' && req.method === 'POST') {
    ctx.services.genRunner.resume()
    sendJson(res, 200, { ok: true })
    return true
  }

  return false
}
