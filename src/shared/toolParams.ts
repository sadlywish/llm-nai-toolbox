import { CHARACTER_FIELDS, fieldOrderError, MAIN_FIELDS, orderSpecs, type FieldSpec } from './fields'
import type { GenSnapshot } from './gen'
import type { GenParams } from './workspace'

/**
 * 溯源「本工具参数」的共用部分：桌面端出图弹窗的侧栏、手机端大图的参数页、主进程拼接都用。
 */

export interface SnapshotSpecs {
  main: readonly FieldSpec[]
  character: readonly FieldSpec[]
  /** 快照里没存顺序（这项功能之前的记录），或存的不合法，退回了调用方给的当前顺序 */
  legacy: boolean
}

/** 存下来的顺序串能不能用：必须是字符串，且恰好覆盖字段集（同设置页的校验） */
function savedOrder(specs: readonly FieldSpec[], order: unknown): readonly FieldSpec[] | null {
  if (typeof order !== 'string' || fieldOrderError(specs, order) !== null) return null
  return orderSpecs(specs, order)
}

/**
 * 这一轮的块按什么顺序排：快照里存了出图时的顺序就用它，没存才用 `current`（调用方按当前设置排好的）。
 *
 * 整图与角色分开判，任何一个退回了当前顺序都算旧记录——两项总是一起写进快照，
 * 只有一项能用只可能是记录被改坏了，照样提示「按当前字段顺序排列」。
 */
export function snapshotSpecs(
  s: GenSnapshot,
  current: { main: readonly FieldSpec[]; character: readonly FieldSpec[] },
): SnapshotSpecs {
  const main = savedOrder(MAIN_FIELDS, s.promptOrder)
  const character = savedOrder(CHARACTER_FIELDS, s.naiCharPromptOrder)
  return {
    main: main ?? current.main,
    character: character ?? current.character,
    legacy: main === null || character === null,
  }
}

/** 参数那一行。尺寸与 Seed 不在这里：两端都把它们单独放在最前面 */
export function paramsLine(p: GenParams): string {
  return `${p.model} · steps ${p.steps} · CFG ${p.scale} · CFG Rescale ${p.cfgRescale} · ${p.sampler} · ${p.noiseSchedule} · 透明背景 ${p.transparentBackground ? '开' : '关'}`
}
