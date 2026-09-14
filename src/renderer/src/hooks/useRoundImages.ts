import { useEffect, useRef, useState } from 'react'

export type RoundImageState = { kind: 'loading' } | { kind: 'ready'; url: string } | { kind: 'missing' }

interface Loaded {
  round: string | null
  requested: Set<string>
  urls: string[]
}

/**
 * 一轮里若干张图的 object URL。图片一律经 window.api.readImage 读字节再转 URL——
 * 开发态 renderer 的 origin 是 http://localhost，file:// 会被拦；统一走这条路，两种形态一个样。
 *
 * 按需读：files 里新出现的文件名才去读（跑图中一张张追加）；换轮次或卸载时把发出去的 URL 全部回收，
 * 弹窗反复开关不回收的话，几十张 1MB 的图很快把内存吃掉。
 */
export function useRoundImages(roundStartedAt: string | null, files: readonly string[]): Record<string, RoundImageState> {
  const [states, setStates] = useState<Record<string, RoundImageState>>({})
  const loaded = useRef<Loaded>({ round: null, requested: new Set(), urls: [] })
  const fileKey = files.join('\n')

  useEffect(() => {
    if (loaded.current.round !== roundStartedAt) {
      loaded.current.urls.forEach((u) => URL.revokeObjectURL(u))
      loaded.current = { round: roundStartedAt, requested: new Set(), urls: [] }
      setStates({})
    }
    if (roundStartedAt === null) return
    // 这一批读取只认发起时的那份记录：读回来时已经换了轮次或卸载，就丢掉结果，也不创建 URL
    const token = loaded.current
    for (const file of files) {
      if (file === '' || token.requested.has(file)) continue
      token.requested.add(file)
      setStates((s) => ({ ...s, [file]: { kind: 'loading' } }))
      void window.api.readImage({ roundStartedAt, file }).then((buf) => {
        if (loaded.current !== token) return
        if (buf === null) {
          setStates((s) => ({ ...s, [file]: { kind: 'missing' } }))
          return
        }
        const url = URL.createObjectURL(new Blob([buf]))
        token.urls.push(url)
        setStates((s) => ({ ...s, [file]: { kind: 'ready', url } }))
      })
    }
    // files 只用来决定要读哪些；以内容为依赖，免得每次渲染换新数组就重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roundStartedAt, fileKey])

  useEffect(
    () => () => {
      loaded.current.urls.forEach((u) => URL.revokeObjectURL(u))
      loaded.current = { round: null, requested: new Set(), urls: [] }
    },
    [],
  )

  return states
}
