// 指令框上方那一行摘要（界面稿第二节方案 A：`多角色 关闭 · 修改 开 · 画风 预设「厚涂光影」`）。
//
// 手机上五个开关平时是收起来的，这一行就是「收起时还能一眼看出这一轮会怎么跑」的全部依据，
// 所以档位文案直接用桌面端那套（@renderer/llmLabels），两边说的是同一件事，不另写一份。
import type { ConsoleOptions, StyleMode } from '@shared/workspace'
import { MULTI_LABELS, STYLE_MODE_LABELS } from '@renderer/llmLabels'

/**
 * 画风那一段在摘要里用短写法：完整档位名（`用预设画风覆盖`）三档连起来会把这一行撑到要省略号，
 * 而界面稿给的写法本来就是短的（`画风 预设「厚涂光影」`）。`不覆盖` 与完整档位名一致，直接复用。
 */
const STYLE_SUMMARY: Record<StyleMode, string> = {
  none: STYLE_MODE_LABELS.none,
  preset: '预设',
  current: '当前 artist 块',
}

function styleText(mode: StyleMode, presetName: string): string {
  if (mode !== 'preset') return STYLE_SUMMARY[mode]
  // 预设档但没选到预设（没选过、或者选中的那条在电脑上被删了）：照实说，别拿档位名冒充一个预设
  return presetName.trim() === '' ? `${STYLE_SUMMARY.preset} 未选择` : `${STYLE_SUMMARY.preset}「${presetName}」`
}

const onOff = (v: boolean): string => (v ? '开' : '关')

/**
 * @param presetName 当前预设画风的名字（共用的那条，从 `GET /api/styles` 来）；没选到时传空串
 *
 * 多角色、修改、画风三段总是写出来——这三项改的是这一轮怎么跑，关着也得让人看见。
 * 透明背景与回填后自动生成只在开着时占一段：它们默认关着，常态下写出来只是把这一行挤满。
 */
export function optionsSummary(o: ConsoleOptions, presetName: string): string {
  const parts = [
    `多角色 ${MULTI_LABELS[o.multiCharacter]}`,
    `修改 ${onOff(o.editExisting)}`,
    `画风 ${styleText(o.styleMode, presetName)}`,
  ]
  if (o.transparent) parts.push('透明 开')
  if (o.autoGenerate) parts.push('自动生成 开')
  return parts.join(' · ')
}
