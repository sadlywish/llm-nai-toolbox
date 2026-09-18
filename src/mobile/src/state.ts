// 手机自己那一份状态（计划 Task 11、规格 §4）。
//
// 提示词、参数、角色、指令与指令区开关全在手机本地，和桌面端的 workspace.json 互不影响——
// 服务端处理手机请求时绝不写工作区（Global Constraints），所以这边不存就是真丢了。
import { normalizeWorkspace, type Workspace } from '@shared/workspace'

/** 工作区那一份。键里带 `:v1`，将来形状不兼容时换成 `:v2` 即可，老键留着不碍事 */
export const MOBILE_STATE_KEY = 'nai-mobile:v1'

/**
 * 连接信息单独一个键：它和工作区的写入时机完全不同（配对成功、令牌失效各一次），
 * 而且工作区那份是防抖写的——混在一起的话，配对完立刻刷新页面就会把令牌丢掉。
 */
export const MOBILE_CONN_KEY = 'nai-mobile:v1:conn'

/**
 * 停在哪个标签、上次看的是哪一轮出图。都是为了「切出去等结果，回来还在原地」——
 * 手机上页面随时可能被系统回收再重新加载，不存的话回来就是一张白纸（2026-09-18）。
 */
export const MOBILE_TAB_KEY = 'nai-mobile:v1:tab'
export const MOBILE_GEN_ROUND_KEY = 'nai-mobile:v1:gen-round'

/**
 * 工作区写盘防抖。手机上打字、拖滑块都会连着改状态，每次都 JSON.stringify 整份工作区
 * 会在低端机上卡出肉眼可见的顿挫。
 */
export const SAVE_DEBOUNCE_MS = 300

export interface Connection {
  baseUrl: string
  token: string
}

export interface MobileState {
  workspace: Workspace
  connection: Connection | null
}

/**
 * localStorage 不一定拿得到：隐私模式、站点数据被禁用时，取它本身就会抛。
 * 拿不到就当没有——存不下总比整个界面白屏强。
 */
function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** 读一个键。没存过、存坏了、根本拿不到 localStorage，一律当没存过（llmPending.ts 也用这一对） */
export function readKey(key: string): unknown {
  const store = storage()
  if (store === null) return null
  try {
    const raw = store.getItem(key)
    return raw === null ? null : (JSON.parse(raw) as unknown)
  } catch {
    // 手改过、写到一半断电、上个版本存的格式——一律当没存过，由默认值兜底
    return null
  }
}

/** 写一个键，value 为 null 即删掉 */
export function writeKey(key: string, value: unknown): void {
  const store = storage()
  if (store === null) return
  try {
    if (value === null) store.removeItem(key)
    else store.setItem(key, JSON.stringify(value))
  } catch {
    // 配额满了、隐私模式：这一次存不下，不该把调用方（一次输入、一次配对）带崩
  }
}

function normalizeConnection(raw: unknown): Connection | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const { baseUrl, token } = raw as Record<string, unknown>
  // 缺一半的连接信息没有任何用处：拿它去发请求只会得到一串 404/401，不如当没连过回到连接页
  if (typeof baseUrl !== 'string' || baseUrl === '') return null
  if (typeof token !== 'string' || token === '') return null
  return { baseUrl, token }
}

export function loadConnection(): Connection | null {
  return normalizeConnection(readKey(MOBILE_CONN_KEY))
}

/** 立刻落盘，不走防抖：配对成功之后页面随时可能被刷掉（用户切 App、系统回收），丢了要重新配对 */
export function saveConnection(connection: Connection | null): void {
  writeKey(MOBILE_CONN_KEY, connection)
}

/** 读的时候一律过 normalizeWorkspace：存进去的可能是旧版本的形状，也可能被手改过 */
/**
 * 上次停在哪个标签。存的值不在 `allowed` 里（换过版本、被人改过）就回工作台——
 * 标签是外壳的骨架，宁可回默认也不能因为一个坏值让页面渲染不出来。
 */
export function loadTab<T extends string>(allowed: readonly T[], fallback: T): T {
  const raw = readKey(MOBILE_TAB_KEY)
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback
}

export function saveTab(tab: string): void {
  writeKey(MOBILE_TAB_KEY, tab)
}

/** 上次看的那一轮出图的 id；没有为 null */
export function loadGenRound(): string | null {
  const raw = readKey(MOBILE_GEN_ROUND_KEY)
  return typeof raw === 'string' && raw !== '' ? raw : null
}

export function saveGenRound(roundId: string): void {
  writeKey(MOBILE_GEN_ROUND_KEY, roundId)
}

export function loadWorkspace(): Workspace {
  return normalizeWorkspace(readKey(MOBILE_STATE_KEY))
}

export function loadState(): MobileState {
  return { workspace: loadWorkspace(), connection: loadConnection() }
}

let timer: ReturnType<typeof setTimeout> | null = null
let pending: Workspace | null = null

function flushWorkspace(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  if (pending === null) return
  const workspace = pending
  pending = null
  writeKey(MOBILE_STATE_KEY, workspace)
}

export function saveWorkspace(workspace: Workspace): void {
  pending = workspace
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(flushWorkspace, SAVE_DEBOUNCE_MS)
}

export function saveState(state: MobileState): void {
  saveConnection(state.connection)
  saveWorkspace(state.workspace)
}

/** 把还没到点的那一份立刻写下去。页面切后台（pagehide）时调一次，省得最后几笔改动丢掉 */
export function flushState(): void {
  flushWorkspace()
}
