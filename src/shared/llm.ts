import type { FieldValues } from './blockDoc'
import { normalizeWorkspace, type Workspace } from './workspace'

/**
 * 一轮 LLM 交互的入参、过程事件与结果。主进程与渲染进程共用。
 *
 * 指令区的每个开关都是「和 LLM 交互的设置」，与提示词编辑互不相干（规格 §9、界面稿第 3 版）。
 */

/** 多角色：关闭 / 位置由模型安排 / 手动指定坐标。后两者用 generate_image_characters，区别只在回填时是否打开「使用坐标定位」 */
export type MultiCharacterMode = 'off' | 'auto' | 'coords'
export const MULTI_CHARACTER_MODES: readonly MultiCharacterMode[] = ['off', 'auto', 'coords']

/** 画风三选一（规格 §8）。preset 的 tags 由渲染进程从选中的预设里取好 */
export type StyleLock = { mode: 'none' } | { mode: 'preset'; tags: string } | { mode: 'current' }

export interface LlmRunInput {
  instruction: string
  multiCharacter: MultiCharacterMode
  /** 在现有内容上修改：把 workspace 当 <现有参数> 注入 */
  editExisting: boolean
  /** 强制透明背景（不覆盖模型已判断为 true 的情况） */
  transparent: boolean
  style: StyleLock
  /** 按下发送那一刻的工作区快照。修改模式与「用当前 artist 块覆盖」从这里取 */
  workspace: Workspace
}

export type LogLevel = 'I' | 'W' | 'E'

/** 日志区的一行，照 koishi LOG：`12:30:09 [I] search_tags 结果: …` */
export interface LlmLogLine {
  time: string
  level: LogLevel
  text: string
}

export type LlmEvent =
  | { kind: 'log'; line: LlmLogLine }
  /** 进入第 round 轮（从 1 数）。状态条「运行中 · 第 2 / 10 轮」用 */
  | { kind: 'round'; round: number; maxRounds: number }
  /**
   * 一轮结束。与日志行走同一条通道，先后有保证——invoke 的返回值走另一条通道，
   * 实测会早于最后几行日志到达。渲染进程以这条事件为准收尾。
   */
  | { kind: 'finished'; result: LlmRunResult }

export interface FillCharacter {
  /** CHARACTER_FIELDS 五项 */
  fields: FieldValues
  /** 已追加过设置里的角色默认负面词 */
  negative: string
  /** 模型给的原样：自由坐标 "x,y" 或网格 "B3"，可能为空 */
  position: string
}

/**
 * 回填内容 = 本来要发给 NovelAI 的最终参数。插件在出图前做的处理全部已经做完，
 * 回填本身不再做任何处理，所以不存在「没回填」的值。
 * 唯一例外是 text：原样带出，出图拼接时再按插件规则处理（计划 4）。
 */
export interface FillResult {
  /** MAIN_FIELDS 十项，每项单行 */
  main: FieldValues
  text: string
  negative: string
  aspectRatio: string
  width: number
  height: number
  transparentBackground: boolean
  /** 单角色工具时为空数组 */
  characters: FillCharacter[]
  useCoords: boolean
}

export type LlmRunResult =
  | { status: 'filled'; fill: FillResult; rounds: number; elapsedMs: number }
  | { status: 'noParams'; rounds: number; elapsedMs: number }
  | { status: 'failed'; rounds: number; elapsedMs: number; message: string }
  | { status: 'aborted'; rounds: number; elapsedMs: number }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseStyleLock(v: unknown): StyleLock | null {
  if (!isRecord(v)) return null
  if (v.mode === 'none') return { mode: 'none' }
  if (v.mode === 'current') return { mode: 'current' }
  if (v.mode === 'preset' && typeof v.tags === 'string') return { mode: 'preset', tags: v.tags }
  return null
}

/**
 * IPC 边界的入参校验。合法时返回整理好的入参，不合法时返回一句原因。
 * workspace 一律过 normalizeWorkspace——渲染进程发来的快照同样不可信。
 */
export function parseLlmRunInput(raw: unknown): LlmRunInput | string {
  if (!isRecord(raw)) return 'llm:run 入参无效'
  if (typeof raw.instruction !== 'string') return 'llm:run 缺少指令文本'
  const multi = MULTI_CHARACTER_MODES.find((m) => m === raw.multiCharacter)
  if (multi === undefined) return 'llm:run 的多角色选项无效'
  if (typeof raw.editExisting !== 'boolean' || typeof raw.transparent !== 'boolean') return 'llm:run 的开关选项无效'
  const style = parseStyleLock(raw.style)
  if (style === null) return 'llm:run 的画风选项无效'
  return {
    instruction: raw.instruction,
    multiCharacter: multi,
    editExisting: raw.editExisting,
    transparent: raw.transparent,
    style,
    workspace: normalizeWorkspace(raw.workspace),
  }
}
