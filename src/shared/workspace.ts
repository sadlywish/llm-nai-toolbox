import { emptyValues, sanitizeFieldText, type FieldValues } from './blockDoc'
import { CHARACTER_FIELDS, MAIN_FIELDS, type FieldSpec } from './fields'
import { newId } from './ids'
import type { MultiCharacterMode } from './llm'
import { NOISE_SCHEDULE_OPTIONS, SAMPLER_OPTIONS } from './naiOptions'

/** seed 分配策略：每张随机，或固定用参数区里的 seed */
export type SeedMode = 'fixed' | 'perImage'

/**
 * 生成参数。没有负面预设、质量词开关与 Variety Boost：工具主要面向 V5，V5 不支持 Variety Boost；
 * 官网的默认正面/负面词不悄悄加进请求，将来要用也是在设置里选「用官网配置覆盖」。
 */
export interface GenParams {
  model: string
  width: number
  height: number
  steps: number
  /** Guidance / CFG */
  scale: number
  sampler: string
  noiseSchedule: string
  cfgRescale: number
  /** perImage 模式下该值不参与计算，仅用于展示与回填 */
  seed: number
  seedMode: SeedMode
  transparentBackground: boolean
}

export interface CharacterPrompt {
  id: string
  /** 是否参与本轮生成 */
  enabled: boolean
  /** 角色的五项提示词字段（CHARACTER_FIELDS），由分块编辑器编辑 */
  fields: FieldValues
  negative: string
  /** 自由坐标 "0.3,0.5" 或 5×5 网格 "B3"，留空即居中 */
  position: string
}

export type StyleMode = 'none' | 'preset' | 'current'

/** 指令区的输入与开关。随工作区保存，重开应用时还是上次的样子 */
export interface ConsoleOptions {
  instruction: string
  /** 多角色：关闭 / 位置由模型安排 / 手动指定坐标 */
  multiCharacter: MultiCharacterMode
  /** 在现有内容上修改 */
  editExisting: boolean
  /** 透明背景 */
  transparent: boolean
  /** 画风：不覆盖 / 用预设画风覆盖 / 用当前 artist 块覆盖 */
  styleMode: StyleMode
  /** 当前预设画风的 id（画风维护里「选为预设画风」的那条）；'' = 未选择。和档位各管各的，选预设不动档位 */
  presetId: string
  /** 回填后自动生成：LLM 回填成功后直接按跑图次数开始生成 */
  autoGenerate: boolean
}

/**
 * 当前工作状态（workspace.json）。
 *
 * `text` 是画面内文字：它在提示词拼接完成之后才接到末尾，提示词排序里没有
 * 它的位置，所以不在 main 的字段里，单独一项。
 */
export interface Workspace {
  main: FieldValues
  text: string
  negative: string
  params: GenParams
  characters: CharacterPrompt[]
  /** 角色坐标是否发送给 NAI；关闭时由模型安排位置 */
  useCoords: boolean
  /** 跑图次数：手动生成与「回填后自动生成」共用 */
  runCount: number
  console: ConsoleOptions
}

/**
 * 默认生成参数，照插件 NovelAI 配置的默认值。宽高是插件默认像素上限
 * 1024×1024 按 1:1 换算的结果。每次新建对象。
 */
export function defaultGenParams(): GenParams {
  return {
    model: 'nai-diffusion-5-full',
    width: 1024,
    height: 1024,
    steps: 28,
    scale: 5,
    sampler: 'k_euler_ancestral',
    noiseSchedule: 'karras',
    cfgRescale: 0,
    seed: -1,
    seedMode: 'perImage',
    transparentBackground: false,
  }
}

export function defaultConsoleOptions(): ConsoleOptions {
  return { instruction: '', multiCharacter: 'off', editExisting: false, transparent: false, styleMode: 'none', presetId: '', autoGenerate: false }
}

export function createCharacter(): CharacterPrompt {
  return {
    id: newId('ch'),
    enabled: true,
    fields: emptyValues(CHARACTER_FIELDS),
    negative: '',
    position: '',
  }
}

export function emptyWorkspace(): Workspace {
  return {
    main: emptyValues(MAIN_FIELDS),
    text: '',
    negative: '',
    params: defaultGenParams(),
    characters: [],
    useCoords: false,
    runCount: 1,
    console: defaultConsoleOptions(),
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * 字段值只认字段集里有的名字；值里的换行与分隔符剥掉——分块文档必须是
 * 单行（见 blockDoc.ts），手改出来的换行会让装饰整片消失。
 */
function normalizeValues(raw: unknown, specs: readonly FieldSpec[]): FieldValues {
  const out = emptyValues(specs)
  if (!isRecord(raw)) return out
  for (const spec of specs) out[spec.name] = sanitizeFieldText(str(raw[spec.name]))
  return out
}

function normalizeParams(raw: unknown): GenParams {
  const base = defaultGenParams()
  if (!isRecord(raw)) return base
  const out = { ...base } as Record<keyof GenParams, unknown>
  for (const key of Object.keys(base) as (keyof GenParams)[]) {
    const v = raw[key]
    if (typeof v !== typeof base[key]) continue
    if (typeof v === 'number' && !Number.isFinite(v)) continue
    out[key] = v
  }
  const params = out as GenParams
  if (params.seedMode !== 'fixed' && params.seedMode !== 'perImage') params.seedMode = base.seedMode
  // sampler / noiseSchedule 是接口认的固定字面量（见 naiOptions.ts）：
  // 类型对但值不在选项表里（如手改文件、旧版本遗留值）一样要回默认值，
  // 否则下拉框会显示成空白，真正发起生成时又会被 NovelAI 报 400。
  // model 不做这层校验——V5 系列模型名未公布，允许用户填自定义名（见 ParamsPanel 的「自定义」入口）。
  if (!SAMPLER_OPTIONS.includes(params.sampler)) params.sampler = base.sampler
  if (!NOISE_SCHEDULE_OPTIONS.includes(params.noiseSchedule)) params.noiseSchedule = base.noiseSchedule
  return params
}

const MULTI_MODES: readonly MultiCharacterMode[] = ['off', 'auto', 'coords']
const STYLE_MODES: readonly StyleMode[] = ['none', 'preset', 'current']

function normalizeConsole(raw: unknown): ConsoleOptions {
  const base = defaultConsoleOptions()
  if (!isRecord(raw)) return base
  return {
    instruction: str(raw.instruction),
    multiCharacter: MULTI_MODES.find((m) => m === raw.multiCharacter) ?? base.multiCharacter,
    editExisting: typeof raw.editExisting === 'boolean' ? raw.editExisting : base.editExisting,
    transparent: typeof raw.transparent === 'boolean' ? raw.transparent : base.transparent,
    styleMode: STYLE_MODES.find((m) => m === raw.styleMode) ?? base.styleMode,
    presetId: str(raw.presetId),
    autoGenerate: typeof raw.autoGenerate === 'boolean' ? raw.autoGenerate : base.autoGenerate,
  }
}

/**
 * 读回的工作区补齐 + 自愈。任何来源（旧版本文件、手改、IPC 传进来的）
 * 都先过这里，界面与主进程拿到的永远是完整合法的形状。
 */
export function normalizeWorkspace(raw: unknown): Workspace {
  const base = emptyWorkspace()
  if (!isRecord(raw)) return base

  const seen = new Set<string>()
  const characters: CharacterPrompt[] = []
  if (Array.isArray(raw.characters)) {
    for (const c of raw.characters) {
      if (!isRecord(c)) continue
      // 缺 id 或 id 重复都补新的：重复 id 会让两个角色共用一个编辑器实例与 undo 栈
      let id = typeof c.id === 'string' && c.id !== '' ? c.id : newId('ch')
      if (seen.has(id)) id = newId('ch')
      seen.add(id)
      characters.push({
        id,
        enabled: typeof c.enabled === 'boolean' ? c.enabled : true,
        fields: normalizeValues(c.fields, CHARACTER_FIELDS),
        negative: str(c.negative),
        position: str(c.position),
      })
    }
  }

  return {
    main: normalizeValues(raw.main, MAIN_FIELDS),
    text: str(raw.text),
    negative: str(raw.negative),
    params: normalizeParams(raw.params),
    characters,
    useCoords: typeof raw.useCoords === 'boolean' ? raw.useCoords : base.useCoords,
    runCount: typeof raw.runCount === 'number' && Number.isInteger(raw.runCount) && raw.runCount >= 1 ? raw.runCount : base.runCount,
    console: normalizeConsole(raw.console),
  }
}
