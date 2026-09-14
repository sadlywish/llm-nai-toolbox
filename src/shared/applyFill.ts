import { CHARACTER_FIELDS, MAIN_FIELDS } from './fields'
import type { FillResult } from './llm'
import { createCharacter, type Workspace } from './workspace'

/**
 * 回填：把一轮的最终参数写进工作区。
 *
 * 回填就是最终参数，本身不再加工（插件的处理都已在主进程收口时做完）：
 * - 整图十个字段整体替换，回填里是空的字段就清空；
 * - 角色区按回填重建（新 id、全部勾选）；回填里没有角色——模型用单角色工具收口——就清空；
 * - 宽高总是写入换算结果；
 * - 模型不管 seed，seed 与 seed 模式不动；其余生成参数（步数、采样器……）也不动。
 */
export function applyFill(ws: Workspace, fill: FillResult): void {
  for (const spec of MAIN_FIELDS) ws.main[spec.name] = fill.main[spec.name] ?? ''
  ws.text = fill.text
  ws.negative = fill.negative
  ws.params.width = fill.width
  ws.params.height = fill.height
  ws.params.transparentBackground = fill.transparentBackground
  ws.characters = fill.characters.map((c) => {
    const ch = createCharacter()
    for (const spec of CHARACTER_FIELDS) ch.fields[spec.name] = c.fields[spec.name] ?? ''
    ch.negative = c.negative
    ch.position = c.position
    return ch
  })
  ws.useCoords = fill.useCoords
}

/**
 * 日志区最后那行绿色的「已回填: …」（界面稿状态 2，去掉了 seed 那一段）。
 *
 * 段之间通常用 ` · ` 隔开；但「角色」段本身以「）」收尾时，界面稿的写法是让
 * 下一个「·」紧贴在「）」后面、不再多出一个空格（`开）· 832×1216`，不是
 * `开） · 832×1216`）——`）`已经是视觉上的收尾，双重空格显得松散。
 */
export function fillSummary(fill: FillResult): string {
  const filled = MAIN_FIELDS.filter((s) => (fill.main[s.name] ?? '').trim() !== '').length
  const parts = [
    `提示词 ${filled} 个字段`,
    fill.negative.trim() !== '' ? '负面词' : '负面词 空',
    fill.characters.length > 0
      ? `角色 ${fill.characters.length} 个（使用坐标定位: ${fill.useCoords ? '开' : '关'}）`
      : '角色 无',
    `${fill.width}×${fill.height}`,
    `画面文字 ${fill.text.trim() !== '' ? '有' : '无'}`,
    `透明背景 ${fill.transparentBackground ? '开' : '关'}`,
  ]
  let out = `已回填: ${parts[0]}`
  for (const part of parts.slice(1)) out += (out.endsWith('）') ? '· ' : ' · ') + part
  return out
}
