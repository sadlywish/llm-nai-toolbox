import type { LlmRunInput, StyleLock } from './llm'
import { usableStyles, type StylePreset } from './styles'
import type { ConsoleOptions, StyleMode, Workspace } from './workspace'

/** 按下发送那一刻的入参：指令区选项 + 工作区快照；「用选用的预设覆盖」在这里取好标签 */
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

function styleLockOf(o: ConsoleOptions, presets: readonly StylePreset[]): StyleLock {
  if (o.styleMode === 'current') return { mode: 'current' }
  if (o.styleMode === 'preset') {
    const preset = usableStyles(presets).find((p) => p.id === o.presetId)
    // 选着的预设已不可用时界面上已经退回「不覆盖」，这里只是兜底，同样按不覆盖发
    if (preset !== undefined) return { mode: 'preset', tags: preset.tags }
  }
  return { mode: 'none' }
}

/** 选着「用选用的预设覆盖」，但那条预设被删掉或清空了——画风该退回「不覆盖」 */
export function presetSelectionStale(o: ConsoleOptions, presets: readonly StylePreset[]): boolean {
  return o.styleMode === 'preset' && !usableStyles(presets).some((p) => p.id === o.presetId)
}

/** 切换画风档位。切到预设档时，原来选着的预设仍可用就保留，否则默认第一条可用预设 */
export function selectStyleMode(o: ConsoleOptions, mode: StyleMode, presets: readonly StylePreset[]): void {
  o.styleMode = mode
  if (mode !== 'preset') return
  const usable = usableStyles(presets)
  if (!usable.some((p) => p.id === o.presetId)) o.presetId = usable[0]?.id ?? ''
}
