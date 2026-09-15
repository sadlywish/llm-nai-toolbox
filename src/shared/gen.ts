import type { FieldValues } from './blockDoc'
import type { SnapshotLlm } from './llmProvenance'
import { normalizeWorkspace, type GenParams, type Workspace } from './workspace'

/**
 * 出图（计划 4）主进程与渲染进程共用的类型。
 *
 * 结构照画师串工具箱的 run/nai 模块，领域从「画师串 × 例图」换成「一套提示词出 N 张」。
 */

export type NaiErrorKind = 'no-token' | 'unauthorized' | 'payment' | 'concurrent' | 'http' | 'timeout' | 'network' | 'empty'

export interface NaiError {
  kind: NaiErrorKind
  message: string
}

export interface NaiImage {
  /** base64 */
  data: string
  mimeType: string
  /** 接口回报的 seed；zip 路径拿不到，为 null */
  seed: number | null
}

export type GenerateResult = { ok: true; images: NaiImage[] } | { ok: false; error: NaiError }

export type RunStatus = 'idle' | 'running' | 'paused' | 'done' | 'cancelled' | 'aborted'

/** 落盘的轮次状态。interrupted 只在读取时推导（running/paused 不可能跨重启存活），不落盘 */
export type RoundStatus = 'running' | 'paused' | 'done' | 'cancelled' | 'aborted' | 'interrupted'

export interface RunProgress {
  roundId: string
  status: RunStatus
  total: number
  done: number
  failed: number
  pauseReason: string | null
  abortReason: string | null
  /** 正在发出请求的那一张（从 0 数）；暂停与结束时为 null——暂停时那张还在队首没发出去 */
  current: number | null
}

/** 一轮里的一张：第几张 + 这张用的 seed（开跑前就分配好） */
export interface GenTask {
  index: number
  seed: number
}

export interface SnapshotCharacter {
  fields: FieldValues
  negative: string
  position: string
}

/**
 * 按下「生成」那一刻的本工具格式快照。形状与 Workspace 的对应部分一致，
 * 4B 的「本工具参数」页签按它显示，「复制信息」按它整套覆盖回参数区。
 * 角色只含参与本轮（enabled）的。
 */
export interface GenSnapshot {
  main: FieldValues
  text: string
  negative: string
  characters: SnapshotCharacter[]
  useCoords: boolean
  /** 固定 seed 模式且 seed 为 -1 时，这里记的是开跑时随机出来的那个值 */
  params: GenParams
  /**
   * 产出这些提示词的 LLM 请求；null = 没经过 LLM。这项功能之前落盘的记录没有这个键，
   * 读的时候一律过 readSnapshotLlm
   */
  llm?: SnapshotLlm | null
}

export interface NaiCenter {
  x: number
  y: number
}

/** 真正发给 NovelAI 的拼接结果（「拼接结果」展示用） */
export interface AssembledPrompt {
  /** 按字段顺序拼接、再经画面文字处理之后的正向提示词 */
  positive: string
  negative: string
  characters: Array<{ prompt: string; negative: string; center: NaiCenter }>
}

export interface ImageRecord {
  /** 这一轮的第几张，从 0 数 */
  index: number
  /** 当日目录下的裸文件名；失败为 '' */
  file: string
  /** 实际用的 seed：接口回报 → PNG 元数据 → 请求时的值 */
  seed: number
  status: 'ok' | 'failed'
  error: string | null
}

export interface RoundRecord {
  id: string
  /** ISO 时间；决定落在哪个日期目录 */
  startedAt: string
  finishedAt: string | null
  status: RoundStatus
  /** 跑图次数 */
  count: number
  snapshot: GenSnapshot
  assembled: AssembledPrompt
  images: ImageRecord[]
}

export interface IndexFile {
  version: 1
  rounds: RoundRecord[]
}

export interface GenImageEvent extends ImageRecord {
  roundId: string
}

export interface GenStartInput {
  workspace: Workspace
  count: number
}

export interface ReadImageInput {
  roundStartedAt: string
  file: string
}

/** 直接从图片文件里读到的元信息（「图片元信息」页签用） */
export interface ImageMeta {
  /** PNG 的全部 tEXt / iTXt 文本块，原样 */
  chunks: Record<string, string>
  /** Comment 等参数块里的 seed；读不到为 null */
  seed: number | null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** gen:start 的入参校验。IPC 边界不可信：工作区一律过 normalizeWorkspace */
export function parseGenStartInput(raw: unknown): GenStartInput | string {
  if (!isRecord(raw)) return 'gen:start 入参无效'
  const count = raw.count
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) return '跑图次数必须是正整数'
  return { workspace: normalizeWorkspace(raw.workspace), count }
}
