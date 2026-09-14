import { describe, expect, it } from 'vitest'
import { applyFill, fillSummary } from '../../src/shared/applyFill'
import type { FillResult } from '../../src/shared/llm'
import { createCharacter, emptyWorkspace } from '../../src/shared/workspace'

function fill(over: Partial<FillResult> = {}): FillResult {
  return {
    main: { count: '2girls', style: '', character: '', artist: 'artist:wlop', appearance: '', tags: 'standing', environment: 'beach', series: '', nltags: '', quality: 'masterpiece' },
    text: '',
    negative: 'lowres',
    aspectRatio: '2:3',
    width: 832,
    height: 1216,
    transparentBackground: false,
    characters: [
      { fields: { count: 'girl', character: 'skadi (arknights)', appearance: '', tags: 'smile', nltags: '' }, negative: 'bad hands', position: '0.3,0.5' },
      { fields: { count: 'girl', character: 'specter (arknights)', appearance: '', tags: '', nltags: '' }, negative: '', position: '0.7,0.5' },
    ],
    useCoords: true,
    ...over,
  }
}

describe('applyFill', () => {
  it('整图字段整体替换：原有内容被清掉', () => {
    const ws = emptyWorkspace()
    ws.main.series = 'old series'
    applyFill(ws, fill())
    expect(ws.main.artist).toBe('artist:wlop')
    expect(ws.main.series).toBe('')
  })

  it('画面文字、负面词、宽高、透明背景、坐标定位写入；seed、seed 模式与其余参数不动', () => {
    const ws = emptyWorkspace()
    ws.text = 'OLD'
    ws.params.seed = 42
    ws.params.seedMode = 'fixed'
    ws.params.steps = 40
    applyFill(ws, fill({ transparentBackground: true }))
    expect([ws.text, ws.negative, ws.params.width, ws.params.height, ws.params.transparentBackground, ws.useCoords]).toEqual(['', 'lowres', 832, 1216, true, true])
    expect([ws.params.seed, ws.params.seedMode, ws.params.steps]).toEqual([42, 'fixed', 40])
  })

  it('角色区按回填重建：新 id、全部勾选、字段/负面/坐标照写', () => {
    const ws = emptyWorkspace()
    const old = createCharacter()
    old.enabled = false
    ws.characters = [old]
    applyFill(ws, fill())
    expect(ws.characters).toHaveLength(2)
    expect(ws.characters.some((c) => c.id === old.id)).toBe(false)
    expect(ws.characters[0]).toMatchObject({ enabled: true, negative: 'bad hands', position: '0.3,0.5' })
    expect(ws.characters[0].fields.character).toBe('skadi (arknights)')
    expect(new Set(ws.characters.map((c) => c.id)).size).toBe(2)
  })

  it('回填里没有角色（单角色工具收口）时清空角色区', () => {
    const ws = emptyWorkspace()
    ws.characters = [createCharacter()]
    applyFill(ws, fill({ characters: [], useCoords: false }))
    expect(ws.characters).toEqual([])
  })
})

describe('fillSummary', () => {
  it('与界面稿一致（去掉了 seed 那一段）', () => {
    expect(fillSummary(fill())).toBe('已回填: 提示词 5 个字段 · 负面词 · 角色 2 个（使用坐标定位: 开）· 832×1216 · 画面文字 无 · 透明背景 关')
  })

  it('没有角色、负面词为空、有画面文字、透明背景开', () => {
    expect(fillSummary(fill({ characters: [], negative: '', text: 'HELLO', transparentBackground: true }))).toBe(
      '已回填: 提示词 5 个字段 · 负面词 空 · 角色 无 · 832×1216 · 画面文字 有 · 透明背景 开',
    )
  })
})
