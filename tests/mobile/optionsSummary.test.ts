import { describe, expect, it } from 'vitest'
import { optionsSummary } from '../../src/mobile/src/optionsSummary'
import { defaultConsoleOptions, type ConsoleOptions } from '../../src/shared/workspace'

/** 指令框上方那一行摘要（界面稿第二节方案 A 的 .m-dock 第一行） */
function opts(patch: Partial<ConsoleOptions> = {}): ConsoleOptions {
  return { ...defaultConsoleOptions(), ...patch }
}

describe('optionsSummary', () => {
  it('摘要按当前开关拼：多角色 关闭 · 修改 开 · 画风 预设「厚涂光影」', () => {
    expect(optionsSummary(opts({ editExisting: true, styleMode: 'preset' }), '厚涂光影')).toBe(
      '多角色 关闭 · 修改 开 · 画风 预设「厚涂光影」',
    )
  })

  it('多角色三档用的是桌面端同一套文案', () => {
    expect(optionsSummary(opts({ multiCharacter: 'auto' }), '')).toContain('多角色 位置由模型安排')
    expect(optionsSummary(opts({ multiCharacter: 'coords' }), '')).toContain('多角色 手动指定坐标')
  })

  it('画风另外两档各有各的说法', () => {
    expect(optionsSummary(opts({ styleMode: 'none' }), '厚涂光影')).toContain('画风 不覆盖')
    expect(optionsSummary(opts({ styleMode: 'current' }), '厚涂光影')).toContain('画风 当前 artist 块')
  })

  it('预设档但没选到预设时写「未选择」，不假装有一个', () => {
    expect(optionsSummary(opts({ styleMode: 'preset' }), '')).toContain('画风 预设 未选择')
  })

  it('修改关着时摘要里写的是关', () => {
    expect(optionsSummary(opts({ editExisting: false }), '')).toContain('修改 关')
  })

  it('透明背景与回填后自动生成只在开着时才占一段', () => {
    expect(optionsSummary(opts(), '')).toBe('多角色 关闭 · 修改 关 · 画风 不覆盖')
    expect(optionsSummary(opts({ transparent: true }), '')).toBe('多角色 关闭 · 修改 关 · 画风 不覆盖 · 透明 开')
    expect(optionsSummary(opts({ transparent: true, autoGenerate: true }), '')).toBe(
      '多角色 关闭 · 修改 关 · 画风 不覆盖 · 透明 开 · 自动生成 开',
    )
  })
})
