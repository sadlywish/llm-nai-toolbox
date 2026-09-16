import { describe, expect, it } from 'vitest'
import { parseNumberInput, settleNumberInput } from '../../src/mobile/src/numberInput'

describe('parseNumberInput', () => {
  it('正常数字照收', () => {
    expect(parseNumberInput('2')).toBe(2)
    expect(parseNumberInput('832')).toBe(832)
    expect(parseNumberInput('7.5')).toBe(7.5)
    expect(parseNumberInput('-1')).toBe(-1)
  })

  it('输入过程中的半截值一律不写进工作区（这就是退格能删干净的原因）', () => {
    for (const raw of ['', ' ', '-', '.', '.5e', 'abc', '1e3']) expect(parseNumberInput(raw)).toBeNull()
  })

  it('越界与非整数按规则挡掉', () => {
    expect(parseNumberInput('0', { min: 1 })).toBeNull()
    expect(parseNumberInput('2', { min: 1 })).toBe(2)
    expect(parseNumberInput('1.5', { max: 1 })).toBeNull()
    expect(parseNumberInput('2.5', { integer: true })).toBeNull()
    expect(parseNumberInput('3', { integer: true })).toBe(3)
  })

  it('小数点开头与末尾的写法都收：文本是本地态，收了不影响接着往下打', () => {
    expect(parseNumberInput('.5')).toBe(0.5)
    // 打 1.5 的中途会经过 '1.'：这时把 1 写进工作区无妨，框里仍是 '1.'，下一位照打
    expect(parseNumberInput('1.')).toBe(1)
  })
})

describe('settleNumberInput', () => {
  it('失焦时半截文本退回原值，框里不留空', () => {
    expect(settleNumberInput('', 1, { min: 1, integer: true })).toBe(1)
    expect(settleNumberInput('-', 28, { min: 1 })).toBe(28)
    expect(settleNumberInput('0', 1, { min: 1 })).toBe(1)
  })

  it('失焦时合法文本就用它', () => {
    expect(settleNumberInput('4', 1, { min: 1, integer: true })).toBe(4)
  })
})
