import { describe, expect, it } from 'vitest'
import { buildRunInput, presetSelectionStale, selectStyleMode } from '../../src/shared/consoleRun'
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

describe('presetSelectionStale', () => {
  it('只有选着预设档、且那条被删掉或标签为空时为真', () => {
    const o = emptyWorkspace().console
    o.presetId = 'gone'
    expect(presetSelectionStale(o, presets)).toBe(false)
    o.styleMode = 'preset'
    expect(presetSelectionStale(o, presets)).toBe(true)
    o.presetId = 'blank'
    expect(presetSelectionStale(o, presets)).toBe(true)
    o.presetId = 'wlop'
    expect(presetSelectionStale(o, presets)).toBe(false)
  })
})

describe('selectStyleMode', () => {
  it('切到预设档默认选第一条可用预设（跳过标签为空的）', () => {
    const o = emptyWorkspace().console
    selectStyleMode(o, 'preset', presets)
    expect([o.styleMode, o.presetId]).toEqual(['preset', 'wlop'])
  })

  it('原来选着的仍可用就保留', () => {
    const o = emptyWorkspace().console
    o.presetId = 'ask'
    selectStyleMode(o, 'preset', presets)
    expect(o.presetId).toBe('ask')
  })

  it('切到别的档不动 presetId', () => {
    const o = emptyWorkspace().console
    o.styleMode = 'preset'
    o.presetId = 'ask'
    selectStyleMode(o, 'current', presets)
    expect([o.styleMode, o.presetId]).toEqual(['current', 'ask'])
  })

  it('一条可用预设都没有时 presetId 为空', () => {
    const o = emptyWorkspace().console
    o.presetId = 'blank'
    selectStyleMode(o, 'preset', [presets[0]])
    expect(o.presetId).toBe('')
  })
})
