import { describe, expect, it } from 'vitest'
import { UNNAMED_STYLE, nextStyleName, normalizeStyles, styleNameError, usableStyles, type StylePreset } from '../../src/shared/styles'

const p = (id: string, name: string, tags = ''): StylePreset => ({ id, name, tags })

describe('normalizeStyles', () => {
  it('不是数组给空列表；非对象元素跳过；类型不对的字段回默认', () => {
    expect(normalizeStyles({ a: 1 })).toEqual([])
    const list = normalizeStyles(['x', { id: 'a', name: 'wlop', tags: 'artist:wlop' }, { id: 'b', name: 3, tags: null }])
    expect(list).toHaveLength(2)
    expect(list[0]).toEqual({ id: 'a', name: 'wlop', tags: 'artist:wlop' })
    expect(list[1]).toEqual({ id: 'b', name: UNNAMED_STYLE, tags: '' })
  })

  it('名称去首尾空白与换行；空名称用「未命名画风」', () => {
    expect(normalizeStyles([{ id: 'a', name: ' 厚\n涂 ', tags: '' }])[0].name).toBe('厚涂')
    expect(normalizeStyles([{ id: 'a', name: '   ', tags: '' }])[0].name).toBe(UNNAMED_STYLE)
  })

  it('缺 id 或 id 重复时补新的', () => {
    const list = normalizeStyles([{ id: 'a', name: 'x', tags: '' }, { id: 'a', name: 'y', tags: '' }, { name: 'z', tags: '' }])
    const ids = list.map((s) => s.id)
    expect(ids[0]).toBe('a')
    expect(new Set(ids).size).toBe(3)
  })
})

describe('styleNameError', () => {
  const list = [p('a', 'wlop 厚涂'), p('b', 'ask 水彩')]

  it('空名称与重名报错；和自己同名不算重名；比较前去首尾空白', () => {
    expect(styleNameError('  ', list, 'a')).toBe('名称不能为空')
    expect(styleNameError(' ask 水彩 ', list, 'a')).toBe('已经有同名的画风')
    expect(styleNameError('wlop 厚涂', list, 'a')).toBeNull()
    expect(styleNameError('新名字', list, 'a')).toBeNull()
  })
})

describe('nextStyleName', () => {
  it('没占用时用「未命名画风」，占用了从 2 开始找第一个空位', () => {
    expect(nextStyleName([])).toBe('未命名画风')
    expect(nextStyleName([p('a', '未命名画风')])).toBe('未命名画风 2')
    expect(nextStyleName([p('a', '未命名画风'), p('b', '未命名画风 3')])).toBe('未命名画风 2')
    expect(nextStyleName([p('a', '未命名画风'), p('b', '未命名画风 2')])).toBe('未命名画风 3')
  })
})

describe('usableStyles', () => {
  it('只留标签非空的预设，保持原顺序', () => {
    expect(usableStyles([p('a', 'x', ' '), p('b', 'y', 'artist:y'), p('c', 'z', 'artist:z')]).map((s) => s.id)).toEqual(['b', 'c'])
  })
})
