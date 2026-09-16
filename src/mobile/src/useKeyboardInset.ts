// 软键盘弹出时，键盘占掉的那段高度。底部弹层（EditSheet）与底部指令区（Console）共用。
import { useEffect, useState } from 'react'

/**
 * 安卓 Chrome 会把布局视口一起缩掉，算出来是 0，贴着底边的东西自然就在键盘上面；
 * iOS Safari 不缩——底部那一条会原地留在键盘底下，用户看不见自己在打什么。
 * 拿 visualViewport 把这段高度让出来是唯一可靠的办法（写死一个高度在不同机型上一定错）。
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)

  useEffect(() => {
    const vv = typeof window === 'undefined' ? undefined : window.visualViewport
    if (!vv) return
    const sync = (): void => setInset(Math.max(0, window.innerHeight - (vv.height + vv.offsetTop)))
    sync()
    vv.addEventListener('resize', sync)
    // 键盘顶起页面时 visualViewport 会跟着滚，只听 resize 会慢半拍停在错的位置
    vv.addEventListener('scroll', sync)
    return () => {
      vv.removeEventListener('resize', sync)
      vv.removeEventListener('scroll', sync)
    }
  }, [])

  return inset
}
