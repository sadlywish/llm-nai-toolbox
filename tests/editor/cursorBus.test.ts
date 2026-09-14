import { describe, expect, it, vi } from 'vitest'
import { cursorBus } from '@renderer/editor/cursorBus'

const ev = { editorId: 'main', doc: 'a', specs: [], head: 1 }

describe('cursorBus', () => {
  it('没有订阅者时 active() 为 false，emit 不做任何事', () => {
    expect(cursorBus.active()).toBe(false)
    expect(() => cursorBus.emit(ev)).not.toThrow()
  })

  it('订阅后收到事件；退订后 active() 回到 false', () => {
    const fn = vi.fn()
    const off = cursorBus.subscribe(fn)
    expect(cursorBus.active()).toBe(true)
    cursorBus.emit(ev)
    expect(fn).toHaveBeenCalledWith(ev)
    off()
    expect(cursorBus.active()).toBe(false)
    cursorBus.emit(ev)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('旧订阅的退订函数不会误摘新订阅', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = cursorBus.subscribe(a)
    const offB = cursorBus.subscribe(b)
    offA()
    expect(cursorBus.active()).toBe(true)
    offB()
  })
})
