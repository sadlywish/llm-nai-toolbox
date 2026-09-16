import { create } from 'zustand'
import type { NaiSubscription, NaiSubscriptionError } from '@shared/naiUser'
import { ipcErrorMessage } from '../ipcError'

/**
 * NovelAI 账号额度（剩余点数与 V5 按时限额）。
 * 启动后查一次、每轮出图结束后刷新、顶栏 ⟳ 手动刷新（界面稿 2026-09-16-nai-usage-mockup.html 位置 B）。
 */
export type NaiUsageState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; subscription: NaiSubscription; at: number }
  | { kind: 'error'; error: NaiSubscriptionError }

interface Store {
  state: NaiUsageState
  refresh: () => Promise<void>
}

export const useNaiUsage = create<Store>((set, get) => ({
  state: { kind: 'idle' },

  refresh: async () => {
    // 已经在查就不叠第二次：出图结束与手动点可能撞在一起
    if (get().state.kind === 'loading') return
    set({ state: { kind: 'loading' } })
    try {
      const r = await window.api.naiSubscription()
      set({ state: r.ok ? { kind: 'ready', subscription: r.subscription, at: Date.now() } : { kind: 'error', error: r.error } })
    } catch (err) {
      // 通道本身出问题（主进程抛了）也要落到界面上，不能让它一直停在「查询中」
      set({ state: { kind: 'error', error: { kind: 'network', message: ipcErrorMessage(err) } } })
    }
  },
}))
