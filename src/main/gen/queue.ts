import type { GenTask, NaiErrorKind, RunProgress, RunStatus } from '@shared/gen'

export interface QueueDeps {
  /** 执行一个任务；失败时抛出带 `kind` 的错误 */
  runTask(task: GenTask): Promise<void>
  sleep(ms: number): Promise<void>
  intervalMs: number
  retryCount: number
  onProgress(p: RunProgress): void
  /** 命中即不重试、直接中止整轮的错误种类；缺省用 DEFAULT_FATAL_KINDS */
  fatalKinds?: NaiErrorKind[]
}

function errorKind(e: unknown): NaiErrorKind | undefined {
  return (e as { kind?: NaiErrorKind })?.kind
}

/**
 * 重试注定无用的错误。token 没填、token 失效、点数不足——
 * 这三种每重试一次就白发一次注定失败的真实请求，而剩下的任务
 * 其实完全没问题。一个 60 张的批次会打出 180 次 401 和 60 条垃圾记录，
 * 用户看到的是「失败 60」而不是「token 过期了」。
 */
export const DEFAULT_FATAL_KINDS: NaiErrorKind[] = ['no-token', 'unauthorized', 'payment']

/**
 * 串行队列。
 *
 * NovelAI 只支持单并发，所以这里没有并发度可调——一次一张。
 *
 * 429 的处置与其他错误**完全不同**（spec §9.3）：普通失败重试 retryCount 次后
 * 标红、继续跑下一个；429 则不重试、不跳过，把当前任务留在队首、暂停整个队列、
 * 等人工确认。因为 429 的含义是「有别的客户端正在生成」，自动重试只会继续撞车，
 * 把本轮剩余任务连环打成失败——而那些任务其实完全没问题。
 */
export class RunQueue {
  private status: RunStatus = 'idle'
  private roundId = ''
  private total = 0
  private done = 0
  private failed = 0
  private pauseReason: string | null = null
  private abortReason: string | null = null
  /** 正在发出请求的那一张；暂停与结束时清空——暂停时任务还在队首没发出去，
   *  标成「生成中」是撒谎 */
  private current: RunProgress['current'] = null
  private readonly fatalKinds: NaiErrorKind[]
  /** 暂停时挂在这里；resume / cancel 负责解开 */
  private wakeUp: (() => void) | null = null

  constructor(private readonly deps: QueueDeps) {
    this.fatalKinds = deps.fatalKinds ?? DEFAULT_FATAL_KINDS
  }

  get progress(): RunProgress {
    return {
      roundId: this.roundId,
      status: this.status,
      total: this.total,
      done: this.done,
      failed: this.failed,
      pauseReason: this.pauseReason,
      abortReason: this.abortReason,
      current: this.current,
    }
  }

  /**
   * 是否已取消。
   *
   * 不直接写 `this.status === 'cancelled'`：`resume()` / `cancel()` 会在
   * `await` 期间从外部异步改写 `this.status`，而 tsc 的控制流分析看不到
   * 这一点——它会顺着字面量比较把 `this.status` 的类型一路窄化下去，
   * 导致本函数内后续几处同样的比较被判定为「不可能为 true」（TS2367 no
   * overlap）。换成同样返回 `RunStatus` 的 getter 一样躲不开：tsc 对裸
   * 字段访问和访问器属性同等对待，两者都参与控制流窄化。真正起作用的
   * 是把它包成一次**方法调用**——调用表达式（带括号）不参与控制流窄化，
   * 比较的对象不再是会被字面量比较收窄的访问路径，这类误判才不会发生。
   */
  private isCancelled(): boolean {
    return this.status === 'cancelled'
  }

  private emit(): void {
    this.deps.onProgress(this.progress)
  }

  async start(roundId: string, tasks: GenTask[]): Promise<RunProgress> {
    this.roundId = roundId
    this.total = tasks.length
    this.done = 0
    this.failed = 0
    this.pauseReason = null
    this.abortReason = null
    this.current = null
    this.status = 'running'
    this.emit()

    let i = 0
    let attempts = 0

    while (i < tasks.length) {
      if (this.isCancelled()) break

      if (this.status === 'paused') {
        await this.waitForResume()
        continue
      }

      try {
        // 发请求**之前**先播报，界面才能在这张跑的过程中把对应格子标出来；
        // 只在成功之后 emit 的话，正在跑的那张永远不会被显示成「生成中」
        const t = tasks[i]
        this.current = t.index
        this.emit()
        await this.deps.runTask(t)
        this.current = null
        this.done++
        i++
        attempts = 0
        this.emit()
      } catch (e) {
        // 取消可能在 runTask 在途时到达。此时 status 已是 cancelled，
        // 绝不能被下面的 429 分支改回 paused——那会让循环进入
        // waitForResume() 等一个永远不会来的唤醒，start() 的 promise
        // 再也不会 resolve。这里直接跳出，顺带也避免了取消后还白白重试
        this.current = null

        if (this.isCancelled()) break

        if (errorKind(e) === 'concurrent') {
          // 不推进 i、不计失败、不重试：这一张留在队首等人工确认
          this.status = 'paused'
          this.pauseReason = e instanceof Error ? e.message : String(e)
          this.emit()
          continue
        }

        const kind = errorKind(e)
        if (kind && this.fatalKinds.includes(kind)) {
          // token 没填/失效、点数不足：重试注定失败。这一张的失败记录
          // 已经由 runTask 里 `!result.ok` 的分支写好了，这里只结账、
          // 不再给剩余任务补写记录——那正是要消灭的垃圾数据
          this.failed++
          this.abortReason = e instanceof Error ? e.message : String(e)
          this.status = 'aborted'
          this.emit()
          break
        }

        if (attempts < this.deps.retryCount) {
          attempts++
          // 重试之间同样间隔 intervalMs（spec §9 第 5 条）：不等待的话，
          // network/timeout 这类瞬时故障会在 0ms 内连打 retryCount+1 次，
          // 大概率全部撞在同一个故障窗口里，等于把重试的价值削掉大半
          await this.deps.sleep(this.deps.intervalMs)
          continue
        }
        this.failed++
        i++
        attempts = 0
        this.emit()
      }

      if (i < tasks.length && this.status === 'running') {
        await this.deps.sleep(this.deps.intervalMs)
      }
    }

    if (this.status === 'running') this.status = 'done'
    this.pauseReason = null
    this.emit()
    return this.progress
  }

  /** 429 暂停后人工确认继续；从队首那张重发 */
  resume(): void {
    if (this.status !== 'paused') return
    this.status = 'running'
    this.pauseReason = null
    this.emit()
    this.wakeUp?.()
  }

  /** 取消整批；已完成的保留。与暂停不同，取消不可恢复 */
  cancel(): void {
    if (this.status === 'done' || this.status === 'cancelled') return
    this.status = 'cancelled'
    this.pauseReason = null
    this.emit()
    this.wakeUp?.()
  }

  private waitForResume(): Promise<void> {
    return new Promise((resolve) => {
      this.wakeUp = () => {
        this.wakeUp = null
        resolve()
      }
    })
  }
}
