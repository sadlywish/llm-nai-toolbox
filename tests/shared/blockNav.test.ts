import { describe, expect, it } from 'vitest'
import { MAIN_FIELDS } from '@shared/fields'
import { BLOCK_SEP, blockRanges, emptyValues, serializeFields } from '@shared/blockDoc'
import {
  changeTouchesSeparator,
  clampToBlock,
  fieldIndexAt,
  resolveBackspace,
  resolveDelete,
} from '@shared/blockNav'

const TRIO = MAIN_FIELDS.slice(0, 3)
// ␟1girl␟␟skadi   下标： 0 1..5 6 7 8..12
const DOC = serializeFields({ count: '1girl', style: '', character: 'skadi' }, TRIO)

describe('fieldIndexAt', () => {
  it('分隔符之后的位置属于该段', () => {
    expect(fieldIndexAt(DOC, 1)).toBe(0)
    expect(fieldIndexAt(DOC, 5)).toBe(0)
  })

  it('段末尾（下一个分隔符之前）仍属于本段', () => {
    expect(fieldIndexAt(DOC, 6)).toBe(0)
  })

  it('空段自身的位置属于空段', () => {
    expect(fieldIndexAt(DOC, 7)).toBe(1)
  })

  it('末段一直到文末都属于末段', () => {
    expect(fieldIndexAt(DOC, DOC.length)).toBe(2)
  })

  it('文档起点没有前一段，归到第 0 段', () => {
    expect(fieldIndexAt(DOC, 0)).toBe(0)
  })
})

describe('resolveBackspace', () => {
  it('段内正常退格不拦', () => {
    expect(resolveBackspace(DOC, 5)).toBeNull()
  })

  it('段首退格改成跳到上一段末尾，不删分隔符', () => {
    expect(resolveBackspace(DOC, 8)).toEqual({ kind: 'move', to: 7 })
  })

  it('空段里退格同样只是跳走，空段删不掉', () => {
    expect(resolveBackspace(DOC, 7)).toEqual({ kind: 'move', to: 6 })
  })

  it('第一段段首没有上一段，什么都不做', () => {
    expect(resolveBackspace(DOC, 1)).toEqual({ kind: 'block' })
  })

  it('文档起点什么都不做', () => {
    expect(resolveBackspace(DOC, 0)).toEqual({ kind: 'block' })
  })
})

describe('resolveDelete', () => {
  it('段内正常删除不拦', () => {
    expect(resolveDelete(DOC, 1)).toBeNull()
  })

  it('段尾按 Delete 跳到下一段开头', () => {
    expect(resolveDelete(DOC, 6)).toEqual({ kind: 'move', to: 7 })
  })

  it('文末什么都不做', () => {
    expect(resolveDelete(DOC, DOC.length)).toEqual({ kind: 'block' })
  })
})

describe('changeTouchesSeparator', () => {
  it('段内改动不碰分隔符', () => {
    expect(changeTouchesSeparator(DOC, 1, 6)).toBe(false)
  })

  it('跨段选区包含分隔符', () => {
    expect(changeTouchesSeparator(DOC, 5, 9)).toBe(true)
  })

  it('空区间不碰分隔符', () => {
    expect(changeTouchesSeparator(DOC, 6, 6)).toBe(false)
  })
})

describe('clampToBlock', () => {
  it('段末尾原样保留，不推进下一段', () => {
    expect(clampToBlock(DOC, TRIO, 6)).toBe(6)
  })

  it('文档起点推进第 0 段 —— 这是唯一需要 clamp 的位置', () => {
    expect(clampToBlock(DOC, TRIO, 0)).toBe(1)
  })

  it('已经在段内的位置原样返回', () => {
    expect(clampToBlock(DOC, TRIO, 3)).toBe(3)
  })
})

describe('clampToBlock × fieldIndexAt 的契约', () => {
  it('空文档下逐段验：clamp 不动合法落点，且 clamp 后归属不变', () => {
    const doc = serializeFields(emptyValues(MAIN_FIELDS), MAIN_FIELDS)
    for (const r of blockRanges(doc, MAIN_FIELDS)) {
      expect(clampToBlock(doc, MAIN_FIELDS, r.from)).toBe(r.from)
      expect(clampToBlock(doc, MAIN_FIELDS, r.to)).toBe(r.to)
      expect(fieldIndexAt(doc, clampToBlock(doc, MAIN_FIELDS, r.from))).toBe(r.index)
    }
  })

  it('有非空段时同样成立 —— 覆盖 to_0 与 sepAt_1 重合那个点', () => {
    for (const r of blockRanges(DOC, TRIO)) {
      expect(clampToBlock(DOC, TRIO, r.from)).toBe(r.from)
      expect(clampToBlock(DOC, TRIO, r.to)).toBe(r.to)
      expect(fieldIndexAt(DOC, clampToBlock(DOC, TRIO, r.from))).toBe(r.index)
    }
  })
})
