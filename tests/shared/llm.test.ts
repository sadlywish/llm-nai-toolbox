import { describe, expect, it } from 'vitest'
import { parseLlmRunInput } from '../../src/shared/llm'
import { emptyWorkspace } from '../../src/shared/workspace'

const valid = {
  instruction: '画初音',
  multiCharacter: 'coords',
  editExisting: true,
  transparent: false,
  style: { mode: 'preset', tags: 'artist:wlop' },
  workspace: emptyWorkspace(),
}

describe('parseLlmRunInput', () => {
  it('合法入参原样通过', () => {
    const r = parseLlmRunInput(valid)
    expect(typeof r).not.toBe('string')
    if (typeof r !== 'string') {
      expect(r.multiCharacter).toBe('coords')
      expect(r.style).toEqual({ mode: 'preset', tags: 'artist:wlop' })
    }
  })

  it('每一项不合法都给出原因', () => {
    expect(parseLlmRunInput(null)).toBe('llm:run 入参无效')
    expect(parseLlmRunInput({ ...valid, instruction: 3 })).toBe('llm:run 缺少指令文本')
    expect(parseLlmRunInput({ ...valid, multiCharacter: 'on' })).toBe('llm:run 的多角色选项无效')
    expect(parseLlmRunInput({ ...valid, transparent: 'yes' })).toBe('llm:run 的开关选项无效')
    expect(parseLlmRunInput({ ...valid, style: { mode: 'preset' } })).toBe('llm:run 的画风选项无效')
  })

  it('画风选项多带的字段不透传', () => {
    const r = parseLlmRunInput({ ...valid, style: { mode: 'current', tags: 'x' } })
    if (typeof r !== 'string') expect(r.style).toEqual({ mode: 'current' })
  })

  it('工作区快照过 normalizeWorkspace：垃圾形状变成完整的空工作区', () => {
    const r = parseLlmRunInput({ ...valid, workspace: 'garbage' })
    if (typeof r !== 'string') expect(r.workspace).toEqual(emptyWorkspace())
  })
})
