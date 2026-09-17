import { useEffect, useRef } from 'react'
import { BACK_PRIORITY, backStack } from './backStack'

/**
 * 登记返回键处理（规则见 backStack.ts）。`active` 为 true 期间生效；打开时登记，所以后打开的弹窗先关。
 *
 * onBack 放在 ref 里：它每次渲染都是新函数，拿它做依赖会反复注销再登记，
 * 登记顺序被刷新之后「后打开的先关」就不成立了。onBack 返回 false 表示这次不管，交给下一个。
 */
export function useBackHandler(active: boolean, onBack: () => boolean | void, priority: number = BACK_PRIORITY.popup): void {
  const ref = useRef(onBack)
  ref.current = onBack
  useEffect(() => {
    if (!active) return undefined
    return backStack.register(priority, () => ref.current() !== false)
  }, [active, priority])
}
