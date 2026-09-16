import { describe, expect, it } from 'vitest'
import type { GenImageEvent, RunProgress } from '../../src/shared/gen'
import { AppEvents, type AppEvent } from '../../src/main/appEvents'

const progress = (over: Partial<RunProgress> = {}): RunProgress => ({
  roundId: 'round-1',
  status: 'running',
  total: 2,
  done: 1,
  failed: 0,
  pauseReason: null,
  abortReason: null,
  current: 1,
  ...over,
})

const image = (): GenImageEvent => ({
  roundId: 'round-1',
  index: 0,
  file: '00001-123.png',
  seed: 123,
  status: 'ok',
  error: null,
})

describe('AppEvents', () => {
  it('多订阅者都收到；退订后不再收到', () => {
    const events = new AppEvents()
    const a: AppEvent[] = []
    const b: AppEvent[] = []
    const offA = events.on((e) => a.push(e))
    events.on((e) => b.push(e))

    events.emit({ kind: 'gen-progress', progress: progress() })
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)

    offA()
    events.emit({ kind: 'gen-image', image: image() })
    expect(a).toHaveLength(1)
    expect(b.map((e) => e.kind)).toEqual(['gen-progress', 'gen-image'])
  })

  it('事件原样送到，不做任何包装', () => {
    const events = new AppEvents()
    const seen: AppEvent[] = []
    events.on((e) => seen.push(e))
    const p = progress({ status: 'paused', current: null, pauseReason: '并发限制' })
    const i = image()
    events.emit({ kind: 'gen-progress', progress: p })
    events.emit({ kind: 'gen-image', image: i })
    events.emit({ kind: 'gen-seed', seed: 4242 })
    expect(seen).toEqual([
      { kind: 'gen-progress', progress: p },
      { kind: 'gen-image', image: i },
      { kind: 'gen-seed', seed: 4242 },
    ])
  })

  it('同一个订阅者退订两次不影响别人', () => {
    const events = new AppEvents()
    const seen: AppEvent[] = []
    const off = events.on(() => {})
    events.on((e) => seen.push(e))
    off()
    off()
    events.emit({ kind: 'gen-seed', seed: 1 })
    expect(seen).toHaveLength(1)
  })

  it('一个订阅者抛错，别的订阅者照收，emit 本身不抛', () => {
    const events = new AppEvents()
    const seen: AppEvent[] = []
    events.on(() => {
      throw new Error('窗口没了')
    })
    events.on((e) => seen.push(e))
    expect(() => events.emit({ kind: 'gen-seed', seed: 7 })).not.toThrow()
    expect(seen).toHaveLength(1)
  })

  it('派发过程中退订，本次派发不受影响（先取快照再遍历）', () => {
    const events = new AppEvents()
    const seen: string[] = []
    let offB = (): void => {}
    events.on(() => {
      seen.push('a')
      offB()
    })
    offB = events.on(() => seen.push('b'))

    events.emit({ kind: 'gen-seed', seed: 1 })
    expect(seen).toEqual(['a', 'b'])
    // 下一次派发才生效
    events.emit({ kind: 'gen-seed', seed: 2 })
    expect(seen).toEqual(['a', 'b', 'a'])
  })
})
