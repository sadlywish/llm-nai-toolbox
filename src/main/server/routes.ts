// 手机端只读接口：meta / styles / history / usage（计划 Task 5）。
//
// 不 import electron：同 http.ts、devices.ts，服务层要能在 node 下单独跑测试。
// 这里只读、不碰任何写盘路径——画风与工作区的写接口是 Task 7 起的事。
import type { IncomingMessage, ServerResponse } from 'http'
import { basename } from 'path'
import pkgJson from '../../../package.json'
import { CHARACTER_FIELDS, MAIN_FIELDS, orderSpecs } from '../../shared/fields'
import { MOBILE_API_VERSION, type MobileMeta, type MobileStylesResult } from '../../shared/mobileApi'
import { MODEL_OPTIONS, NOISE_SCHEDULE_OPTIONS, SAMPLER_OPTIONS } from '../../shared/naiOptions'
import type { NaiSubscriptionResult } from '../../shared/naiUser'
import { normalizeStyles } from '../../shared/styles'
import { normalizeWorkspace } from '../../shared/workspace'
import type { AppEvents } from '../appEvents'
import { loadRecentRounds } from '../nai/index-store'
// t5.ts 在 renderer 目录下，但只用到与 DOM/React 无关的纯函数；shared/blockMetrics 已经这样
// 跨目录 import（见 electron.vite.config.ts 里 @renderer 别名的注释），这里是同一条路子。
import { tokenLimitFor } from '../../renderer/src/prompt/t5'
import type { PairedDevice } from './devices'
import { sendJson, type ServerDeps } from './http'

/** 只读与写接口共用的上下文：ServerDeps 加上已经验过令牌的那台设备 */
export type ApiContext = ServerDeps & { device: PairedDevice }

/**
 * 出图是否在途。GenRunner 的在途保护是它自己的私有字段，没有对外暴露的 busy
 * 访问器（见 gen/runner.ts 的 `running`），只能从它经 AppEvents 广播出来的进度
 * 反推：running/paused 算在跑，done/cancelled/aborted 算收尾。
 *
 * 按 AppEvents 实例缓存：不管一个服务实例上来多少次 /api/meta 请求，事件订阅
 * 只挂一次，不会越挂越多。
 */
const genBusyState = new WeakMap<AppEvents, { busy: boolean }>()

function subscribeGenBusy(events: AppEvents): { busy: boolean } {
  const state = { busy: false }
  events.on((e) => {
    if (e.kind === 'gen-progress') state.busy = e.progress.status === 'running' || e.progress.status === 'paused'
  })
  genBusyState.set(events, state)
  return state
}

function isGenBusy(events: AppEvents): boolean {
  return (genBusyState.get(events) ?? subscribeGenBusy(events)).busy
}

function buildMeta(ctx: ApiContext): MobileMeta {
  const config = ctx.services.configStore.read()
  // AppConfig.model 是 LLM 聊天模型（claude-sonnet-5 这类），不是出图模型——出图模型是
  // 工作区参数（GenParams.model），跟随「当前用的是哪个 NAI 模型」走。token 上限要按后者算，
  // 按 LLM 模型算的话 V5 出图配 legacy 上限（或反过来）会把警戒线定错
  const naiModel = normalizeWorkspace(ctx.services.workspaceStore.read()).params.model
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
    tokenLimit: tokenLimitFor(naiModel),
    // 只给目录名用于展示：完整路径可能带用户名之类的信息，绝不该出现在响应里（Global Constraints）
    saveDirName: basename(config.saveDir),
    busy: { llm: ctx.services.llmSession.busy, gen: isGenBusy(ctx.services.events) },
  }
}

function buildStyles(ctx: ApiContext): MobileStylesResult {
  const styles = normalizeStyles(ctx.services.stylesStore.read())
  const workspace = normalizeWorkspace(ctx.services.workspaceStore.read())
  return { styles, presetId: workspace.console.presetId }
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

/**
 * 手机端只读接口的分发。返回 false 表示这条路径（或这个方法）不是这里认识的 API，
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

  return false
}
