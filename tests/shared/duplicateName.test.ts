import { describe, expect, it } from 'vitest'
import { duplicateName } from '../../src/shared/duplicateName'

describe('duplicateName', () => {
  it('第一次复制加「副本 1」', () => {
    expect(duplicateName('画师串 1', ['画师串 1'])).toBe('画师串 1 副本 1')
  })

  it('再复制时编号递增，不嵌套「副本的副本」', () => {
    expect(duplicateName('画师串 1', ['画师串 1', '画师串 1 副本 1'])).toBe('画师串 1 副本 2')
  })

  it('从副本再复制：剥掉原有编号后重新编，不叠加层数', () => {
    expect(duplicateName('画师串 1 副本 1', ['画师串 1', '画师串 1 副本 1'])).toBe('画师串 1 副本 2')
  })

  // 「已有个数 + 1」在删掉中间那个之后会撞名；必须取第一个空位。
  it('中间的副本被删掉后，补进那个空位而不是撞上已存在的名字', () => {
    const existing = ['画师串 1', '画师串 1 副本 2']
    expect(duplicateName('画师串 1', existing)).toBe('画师串 1 副本 1')
  })

  it('连续占用时一直往后找', () => {
    const existing = ['a', 'a 副本 1', 'a 副本 2', 'a 副本 3']
    expect(duplicateName('a', existing)).toBe('a 副本 4')
  })

  it('原名为空时不产生前导空格', () => {
    expect(duplicateName('', [])).toBe('副本 1')
    expect(duplicateName('   ', [])).toBe('副本 1')
  })

  it('名字里本来就带「副本」二字但没编号的不被剥掉', () => {
    expect(duplicateName('副本参考', [])).toBe('副本参考 副本 1')
  })
})
