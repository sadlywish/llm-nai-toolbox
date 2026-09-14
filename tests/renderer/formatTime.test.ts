import { describe, expect, it } from 'vitest'
import { formatRoundTime } from '../../src/renderer/src/formatTime'

describe('formatRoundTime', () => {
  it('按本地时间写 MM-DD HH:mm，补零', () => {
    expect(formatRoundTime(new Date(2026, 8, 4, 1, 5).toISOString())).toBe('09-04 01:05')
  })

  it('不是合法时间时原样返回', () => {
    expect(formatRoundTime('x')).toBe('x')
  })
})
