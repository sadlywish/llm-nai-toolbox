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
import { loadRecentRounds } from '../nai/index-store'
import type { PairedDevice } from './devices'
import { sendJson, type ServerDeps } from './http'

/** 只读与写接口共用的上下文：ServerDeps 加上已经验过令牌的那台设备 */
export type ApiContext = ServerDeps & { device: PairedDevice }

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
