import type { ApiType } from './config'
import { CHARACTER_FIELDS, MAIN_FIELDS } from './fields'
import type { MultiCharacterMode } from './llm'
import type { GenParams, StyleMode, Workspace } from './workspace'

/**
 * 「当前提示词出自哪次 LLM 请求」。LLM 回填成功时记进工作区，之后每轮生成都带进快照，
 * 溯源信息「本工具参数」里显示（界面稿 2026-09-15-llm-provenance-mockup.html 位置 B）。
 *
 * 这个文件只 type 引用 workspace/llm：workspace.ts 要用这里的 normalizeWorkspaceLlm，
 * 反过来引值会成环。枚举列表因此在这里单写一份。
 */

/** 按下发送那一刻的请求选项，加上回填时的轮数与用时 */
export interface LlmRequestInfo {
  apiType: ApiType
  model: string
  instruction: string
  multiCharacter: MultiCharacterMode
  editExisting: boolean
  transparent: boolean
  styleMode: StyleMode
  /** 画风档位为「用预设画风覆盖」时，发送那一刻的预设名；其余为 ''。之后改名、删掉不影响记录 */
  presetName: string
  autoGenerate: boolean
  /** LLM 跑了几轮 */
  llmRounds: number
  elapsedMs: number
}

/** 工作区里挂着的来源 */
export interface WorkspaceLlm {
  request: LlmRequestInfo
  /** 回填（或复制信息）之后那一刻的内容指纹，生成时对不上 = 手工改过 */
  fingerprint: string
  /** 复制信息从一条已经手改过的记录带过来时为 true */
  stale: boolean
}

/** 快照里的来源。快照上缺这个键 = 这项功能之前的旧记录；null = 没经过 LLM */
export interface SnapshotLlm {
  request: LlmRequestInfo
  stale: boolean
}

/** 参数里除 seed 以外的项：每张随机模式出图后会自动回写 seed，不能算手改 */
const PARAM_KEYS: readonly Exclude<keyof GenParams, 'seed'>[] = [
  'model',
  'width',
  'height',
  'steps',
  'scale',
  'sampler',
  'noiseSchedule',
  'cfgRescale',
  'seedMode',
  'transparentBackground',
]

/**
 * 会进这一轮出图的内容：整图字段、画面文字、负面词、角色（含是否参与）、使用坐标定位、参数（不含 seed）。
 * 按固定顺序取值再序列化，不依赖对象键的插入顺序。指令区、跑图次数不算。
 */
export function contentFingerprint(ws: Workspace): string {
  return JSON.stringify([
    MAIN_FIELDS.map((s) => ws.main[s.name] ?? ''),
    ws.text,
    ws.negative,
    ws.characters.map((c) => [c.enabled, CHARACTER_FIELDS.map((s) => c.fields[s.name] ?? ''), c.negative, c.position]),
    ws.useCoords,
    PARAM_KEYS.map((k) => ws.params[k]),
  ])
}

/** 按当前内容给工作区挂上来源 */
export function attachLlm(ws: Workspace, request: LlmRequestInfo, stale: boolean): void {
  ws.llm = { request, fingerprint: contentFingerprint(ws), stale }
}

/** 生成时写进快照的来源 */
export function snapshotLlmOf(ws: Workspace): SnapshotLlm | null {
  if (ws.llm === null) return null
  return { request: ws.llm.request, stale: ws.llm.stale || contentFingerprint(ws) !== ws.llm.fingerprint }
}

const API_TYPES: readonly ApiType[] = ['claude', 'openai']
const MULTI_MODES: readonly MultiCharacterMode[] = ['off', 'auto', 'coords']
const STYLE_MODES: readonly StyleMode[] = ['none', 'preset', 'current']

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

function parseRequest(raw: unknown): LlmRequestInfo | null {
  if (!isRecord(raw)) return null
  const apiType = API_TYPES.find((t) => t === raw.apiType)
  const multiCharacter = MULTI_MODES.find((m) => m === raw.multiCharacter)
  const styleMode = STYLE_MODES.find((m) => m === raw.styleMode)
  if (apiType === undefined || multiCharacter === undefined || styleMode === undefined) return null
  if (typeof raw.model !== 'string' || typeof raw.instruction !== 'string' || typeof raw.presetName !== 'string') return null
  if (typeof raw.editExisting !== 'boolean' || typeof raw.transparent !== 'boolean' || typeof raw.autoGenerate !== 'boolean') return null
  if (!isCount(raw.llmRounds) || !isCount(raw.elapsedMs)) return null
  return {
    apiType,
    model: raw.model,
    instruction: raw.instruction,
    multiCharacter,
    editExisting: raw.editExisting,
    transparent: raw.transparent,
    styleMode,
    presetName: raw.presetName,
    autoGenerate: raw.autoGenerate,
    llmRounds: raw.llmRounds,
    elapsedMs: raw.elapsedMs,
  }
}

/** 工作区文件里读回来的来源；形状不对按「没有来源」处理 */
export function normalizeWorkspaceLlm(raw: unknown): WorkspaceLlm | null {
  if (!isRecord(raw) || typeof raw.fingerprint !== 'string' || typeof raw.stale !== 'boolean') return null
  const request = parseRequest(raw.request)
  return request === null ? null : { request, fingerprint: raw.fingerprint, stale: raw.stale }
}

/**
 * 历史记录里读回来的快照来源（_index.json 不做深层规范化，渲染前过这里）。
 * undefined = 旧记录或形状不对，说不清有没有经过 LLM；null = 确定没经过。
 */
export function readSnapshotLlm(raw: unknown): SnapshotLlm | null | undefined {
  if (raw === null) return null
  if (!isRecord(raw) || typeof raw.stale !== 'boolean') return undefined
  const request = parseRequest(raw.request)
  return request === null ? undefined : { request, stale: raw.stale }
}
