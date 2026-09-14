import { describe, expect, it, vi } from 'vitest'
import type { GenTask, NaiError, RunProgress } from '../../../src/shared/gen'
import { RunQueue, type QueueDeps } from '../../../src/main/gen/queue'

function task(index: number): GenTask {
  return { index, seed: 1 }
}

function naiError(kind: NaiError['kind'], message = '出错'): Error & { kind: NaiError['kind'] } {
  return Object.assign(new Error(message), { kind })
}

function deps(over: Partial<QueueDeps> = {}): QueueDeps & { progresses: RunProgress[] } {
  const progresses: RunProgress[] = []
  return {
    runTask: async () => {},
    // 不真的等：队列的时序由任务本身驱动，间隔只需被调用到
    sleep: async () => {},
    intervalMs: 1000,
    retryCount: 2,
    onProgress: (p) => progresses.push({ ...p }),
    progresses,
    ...over,
  }
}

describe('RunQueue — 正常路径', () => {
  it('按顺序跑完所有任务', async () => {
    const ran: number[] = []
    const d = deps({ runTask: async (t) => void ran.push(t.index) })
    const final = await new RunQueue(d).start('r1', [task(0), task(1), task(2)])
    expect(ran).toEqual([0, 1, 2])
    expect(final.status).toBe('done')
    expect(final.done).toBe(3)
    expect(final.failed).toBe(0)
  })

  it('每个任务之间等待配置的间隔', async () => {
    const waits: number[] = []
    const d = deps({ sleep: async (ms) => void waits.push(ms), intervalMs: 250 })
    await new RunQueue(d).start('r1', [task(0), task(1)])
    // 2 个任务之间恰好等一次，且值就是配置的 intervalMs——不能只用
    // .every() 断言，空数组或漏 sleep 都会让它恒真
    expect(waits).toEqual([250])
  })

  it('空任务列表直接完成', async () => {
    const final = await new RunQueue(deps()).start('r1', [])
    expect(final.status).toBe('done')
    expect(final.total).toBe(0)
  })

  it('每完成一个任务都推一次进度', async () => {
    const d = deps()
    await new RunQueue(d).start('r1', [task(0), task(1)])
    expect(d.progresses.length).toBeGreaterThanOrEqual(2)
    expect(d.progresses[d.progresses.length - 1].done).toBe(2)
  })
})

describe('RunQueue — 普通失败', () => {
  it('失败后重试，成功则计入 done', async () => {
    let attempts = 0
    const d = deps({
      runTask: async () => {
        attempts++
        if (attempts < 3) throw naiError('network')
      },
    })
    const final = await new RunQueue(d).start('r1', [task(0)])
    expect(attempts).toBe(3)
    expect(final.done).toBe(1)
    expect(final.failed).toBe(0)
  })

  it('重试之间也等待配置的间隔，而不是 0ms 内连打', async () => {
    // spec §9 第 5 条：「重试之间同样间隔 taskIntervalMs」。不等待的话，
    // 瞬时故障会在 0ms 内连打 retryCount+1 次，大概率全部撞在同一个
    // 故障窗口里，等于把重试的价值削掉大半
    const waits: number[] = []
    let attempts = 0
    const d = deps({
      sleep: async (ms) => void waits.push(ms),
      intervalMs: 300,
      runTask: async () => {
        attempts++
        if (attempts < 3) throw naiError('network')
      },
    })
    const final = await new RunQueue(d).start('r1', [task(0)])
    expect(attempts).toBe(3)
    expect(final.done).toBe(1)
    // 2 次重试各等一次；成功之后是最后一个任务，不再等
    expect(waits).toEqual([300, 300])
  })

  it('重试次数耗尽后标记失败，但不中断整批', async () => {
    const ran: number[] = []
    const d = deps({
      runTask: async (t) => {
        ran.push(t.index)
        if (t.index === 0) throw naiError('http')
      },
    })
    const final = await new RunQueue(d).start('r1', [task(0), task(1)])
    // 第 0 张跑了 1 + 2 次重试
    expect(ran.filter((x) => x === 0)).toHaveLength(3)
    expect(final.failed).toBe(1)
    expect(final.done).toBe(1)
    expect(final.status).toBe('done')
  })
})

describe('RunQueue — 429 并发冲突', () => {
  it('收到 429 立即暂停，且不重试', async () => {
    let calls = 0
    const d = deps({
      runTask: async () => {
        calls++
        throw naiError('concurrent', '检测到并发冲突')
      },
    })
    const queue = new RunQueue(d)
    const running = queue.start('r1', [task(0), task(1)])

    await vi.waitFor(() => expect(queue.progress.status).toBe('paused'))
    expect(calls).toBe(1) // 没有重试
    expect(queue.progress.pauseReason).toContain('并发冲突')
    expect(queue.progress.done).toBe(0)
    expect(queue.progress.failed).toBe(0) // 不算失败

    queue.cancel()
    await running
  })

  it('resume 后从队首那张重发，不跳过它', async () => {
    const ran: number[] = []
    let firstCall = true
    const d = deps({
      runTask: async (t) => {
        ran.push(t.index)
        if (firstCall) {
          firstCall = false
          throw naiError('concurrent')
        }
      },
    })
    const queue = new RunQueue(d)
    const running = queue.start('r1', [task(0), task(1)])

    await vi.waitFor(() => expect(queue.progress.status).toBe('paused'))
    queue.resume()
    const final = await running

    expect(ran).toEqual([0, 0, 1])
    expect(final.done).toBe(2)
    expect(final.status).toBe('done')
  })

  it('暂停期间取消，已完成的保留', async () => {
    let calls = 0
    const d = deps({
      runTask: async () => {
        calls++
        if (calls === 2) throw naiError('concurrent')
      },
    })
    const queue = new RunQueue(d)
    const running = queue.start('r1', [task(0), task(1), task(2)])

    await vi.waitFor(() => expect(queue.progress.status).toBe('paused'))
    queue.cancel()
    const final = await running

    expect(final.status).toBe('cancelled')
    expect(final.done).toBe(1)
  })
})

describe('RunQueue — 取消', () => {
  it('取消后不再跑剩余任务', async () => {
    const ran: number[] = []
    const queue = new RunQueue(
      deps({
        runTask: async (t) => {
          ran.push(t.index)
        },
      }),
    )
    const running = queue.start('r1', [task(0), task(1), task(2)])
    queue.cancel()
    const final = await running
    expect(final.status).toBe('cancelled')
    expect(ran.length).toBeLessThan(3)
  })
})

describe('RunQueue — 取消与在途失败的竞态', () => {
  it('取消在任务在途时到达、该任务随后以 429 拒绝时，不会被改回暂停', async () => {
    // 用对象包一层而不是裸 let：闭包捕获的 let 变量在被内层
    // Promise executor 重新赋值后，tsc 仍按声明时的字面量 null 窄化，
    // 导致后面 `rejectTask?.()` 报 "Type 'never' has no call signatures"
    const pending: { reject: ((e: unknown) => void) | null } = { reject: null }
    const d = deps({
      runTask: () =>
        new Promise<void>((_resolve, reject) => {
          pending.reject = reject
        }),
    })
    const queue = new RunQueue(d)
    const running = queue.start('r1', [task(0), task(1)])

    // 等 runTask 真的被调用——此时它挂着，尚未 settle
    await vi.waitFor(() => expect(pending.reject).not.toBeNull())

    // 取消先到，429 后到：修复前 catch 会把状态改回 paused，
    // 循环随即等一个永远不来的唤醒
    queue.cancel()
    pending.reject?.(naiError('concurrent'))

    const final = await running
    expect(final.status).toBe('cancelled')
  })
})

describe('RunQueue.progress.current — 正在生成哪一张', () => {
  it('发请求之前就播报当前这一张，跑完清空', async () => {
    const seen: Array<{ current: RunProgress['current']; done: number }> = []
    const tasks = [task(0)]
    const q = new RunQueue({
      runTask: async () => {
        // runTask 执行期间，最近一次播报必须已经指向这一张
        const last = seen[seen.length - 1]
        expect(last.current).toBe(0)
      },
      sleep: async () => {},
      intervalMs: 0,
      retryCount: 0,
      onProgress: (p) => seen.push({ current: p.current, done: p.done }),
    })
    const final = await q.start('r1', tasks)
    expect(final.current).toBeNull()
    // 跑完那一次播报里 current 必须已经清空，否则界面会一直亮着最后一格
    expect(seen[seen.length - 1]).toEqual({ current: null, done: 1 })
  })

  it('暂停时清空——任务还在队首没发出去，标成生成中是撒谎', async () => {
    // 用数组收而不是可变变量：回调里的赋值 tsc 的控制流分析看不到，
    // 它会顺着初始的 null 把变量窄化成 never，后面读 .current 直接编译不过
    const pausedEvents: RunProgress[] = []
    const q = new RunQueue({
      runTask: async () => {
        throw Object.assign(new Error('429'), { kind: 'concurrent' })
      },
      sleep: async () => {},
      intervalMs: 0,
      retryCount: 0,
      onProgress: (p) => {
        if (p.status === 'paused') pausedEvents.push(p)
      },
    })
    const run = q.start('r1', [task(0)])
    await Promise.resolve()
    await Promise.resolve()
    q.cancel()
    await run
    expect(pausedEvents.length).toBeGreaterThan(0)
    expect(pausedEvents[0].current).toBeNull()
  })
})
