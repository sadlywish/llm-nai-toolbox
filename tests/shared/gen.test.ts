import { describe, expect, it } from 'vitest'
import { parseGenStartInput } from '../../src/shared/gen'
import { emptyWorkspace } from '../../src/shared/workspace'

describe('parseGenStartInput', () => {
  it('合法入参：跑图次数原样，工作区过 normalizeWorkspace', () => {
    const ws = emptyWorkspace()
    ws.main.count = '1girl'
    const input = parseGenStartInput({ workspace: JSON.parse(JSON.stringify(ws)), count: 4 })
    expect(typeof input).not.toBe('string')
    if (typeof input === 'string') return
    expect(input.count).toBe(4)
    expect(input.workspace.main.count).toBe('1girl')
  })

  it('工作区形状不对时补成合法工作区，不抛错', () => {
    const input = parseGenStartInput({ workspace: { characters: 'x' }, count: 1 })
    if (typeof input === 'string') throw new Error(input)
    expect(input.workspace.characters).toEqual([])
  })

  it('跑图次数不是正整数时给出原因', () => {
    for (const count of [0, -1, 1.5, '2', Number.NaN, undefined]) {
      expect(parseGenStartInput({ workspace: emptyWorkspace(), count })).toBe('跑图次数必须是正整数')
    }
  })

  it('不是对象时给出原因', () => {
    expect(parseGenStartInput(null)).toBe('gen:start 入参无效')
  })
})
