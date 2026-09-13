import type { LlmLogLine, LogLevel } from '@shared/llm'

/**
 * 一轮 LLM 交互的日志。每写一行立刻交给 sink（IPC 推给渲染进程）。
 * 文案沿用插件 logger.info / warn / error 的原句，界面照 koishi LOG 一行一条显示。
 */
export class RunLog {
  constructor(
    private readonly sink: (line: LlmLogLine) => void,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  info(text: string): void {
    this.write('I', text)
  }

  warn(text: string): void {
    this.write('W', text)
  }

  error(text: string): void {
    this.write('E', text)
  }

  private write(level: LogLevel, text: string): void {
    const d = this.clock()
    const time = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
    try {
      this.sink({ time, level, text })
    } catch {
      // 推送失败（窗口已关）不该中断这一轮：结果仍会作为 invoke 的返回值交回去
    }
  }
}
