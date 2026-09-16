import type { LlmEvent, LlmRunInput, LlmRunResult } from '@shared/llm'
import { runLlm, type RunnerDeps } from './runner'

/**
 * 「上一轮还在跑」。单独一个类型是为了让调用方能分辨它：
 * IPC 那边照旧把它当普通异常抛给渲染进程，HTTP 服务那边要把它转成 409。
 *
 * **别给它设 name**：ipcMain.handle 抛出的异常到渲染进程是 `${error}` 拼进去的，
 * 而 ipcErrorMessage 只剥 `Error: ` 这一个前缀——设了 name，指令区那行就会变成
 * 「发送失败：BusyError: 上一轮还在运行…」。
 */
export class BusyError extends Error {}

/** 每轮开跑那一刻现做的依赖。配置、API Key、chat 实现都在这里面取——所以改设置只影响下一轮 */
export type MakeRunnerDeps = (input: LlmRunInput, signal: AbortSignal, emit: (e: LlmEvent) => void) => RunnerDeps

export interface LlmSessionDeps {
  deps: MakeRunnerDeps
}

/**
 * LLM 的单例运行：在途保护 + 中止 + 收尾事件。
 *
 * 同一时刻只允许一轮：两轮并发写同一份工作区，回填结果谁先谁后说不清。原来这道闸是
 * ipc.ts 闭包里的一个 `currentRun` 变量，只有 IPC 进得来；手机端也能发指令之后，
 * 闸必须是两边共用的同一个，否则电脑和手机各跑一轮，回填互相覆盖。
 *
 * 这里不 import electron：事件出口由调用方用 emit 传进来（IPC 只推给发起那一轮的窗口，
 * HTTP 推给 SSE 连接），所以能在 node 环境里直接测。
 */
export class LlmSession {
  /** 正在跑的那一轮；null 表示空闲。既是闸也是中止的把手 */
  private controller: AbortController | null = null

  constructor(private readonly make: MakeRunnerDeps) {}

  get busy(): boolean {
    return this.controller !== null
  }

  async run(input: LlmRunInput, emit: (e: LlmEvent) => void): Promise<LlmRunResult> {
    if (this.controller !== null) throw new BusyError('上一轮还在运行，先等它结束或中止')
    const controller = new AbortController()
    this.controller = controller
    try {
      const result = await runLlm(input, this.make(input, controller.signal, emit))
      // 收尾经事件送达：与日志同一条通道，保证排在最后一行日志之后
      emit({ kind: 'finished', result })
      return result
    } finally {
      // runLlm 自己兜住了所有失败（返回 failed/aborted），真抛到这里的是依赖没接上一类的问题；
      // 那种情况也必须把闸放开，否则整个应用再也发不出第二轮
      this.controller = null
    }
  }

  /** 中止在途的那一轮；没有在途的就什么都不做 */
  abort(): void {
    this.controller?.abort()
  }
}
