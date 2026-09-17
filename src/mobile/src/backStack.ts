// 手机端的返回键（APK 壳里的系统返回键 / 返回手势）。
//
// 壳（MainActivity.onBackPressed）先调页面的 window.NaiBack()：返回 true 表示页面自己处理了，
// false 才走 WebView 后退（退回连接页）。页面内部的弹窗、页签切换都不产生浏览记录，
// 不这么接的话返回键永远是「退回连接页」。
//
// 规则（2026-09-17 确认）：有弹窗先关最上层；历史某一轮的详情页回列表；其他页签回工作台；
// 工作台上连按两次才回连接页。各处用 useBackHandler 登记，这里只管挑谁来处理。

/** 优先级高的先处理；同一级里后登记（后打开）的先处理 */
export const BACK_PRIORITY = {
  /** 页签：不在工作台就回工作台；在工作台则是「连按两次回连接页」 */
  page: 0,
  /** 页签里的下一级页面（历史某一轮的详情） */
  subpage: 1,
  /** 弹窗：底部弹层、大图、参数页、日志页 */
  popup: 2,
} as const

/** 返回 true 表示处理掉了；false 表示不管，交给下一个（最后交给壳去后退） */
export type BackHandler = () => boolean

export interface BackStack {
  /** 返回注销函数 */
  register: (priority: number, handler: BackHandler) => () => void
  handle: () => boolean
}

export function createBackStack(): BackStack {
  let seq = 0
  const entries = new Map<number, { priority: number; order: number; handler: BackHandler }>()
  return {
    register(priority, handler) {
      seq += 1
      const id = seq
      entries.set(id, { priority, order: id, handler })
      return () => {
        entries.delete(id)
      }
    },
    handle() {
      const sorted = [...entries.values()].sort((a, b) => b.priority - a.priority || b.order - a.order)
      for (const entry of sorted) {
        if (entry.handler()) return true
      }
      return false
    },
  }
}

/** 连按两次的判定窗口：第一次按下后这么久之内再按才算 */
export const LEAVE_CONFIRM_MS = 2000

/**
 * 工作台上按返回：第一次只提示，窗口内的第二次才放行。
 *
 * @param lastPress 上一次「只提示」的时间；0 = 没有待确认的那一次
 * @returns leave 为 true 时放行（交给壳后退）；next 是新的 lastPress
 */
export function confirmLeave(lastPress: number, now: number): { leave: boolean; next: number } {
  if (lastPress > 0 && now - lastPress <= LEAVE_CONFIRM_MS) return { leave: true, next: 0 }
  return { leave: false, next: now }
}

/** 整个页面共用的那一份 */
export const backStack = createBackStack()

declare global {
  interface Window {
    /** 壳调用的入口，见文件头 */
    NaiBack?: () => boolean
  }
}

export function installBackBridge(): void {
  window.NaiBack = () => backStack.handle()
}
