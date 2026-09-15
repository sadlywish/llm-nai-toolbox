import { describe, expect, it } from 'vitest'
import { buildRunInput, clearStalePreset, currentPresetOf, pendingRequestOf, presetSelectionStale } from '../../src/shared/consoleRun'
import type { StylePreset } from '../../src/shared/styles'
import { emptyWorkspace } from '../../src/shared/workspace'

const presets: StylePreset[] = [
  { id: 'blank', name: '空的', tags: '   ' },
  { id: 'wlop', name: 'wlop 厚涂', tags: 'artist:wlop, thick painting' },
  { id: 'ask', name: 'ask 水彩', tags: 'artist:ask' },
]

describe('buildRunInput', () => {
  it('指令区选项原样带上，工作区本身作为快照', () => {
    const ws = emptyWorkspace()
    ws.console.instruction = '海边'
    ws.console.multiCharacter = 'coords'
    ws.console.editExisting = true
    ws.console.transparent = true
    const input = buildRunInput(ws, presets)
    expect(input).toMatchObject({ instruction: '海边', multiCharacter: 'coords', editExisting: true, transparent: true, style: { mode: 'none' } })
    expect(input.workspace).toBe(ws)
  })

  it('画风：预设档取选中预设的标签；预设不可用时按不覆盖；当前档', () => {
    const ws = emptyWorkspace()
    ws.console.styleMode = 'preset'
    ws.console.presetId = 'ask'
    expect(buildRunInput(ws, presets).style).toEqual({ mode: 'preset', tags: 'artist:ask' })
    ws.console.presetId = 'blank'
    expect(buildRunInput(ws, presets).style).toEqual({ mode: 'none' })
    ws.console.presetId = 'gone'
    expect(buildRunInput(ws, presets).style).toEqual({ mode: 'none' })
    ws.console.styleMode = 'current'
    expect(buildRunInput(ws, presets).style).toEqual({ mode: 'current' })
  })
})

describe('currentPresetOf', () => {
  it('记着的那条存在且标签非空时返回它；没选、被删、为空时 null', () => {
    const o = emptyWorkspace().console
    expect(currentPresetOf(o, presets)).toBeNull()
    o.presetId = 'ask'
    expect(currentPresetOf(o, presets)?.name).toBe('ask 水彩')
    o.presetId = 'blank'
    expect(currentPresetOf(o, presets)).toBeNull()
    o.presetId = 'gone'
    expect(currentPresetOf(o, presets)).toBeNull()
  })

  it('和档位无关：不覆盖档也照样认出当前预设', () => {
    const o = emptyWorkspace().console
    o.styleMode = 'none'
    o.presetId = 'wlop'
    expect(currentPresetOf(o, presets)?.id).toBe('wlop')
  })
})

describe('presetSelectionStale / clearStalePreset', () => {
  it('没选预设、档位也不是预设档：不算失效，什么都不动', () => {
    const o = emptyWorkspace().console
    o.styleMode = 'current'
    expect(presetSelectionStale(o, presets)).toBe(false)
    clearStalePreset(o, presets)
    expect([o.styleMode, o.presetId]).toEqual(['current', ''])
  })

  it('记着的预设仍可用：不失效，预设档保持', () => {
    const o = emptyWorkspace().console
    o.styleMode = 'preset'
    o.presetId = 'wlop'
    expect(presetSelectionStale(o, presets)).toBe(false)
    clearStalePreset(o, presets)
    expect([o.styleMode, o.presetId]).toEqual(['preset', 'wlop'])
  })

  it('记着的预设被删：预设变未选择；不是预设档时档位不动', () => {
    const o = emptyWorkspace().console
    o.styleMode = 'current'
    o.presetId = 'gone'
    expect(presetSelectionStale(o, presets)).toBe(true)
    clearStalePreset(o, presets)
    expect([o.styleMode, o.presetId]).toEqual(['current', ''])
  })

  it('记着的预设被清空、档位是预设档：预设变未选择，档位退回不覆盖', () => {
    const o = emptyWorkspace().console
    o.styleMode = 'preset'
    o.presetId = 'blank'
    expect(presetSelectionStale(o, presets)).toBe(true)
    clearStalePreset(o, presets)
    expect([o.styleMode, o.presetId]).toEqual(['none', ''])
  })

  it('预设档但一条都没选：失效，退回不覆盖', () => {
    const o = emptyWorkspace().console
    o.styleMode = 'preset'
    expect(presetSelectionStale(o, presets)).toBe(true)
    clearStalePreset(o, presets)
    expect(o.styleMode).toBe('none')
  })
})

describe('pendingRequestOf', () => {
  const api = { apiType: 'openai' as const, model: 'gpt-x' }

  it('记下指令、五个开关与 API；按预设覆盖时记预设名', () => {
    const ws = emptyWorkspace()
    Object.assign(ws.console, { instruction: '海边', multiCharacter: 'coords', editExisting: true, transparent: true, styleMode: 'preset', presetId: 'wlop', autoGenerate: true })
    expect(pendingRequestOf(ws, presets, api)).toEqual({
      apiType: 'openai',
      model: 'gpt-x',
      instruction: '海边',
      multiCharacter: 'coords',
      editExisting: true,
      transparent: true,
      styleMode: 'preset',
      presetName: 'wlop 厚涂',
      autoGenerate: true,
    })
  })

  it('不是预设档时不记预设名；预设已失效按不覆盖记，与实际发出去的一致', () => {
    const ws = emptyWorkspace()
    Object.assign(ws.console, { styleMode: 'current', presetId: 'wlop' })
    expect(pendingRequestOf(ws, presets, api)).toMatchObject({ styleMode: 'current', presetName: '' })
    Object.assign(ws.console, { styleMode: 'preset', presetId: 'blank' })
    expect(pendingRequestOf(ws, presets, api)).toMatchObject({ styleMode: 'none', presetName: '' })
    expect(buildRunInput(ws, presets).style).toEqual({ mode: 'none' })
  })
})
