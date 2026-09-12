import { describe, expect, it } from 'vitest'
import { newId } from '@shared/ids'

describe('newId', () => {
  it('保留传入的前缀', () => {
    expect(newId('char').startsWith('char-')).toBe(true)
  })

  it('连续调用不重复', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) seen.add(newId('x'))
    expect(seen.size).toBe(1000)
  })
})
