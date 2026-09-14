import { CHARACTER_FIELDS, MAIN_FIELDS } from './fields'
import type { GenSnapshot } from './gen'
import { createCharacter, type Workspace } from './workspace'

/**
 * 「复制信息」：把一张图的生成信息整套覆盖到参数区。
 *
 * 整图字段（快照里空的也清掉）、画面文字、负面词、角色列表（新 id、全部参与）、使用坐标定位、
 * 模型与各项参数都照快照写。唯一例外是 seed：用调用方传进来的值（图片元信息里的，读不到时是记录里的），
 * 并把 seed 模式改成固定——复制信息就是为了复现这张图。指令区与跑图次数不动。
 */
export function applyRoundToWorkspace(ws: Workspace, snapshot: GenSnapshot, seed: number): void {
  for (const spec of MAIN_FIELDS) ws.main[spec.name] = snapshot.main[spec.name] ?? ''
  ws.text = snapshot.text
  ws.negative = snapshot.negative
  ws.characters = snapshot.characters.map((c) => {
    const ch = createCharacter()
    for (const spec of CHARACTER_FIELDS) ch.fields[spec.name] = c.fields[spec.name] ?? ''
    ch.negative = c.negative
    ch.position = c.position
    return ch
  })
  ws.useCoords = snapshot.useCoords
  ws.params = { ...snapshot.params, seed, seedMode: 'fixed' }
}
