import { describe, expect, it } from 'vitest'
import { formatCount } from '@renderer/format'

describe('formatCount', () => {
  it('万以下保留一位小数的 k，万以上取整 k，百万以上 M', () => {
    expect(formatCount(412)).toBe('412')
    expect(formatCount(1562)).toBe('1.6k')
    expect(formatCount(98000)).toBe('98k')
    expect(formatCount(1184302)).toBe('1.2M')
  })
})
