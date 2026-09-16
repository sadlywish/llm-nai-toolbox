// 手机端业务接口：meta / styles / history / usage（Task 5）、图片（Task 6）、
// 画风写接口（Task 7）、LLM 与 SSE（Task 8）。
//
// 不 import electron：同 http.ts、devices.ts，服务层要能在 node 下单独跑测试。
import type { IncomingMessage, ServerResponse } from 'http'
import { basename } from 'path'
import pkgJson from '../../../package.json'
import { CHARACTER_FIELDS, MAIN_FIELDS, orderSpecs } from '../../shared/fields'
import { newId } from '../../shared/ids'
import { parseLlmRunInput, type LlmEvent, type LlmRunInput } from '../../shared/llm'
import { MOBILE_API_VERSION, type MobileEvent, type MobileMeta, type MobileStylesResult } from '../../shared/mobileApi'
import { MODEL_OPTIONS, NOISE_SCHEDULE_OPTIONS, SAMPLER_OPTIONS } from '../../shared/naiOptions'
import type { NaiSubscriptionResult } from '../../shared/naiUser'
import { normalizeStyles, type StylePreset } from '../../shared/styles'
import { normalizeWorkspace } from '../../shared/workspace'
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
    // 只给目录名用于展示：完整路径可能带用户名之类的信息，绝不该出现在响应里（Global Constraints）
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
 * `LlmEvent` → `MobileEvent`。两套类型没有合并是有意的：SSE 这条通道只走手机端用得上的字段，
 * 主进程内部的事件将来加了什么，不该自动漏到局域网上去。
 */
function toMobileEvent(e: LlmEvent): MobileEvent {
  if (e.kind === 'log') return { kind: 'llm-log', line: e.line }
  if (e.kind === 'round') return { kind: 'llm-round', round: e.round, maxRounds: e.maxRounds }
  return { kind: 'llm-finished', result: e.result }
}

/**
 * 开跑并把这一轮的事件转推给所有 SSE 连接。不返回 Promise：调用方那时已经回过话了，
 * 这一轮的成败只经 SSE 送达。
 *
 * 回填结果也只经 `llm-finished` 给手机，服务端绝不写 workspace.json（Global Constraints）——
 * 桌面端那份工作区是桌面端的，手机自己应用自己那一份。
 */
function startLlmRun(ctx: ApiContext, input: LlmRunInput): void {
  const startedAt = Date.now()
  const run = ctx.services.llmSession.run(input, (e) => ctx.hub.push(toMobileEvent(e)))
  void run.catch((err: unknown) => {
    // runLlm 自己兜住了所有失败（返回 failed/aborted），能抛到这里的是依赖没接上一类的问题。
    // 不接住的话：主进程里多一个未处理的 rejection，手机那头还会一直等一条永远不来的收尾事件
    ctx.hub.push({
      kind: 'llm-finished',
      result: { status: 'failed', rounds: 0, elapsedMs: Date.now() - startedAt, message: errorMessage(err) },
    })
  })
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
  startLlmRun(ctx, input)
  sendJson(res, 200, { ok: true })
}

/** `POST /api/llm/abort`：没有在途那一轮时也回 200——手机上重复点「中止」不该看到报错 */
function handleLlmAbort(res: ServerResponse, ctx: ApiContext): void {
  ctx.services.llmSession.abort()
  sendJson(res, 200, { ok: true })
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

  return false
}
