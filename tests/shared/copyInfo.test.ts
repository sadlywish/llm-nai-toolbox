import { describe, expect, it } from 'vitest'
import { applyRoundToWorkspace } from '../../src/shared/copyInfo'
import type { GenSnapshot } from '../../src/shared/gen'
import { createCharacter, defaultGenParams, emptyWorkspace } from '../../src/shared/workspace'

function snapshot(): GenSnapshot {
  return {
    main: { count: '2girls', style: '', character: '', artist: 'artist:wlop', appearance: '', tags: 'standing', environment: 'beach', series: '', nltags: '', quality: 'masterpiece' },
    text: 'Hello',
    negative: 'lowres',
    characters: [{ fields: { count: 'girl', character: 'skadi (arknights)', appearance: '', tags: '', nltags: '' }, negative: 'bad hands', position: '0.3,0.5' }],
    useCoords: true,
    params: { ...defaultGenParams(), model: 'nai-diffusion-4-5-full', width: 832, height: 1216, steps: 23, seed: 111, seedMode: 'perImage', transparentBackground: true },
  }
}

describe('applyRoundToWorkspace', () => {
  it('整套覆盖：整图字段（空的也清掉）、画面文字、负面词、使用坐标定位与参数', () => {
    const ws = emptyWorkspace()
    ws.main.series = 'old'
    ws.params.cfgRescale = 0.4
    applyRoundToWorkspace(ws, snapshot(), 2961054388)
    expect([ws.main.artist, ws.main.series, ws.text, ws.negative, ws.useCoords]).toEqual(['artist:wlop', '', 'Hello', 'lowres', true])
    expect([ws.params.model, ws.params.width, ws.params.height, ws.params.steps, ws.params.cfgRescale, ws.params.transparentBackground]).toEqual(['nai-diffusion-4-5-full', 832, 1216, 23, 0, true])
  })

  it('seed 用传进来的值（图片元信息里的），seed 模式改为固定', () => {
    const ws = emptyWorkspace()
    applyRoundToWorkspace(ws, snapshot(), 2961054388)
    expect([ws.params.seed, ws.params.seedMode]).toEqual([2961054388, 'fixed'])
  })

  it('角色区按快照重建：新 id、全部参与，原有角色被替换', () => {
    const ws = emptyWorkspace()
    const old = createCharacter()
    ws.characters = [old]
    applyRoundToWorkspace(ws, snapshot(), 1)
    expect(ws.characters).toHaveLength(1)
    expect(ws.characters[0].id).not.toBe(old.id)
    expect(ws.characters[0]).toMatchObject({ enabled: true, negative: 'bad hands', position: '0.3,0.5' })
    expect(ws.characters[0].fields.character).toBe('skadi (arknights)')
  })

  it('不碰指令区与跑图次数', () => {
    const ws = emptyWorkspace()
    ws.console.instruction = '保留'
    ws.runCount = 4
    applyRoundToWorkspace(ws, snapshot(), 1)
    expect([ws.console.instruction, ws.runCount]).toEqual(['保留', 4])
  })
})
