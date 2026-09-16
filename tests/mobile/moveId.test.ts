import { describe, expect, it } from 'vitest'
import { moveId } from '../../src/mobile/src/moveId'

/**
 * 画风列表上移/下移的测试（计划 Task 17）。
 *
 * 这个函数唯一容易写错的地方是边界：已经在最前面还要上移、已经在最后面还要下移，
 * 这时不能挪位置，也不能因为下标算错把数组挪乱——所以两头都要各测一遍。
 */
describe('moveId', () => {
  it('上移/下移；到头不动', () => {
    expect(moveId(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(moveId(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c'])
  })

  it('下移；到头不动', () => {
    expect(moveId(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
    expect(moveId(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c'])
  })

  it('id 不存在时原样返回', () => {
    expect(moveId(['a', 'b', 'c'], 'z', 1)).toEqual(['a', 'b', 'c'])
  })

  it('不改动原数组（供 React 状态更新用，原地改会让上层判断不出变化）', () => {
    const ids = ['a', 'b', 'c']
    const next = moveId(ids, 'b', -1)
    expect(ids).toEqual(['a', 'b', 'c'])
    expect(next).not.toBe(ids)
  })

  it('只有一条时怎么挪都不动', () => {
    expect(moveId(['a'], 'a', -1)).toEqual(['a'])
    expect(moveId(['a'], 'a', 1)).toEqual(['a'])
  })
})
