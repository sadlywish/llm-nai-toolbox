import { describe, expect, it } from 'vitest'
import { CHARACTER_FIELDS, MAIN_FIELDS, orderSpecs } from '../../src/shared/fields'
import type { GenSnapshot } from '../../src/shared/gen'
import { paramsLine, snapshotSpecs } from '../../src/shared/toolParams'
import { emptyWorkspace } from '../../src/shared/workspace'

const names = (specs: readonly { name: string }[]): string[] => specs.map((s) => s.name)

const SAVED_MAIN = 'series, count, style, character, artist, appearance, tags, environment, nltags, quality'
const SAVED_CHAR = 'tags, count, character, appearance, nltags'
const CURRENT = {
  main: orderSpecs(MAIN_FIELDS, 'quality, count, style, character, artist, appearance, tags, environment, series, nltags'),
  character: orderSpecs(CHARACTER_FIELDS, 'nltags, count, character, appearance, tags'),
}

function snapshot(extra: Partial<GenSnapshot>): GenSnapshot {
  const ws = emptyWorkspace()
  return { main: ws.main, text: '', negative: '', characters: [], useCoords: false, params: ws.params, llm: null, ...extra }
}

describe('snapshotSpecs', () => {
  it('快照里存了顺序：按存的排，不看当前设置', () => {
    const r = snapshotSpecs(snapshot({ promptOrder: SAVED_MAIN, naiCharPromptOrder: SAVED_CHAR }), CURRENT)
    expect(names(r.main)).toEqual(SAVED_MAIN.split(', '))
    expect(names(r.character)).toEqual(SAVED_CHAR.split(', '))
    expect(r.legacy).toBe(false)
  })

  it('旧记录没存顺序：用调用方给的当前顺序，并标成旧记录', () => {
    const r = snapshotSpecs(snapshot({}), CURRENT)
    expect(names(r.main)).toEqual(names(CURRENT.main))
    expect(names(r.character)).toEqual(names(CURRENT.character))
    expect(r.legacy).toBe(true)
  })

  it('存的顺序不合法（少字段、不认识的字段、不是字符串）：当成没存', () => {
    for (const bad of ['count, style', 'count, style, character, artist, appearance, tags, environment, series, nltags, quality, pose', 42]) {
      const r = snapshotSpecs(snapshot({ promptOrder: bad as string, naiCharPromptOrder: SAVED_CHAR }), CURRENT)
      expect(names(r.main)).toEqual(names(CURRENT.main))
      expect(r.legacy).toBe(true)
    }
  })

  it('角色顺序单独判：整图的存了、角色的没存，角色退回当前顺序，同样算旧记录', () => {
    const r = snapshotSpecs(snapshot({ promptOrder: SAVED_MAIN }), CURRENT)
    expect(names(r.main)).toEqual(SAVED_MAIN.split(', '))
    expect(names(r.character)).toEqual(names(CURRENT.character))
    expect(r.legacy).toBe(true)
  })
})

describe('paramsLine', () => {
  it('模型、步数、CFG、CFG Rescale、采样器、噪声调度、透明背景，尺寸与 seed 不在这一行', () => {
    const p = { ...emptyWorkspace().params, model: 'nai-diffusion-4-5-full', steps: 28, scale: 5, cfgRescale: 0.2, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', transparentBackground: true }
    expect(paramsLine(p)).toBe('nai-diffusion-4-5-full · steps 28 · CFG 5 · CFG Rescale 0.2 · k_euler_ancestral · karras · 透明背景 开')
    expect(paramsLine({ ...p, transparentBackground: false })).toMatch(/透明背景 关$/)
  })
})
