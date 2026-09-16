import type { GenImageEvent, RunProgress } from '@shared/gen'
import type { LlmEvent } from '@shared/llm'

/**
 * 主进程里「一件事发生了」的统一出口。
 *
 * 出图事件原本是 ipc.ts 闭包里的三个回调直接广播给窗口的，那种接法只有一个消费者；
 * 手机端 HTTP 服务要把同一批事件推给 SSE 连接，再加一个回调就得改 GenRunner 的构造，
 * 每多一个消费者改一次。所以中间放一层总线：GenRunner 只管 emit，谁要听谁自己 on。
 */
export type AppEvent =
  | { kind: 'gen-progress'; progress: RunProgress }
  | { kind: 'gen-image'; image: GenImageEvent }
  | { kind: 'gen-seed'; seed: number }
  | { kind: 'llm'; event: LlmEvent }
  // 手机端「选为预设画风」改了 workspace.json 里的 console.presetId。桌面端的工作区是
  // 内存态 + 防抖存盘，只落盘的话界面既看不到变化，下一次存盘还会把这个值覆盖回旧的，
  // 所以这件事必须实时告诉渲染进程。只带 presetId：工作区别的字段一概不归这条事件管
  | { kind: 'preset-changed'; presetId: string }

export class AppEvents {
  private readonly listeners = new Set<(e: AppEvent) => void>()

  /** 订阅，返回退订函数。重复退订是空操作（Set.delete 幂等） */
  on(fn: (e: AppEvent) => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  emit(e: AppEvent): void {
    // 先取快照再遍历：订阅者在回调里退订（SSE 连接断开就是这么收场的）会改动 listeners，
    // 直接遍历活的 Set 会漏掉排在它后面的那些订阅者
    for (const fn of [...this.listeners]) {
      try {
        fn(e)
      } catch (err) {
        // 一个订阅者塌了不能连累别人，更不能把异常抛回发事件的那一方——
        // 出图进度是从 RunQueue 里发出来的，异常逃上去会把正在跑的那一轮弄停。
        // 同 TagdbLoader.set 的做法
        console.warn('[appEvents] 订阅者处理事件时抛错：', err)
      }
    }
  }
}
