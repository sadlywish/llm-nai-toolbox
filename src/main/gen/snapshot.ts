import type { AppConfig } from '@shared/config'
import { CHARACTER_FIELDS, MAIN_FIELDS, orderSpecs } from '@shared/fields'
import type { AssembledPrompt, GenSnapshot } from '@shared/gen'
import { snapshotLlmOf } from '@shared/llmProvenance'
import { buildPrompt } from '@shared/prompt'
import type { Workspace } from '@shared/workspace'
import { positionToCenter } from '../nai/payload'
import { applyTextRendering } from '../nai/text'

/**
 * 按下「生成」那一刻的本工具格式快照。全部是副本：生成途中改编辑器不影响这一轮，
 * 快照也不会被之后的编辑悄悄改掉。只收参与本轮的角色。
 */
export function takeSnapshot(ws: Workspace, resolvedFixedSeed: number | null): GenSnapshot {
  return {
    main: { ...ws.main },
    text: ws.text,
    negative: ws.negative,
    characters: ws.characters
      .filter((c) => c.enabled)
      .map((c) => ({ fields: { ...c.fields }, negative: c.negative, position: c.position })),
    useCoords: ws.useCoords,
    params: resolvedFixedSeed === null ? { ...ws.params } : { ...ws.params, seed: resolvedFixedSeed },
    // 手改判断要拿按下生成时的工作区比，不能拿上面换过 seed 的 params
    llm: snapshotLlmOf(ws),
  }
}

/**
 * 快照 → 真正发出去的拼接结果。字段顺序取设置里的 promptOrder / naiCharPromptOrder，
 * 画面文字按插件规则接到正向提示词末尾；角色负面词独立，只 trim。
 */
export function assemble(s: GenSnapshot, config: AppConfig): AssembledPrompt {
  const mainSpecs = orderSpecs(MAIN_FIELDS, config.promptOrder)
  const charSpecs = orderSpecs(CHARACTER_FIELDS, config.naiCharPromptOrder)
  return {
    positive: applyTextRendering(buildPrompt(s.main, mainSpecs), s.text).prompt,
    negative: s.negative.trim(),
    characters: s.characters.map((c) => ({
      prompt: buildPrompt(c.fields, charSpecs),
      negative: c.negative.trim(),
      center: positionToCenter(c.position),
    })),
  }
}
