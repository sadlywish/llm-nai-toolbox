import { useEffect, useRef } from 'react'

/**
 * 回到前台时做一次「接回来」：页面在后台被冻结期间，SSE 常常是半死状态——
 * socket 还在、事件早就不来了，而 EventSource 的 onerror 不一定触发，
 * 所以不能只等它报错（这也是「切出去等跑图，回来一片空白」的成因之一）。
 *
 * 离开超过 RECONNECT_AFTER_HIDDEN_MS 就直接重建连接：代价只是一次重连，
 * 比「看着状态点是绿的、其实什么都收不到」强得多。短暂切走（看一眼通知）不折腾。
 */
export const RECONNECT_AFTER_HIDDEN_MS = 10_000

export function shouldReconnect(hiddenMs: number): boolean {
  return hiddenMs >= RECONNECT_AFTER_HIDDEN_MS
}

/**
 * @param onResume 回前台时调用，参数是这次在后台待了多久（毫秒）。
 *   页面一直没被切走就不会触发；用 pageshow 兜住 iOS 的往返缓存（bfcache）恢复。
 */
export function useResume(onResume: (hiddenMs: number) => void): void {
  const ref = useRef(onResume)
  ref.current = onResume
  useEffect(() => {
    let hiddenAt: number | null = null
    const resume = (): void => {
      const away = hiddenAt === null ? 0 : Date.now() - hiddenAt
      hiddenAt = null
      ref.current(away)
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now()
        return
      }
      resume()
    }
    // bfcache 恢复时不一定有 visibilitychange，persisted 的那次一律当成「刚回来」
    const onPageShow = (e: PageTransitionEvent): void => {
      if (e.persisted) resume()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [])
}
