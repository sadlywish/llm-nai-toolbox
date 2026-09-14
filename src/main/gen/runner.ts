import { join } from 'path'
import type { AppConfig } from '@shared/config'
import type {
  GenImageEvent,
  GenStartInput,
  GenTask,
  GenerateResult,
  ImageRecord,
  RoundRecord,
  RunProgress,
  RunStatus,
} from '@shared/gen'
import { newId } from '@shared/ids'
import { IndexStore } from '../nai/index-store'
import { buildPayload, type NaiRequestBody } from '../nai/payload'
import { extractPngSeed } from '../nai/png'
import { dateDirName, saveImage } from '../nai/save'
import { RunQueue } from './queue'
import { assemble, takeSnapshot } from './snapshot'

export interface GenRunnerDeps {
  /** 真实实现转调 nai/client 的 generateImage；承诺永不 reject */
  generate(body: NaiRequestBody, config: AppConfig, token: string): Promise<GenerateResult>
  sleep(ms: number): Promise<void>
  onProgress(p: RunProgress): void
  /** 单张出图（成功或失败）事件：界面边跑边填格子 */
  onImage(e: GenImageEvent): void
  /**
   * 要写回参数区的 seed：固定模式且 seed 为 -1 时开跑即发（用户立刻看到钉死的值）；
   * 每张随机模式跑完发最后一张的（参数区提示「出图后回填最后一次的值」）
   */
  onSeedResolved(seed: number): void
  now(): Date
  randomSeed(): number
}

/**
 * 队列的终态映射到轮次的落盘状态。RunQueue.start() 只会在 done/cancelled/aborted 退出；
 * RunStatus 的类型更宽，用 switch 兜底而不是断言，异常状态兜成 aborted 而不是静默吞掉。
 */
function toRoundStatus(status: RunStatus): 'done' | 'cancelled' | 'aborted' {
  switch (status) {
    case 'done':
    case 'cancelled':
    case 'aborted':
      return status
    default:
      return 'aborted'
  }
}

function failedRecord(task: GenTask, message: string): ImageRecord {
  return { index: task.index, file: '', seed: task.seed, status: 'failed', error: message }
}

/**
 * 一轮出图：预检 → 分配 seed → 拍快照、拼接 → 建轮次记录 → 队列逐张跑 → 落盘 → 记账 → 收尾。
 * 编排照画师串工具箱 run/runner.ts；网络与时间都经 deps 注入，node 下可完整测试。
 */
export class GenRunner {
  private queue: RunQueue | null = null
  /**
   * 在途保护。gen:start 是渲染进程可任意重复调用的边界——没有这道闸，第二次调用会覆盖
   * this.queue，让第一轮的 resume()/cancel() 全部打空，卡在 429 暂停的那一轮永远停住。
   */
  private running = false

  constructor(private readonly deps: GenRunnerDeps) {}

  async start(input: GenStartInput, config: AppConfig, token: string): Promise<RunProgress> {
    if (this.running) throw new Error('已有一轮正在进行中。请先等待它结束或取消。')
    this.running = true
    try {
      if (!config.saveDir) throw new Error('未设置图片保存目录，请先到设置里指定。')
      // no-token 也会被队列的 fatal 分支拦下，但那要先建好轮次、发出第一个请求才发现。
      // 装完应用忘填 Token 是最常见的路径，提前挡住就不会留下一条空跑的轮次
      if (!token) throw new Error('未配置 NovelAI Token，请先到设置里填写。')

      const { workspace, count } = input
      const params = workspace.params
      const fixed = params.seedMode === 'fixed'
      // 固定模式：给了具体值就全程用它；给的是 -1 就随机一次、全程复用
      const fixedSeed = fixed ? (params.seed >= 0 ? params.seed : this.deps.randomSeed()) : null
      const tasks: GenTask[] = Array.from({ length: count }, (_, index) => ({
        index,
        seed: fixedSeed ?? this.deps.randomSeed(),
      }))
      if (fixed && params.seed < 0 && fixedSeed !== null) this.notifySeed(fixedSeed)

      // 快照记「本轮实际用了什么」：固定模式填 -1 时实际用的是随机出来的值，
      // 快照里仍记 -1 的话，「复制信息」回参数区后下一轮又会随机一个新的
      const snapshot = takeSnapshot(workspace, fixedSeed)
      const assembled = assemble(snapshot, config)

      const roundId = newId('round')
      const startedAt = this.deps.now()
      // 日期目录与轮次记录在开跑前建好：即使第一张就失败，历史里也要能看到这一轮与失败原因。
      // 整轮固定用 startedAt 定目录，跨零点也不会把一轮劈成两天
      const index = new IndexStore(join(config.saveDir, dateDirName(startedAt)))
      const round: RoundRecord = {
        id: roundId,
        startedAt: startedAt.toISOString(),
        finishedAt: null,
        status: 'running',
        count,
        snapshot,
        assembled,
        images: [],
      }
      index.startRound(round)

      const runTask = async (task: GenTask): Promise<void> => {
        const body = buildPayload({
          assembled,
          params: snapshot.params,
          useCoords: snapshot.useCoords,
          seed: task.seed,
          imageFormat: config.imageFormat,
        })

        let result: GenerateResult
        try {
          result = await this.deps.generate(body, config, token)
        } catch (e) {
          // generate 承诺永不 reject；契约被破坏时同样记一条，让「队列说失败」与「索引里有失败记录」永远同步
          index.putImage(roundId, failedRecord(task, e instanceof Error ? e.message : String(e)))
          throw e
        }

        if (!result.ok) {
          const err = Object.assign(new Error(result.error.message), { kind: result.error.kind })
          // concurrent 不记账：那一张会原样重发，记了会在历史里留下一条假的失败
          if (result.error.kind !== 'concurrent') {
            const failed = failedRecord(task, result.error.message)
            index.putImage(roundId, failed)
            this.notifyImage({ ...failed, roundId })
          }
          throw err
        }

        // 落盘/记账段单独兜底，与上面 generate 的 try/catch 并列而不是合并：合并的话
        // 「!result.ok」分支抛出的 concurrent 错误会被同一个 catch 接住并写进索引
        let rec: ImageRecord
        try {
          const image = result.images[0]
          const bytes = Buffer.from(image.data, 'base64')
          // seed 三级来源：接口回报 → PNG 自带元数据 → 请求时用的值
          const seed = image.seed ?? extractPngSeed(bytes) ?? task.seed
          const saved = saveImage(config.saveDir, bytes, image.mimeType, seed, startedAt)
          rec = { index: task.index, file: saved.fileName, seed, status: 'ok', error: null }
          index.putImage(roundId, rec)
        } catch (e) {
          const failed = failedRecord(task, e instanceof Error ? e.message : String(e))
          index.putImage(roundId, failed)
          this.notifyImage({ ...failed, roundId })
          throw e
        }
        // 通知放在落盘兜底之外：图已落盘、已记成 ok，通知失败（跑图中关窗）绝不能把它翻写成 failed
        this.notifyImage({ ...rec, roundId })
      }

      this.queue = new RunQueue({
        runTask,
        sleep: this.deps.sleep,
        intervalMs: config.taskIntervalMs,
        retryCount: config.retryCount,
        onProgress: (p) => {
          // 429 暂停要落盘：应用恰好在暂停期间被关掉时，读取才能推导成「暂停中被中断」
          if (p.status === 'paused') index.pauseRound(roundId)
          this.deps.onProgress(p)
        },
      })

      const final = await this.queue.start(roundId, tasks)

      // 每张随机模式只在跑完后回填最后一张的 seed。取消或中止时后面的根本没跑，回填没用过的值是撒谎
      if (final.status === 'done' && !fixed && tasks.length > 0) this.notifySeed(tasks[tasks.length - 1].seed)

      index.finishRound(roundId, this.deps.now().toISOString(), toRoundStatus(final.status))
      return final
    } finally {
      this.running = false
      this.queue = null
    }
  }

  /** 429 暂停后人工确认继续；从队首那张重发 */
  resume(): void {
    this.queue?.resume()
  }

  /** 取消整批；已完成的保留 */
  cancel(): void {
    this.queue?.cancel()
  }

  /** 通知渲染进程失败不该让整轮跑图崩掉 */
  private notifyImage(e: GenImageEvent): void {
    try {
      this.deps.onImage(e)
    } catch {
      // 吞掉：这一步失败不影响已经落盘、已经记账的事实
    }
  }

  private notifySeed(seed: number): void {
    try {
      this.deps.onSeedResolved(seed)
    } catch {
      // 同上
    }
  }
}
