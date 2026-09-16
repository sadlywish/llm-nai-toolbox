import type { FieldValues } from './blockDoc'
import type { FieldSpec } from './fields'
import { applyTextRendering } from './textRendering'

/**
 * 提示词拼接。与 koishi-plugin-reforge 的 `buildPrompt`（src/utils.ts）逐条一致：
 *   按字段顺序取值 → 各自 trim → 跳过空值 → 用 ` , ` 连接 → 末尾补 ` ,`
 *
 * 字段顺序就是 `specs` 的顺序：调用方按 promptOrder 排好字段集再传进来，
 * 分块编辑器用的是同一份排好的字段集，所以编辑器里块的先后与拼接结果一致。
 *
 * 插件的 `enableNltags`（把 nltags 挪到末尾另起一行）不实现。
 *
 * 字段值内部不做任何规整：自带的尾逗号原样保留，`solo,` 拼出来是 `solo, ,`。
 * 分块编辑器照这个样子渲染，保证框里看到的与最终发出去的一致。
 */
export function buildPrompt(values: FieldValues, specs: readonly FieldSpec[]): string {
  const parts = specs
    .map((spec) => values[spec.name] ?? '')
    .filter(joinsPrompt)
    .map((value) => value.trim())
  return parts.length === 0 ? '' : `${parts.join(' , ')} ,`
}

/**
 * 真正发给 NovelAI 的整图正面提示词：按字段顺序拼接，再按画面文字规则接 `text: …` 或补 `no text`。
 * 出图（main/gen/snapshot 的 assemble）与参数区「复制正面」共用，两边不会各拼各的。
 */
export function buildPositivePrompt(values: FieldValues, text: string, specs: readonly FieldSpec[]): string {
  return applyTextRendering(buildPrompt(values, specs), text).prompt
}

/** 有没有任何一个字段会进拼接结果。都空时「复制正面」置灰 */
export function hasPromptContent(values: FieldValues, specs: readonly FieldSpec[]): boolean {
  return specs.some((spec) => joinsPrompt(values[spec.name] ?? ''))
}

/**
 * 这个字段值会不会进拼接结果。
 *
 * 分块编辑器据此决定块后面画不画不可编辑的 ` ,` —— 与 buildPrompt 共用这一个判据，
 * 两边各写一份的话，「只含空格的字段」这类边角迟早对不上。
 */
export function joinsPrompt(value: string): boolean {
  return value.trim() !== ''
}
