import type { ApiType } from './config'
import type { LlmRunInput, StyleLock } from './llm'
import type { LlmRequestInfo } from './llmProvenance'
import { usableStyles, type StylePreset } from './styles'
import type { ConsoleOptions, Workspace } from './workspace'

/** 按下发送那一刻的入参：指令区选项 + 工作区快照；「用预设画风覆盖」在这里取好标签 */
export function buildRunInput(ws: Workspace, presets: readonly StylePreset[]): LlmRunInput {
  const o = ws.console
  return {
    instruction: o.instruction,
    multiCharacter: o.multiCharacter,
    editExisting: o.editExisting,
    transparent: o.transparent,
    style: styleLockOf(o, presets),
    workspace: ws,
  }
}

/** 回填成功前还不知道轮数与用时的那部分请求记录 */
export type PendingLlmRequest = Omit<LlmRequestInfo, 'llmRounds' | 'elapsedMs'>

/**
 * 按下发送那一刻的请求记录，与 buildRunInput 同一时刻取：跑的途中改指令区不影响这一轮的记录。
 * 预设名只在真按预设覆盖时记（预设已失效、按不覆盖发的也记成不覆盖）。
 */
export function pendingRequestOf(ws: Workspace, presets: readonly StylePreset[], api: { apiType: ApiType; model: string }): PendingLlmRequest {
  const o = ws.console
  const style = styleLockOf(o, presets)
  return {
    apiType: api.apiType,
    model: api.model,
    instruction: o.instruction,
    multiCharacter: o.multiCharacter,
    editExisting: o.editExisting,
    transparent: o.transparent,
    styleMode: style.mode,
    presetName: style.mode === 'preset' ? (currentPresetOf(o, presets)?.name ?? '') : '',
    autoGenerate: o.autoGenerate,
  }
}

function styleLockOf(o: ConsoleOptions, presets: readonly StylePreset[]): StyleLock {
  if (o.styleMode === 'current') return { mode: 'current' }
  if (o.styleMode === 'preset') {
    const preset = currentPresetOf(o, presets)
    // 预设已不可用时界面上已经退回「不覆盖」，这里只是兜底，同样按不覆盖发
    if (preset !== null) return { mode: 'preset', tags: preset.tags }
  }
  return { mode: 'none' }
}

/** 当前预设画风（画风维护里「选为预设画风」的那条）；没选、被删掉或标签为空时 null */
export function currentPresetOf(o: ConsoleOptions, presets: readonly StylePreset[]): StylePreset | null {
  return usableStyles(presets).find((p) => p.id === o.presetId) ?? null
}

/**
 * 预设选择失效了：记着的那条被删掉或清空，或者档位是「用预设画风覆盖」却没有可用预设。
 * 失效时预设变「未选择」、预设档退回「不覆盖」（clearStalePreset）。
 */
export function presetSelectionStale(o: ConsoleOptions, presets: readonly StylePreset[]): boolean {
  if (currentPresetOf(o, presets) !== null) return false
  return o.presetId !== '' || o.styleMode === 'preset'
}

/** 失效时清掉预设选择；没失效什么都不做 */
export function clearStalePreset(o: ConsoleOptions, presets: readonly StylePreset[]): void {
  if (!presetSelectionStale(o, presets)) return
  o.presetId = ''
  if (o.styleMode === 'preset') o.styleMode = 'none'
}
