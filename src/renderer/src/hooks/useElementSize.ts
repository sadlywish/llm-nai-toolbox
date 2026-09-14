import { useEffect, useRef, useState } from 'react'

/**
 * 监听某个元素的实际渲染尺寸（RunGrid 的格子布局、ImageViewer 的 1:1 定位
 * 都要跟着容器/视口尺寸重算，抽成共用 hook 避免重复实现）。
 */
export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return { ref, size }
}
