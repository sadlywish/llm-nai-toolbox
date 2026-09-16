// SSE 连接管理。不 import electron：HTTP 服务要能在 node 下单独跑测试（同 devices.ts）。
import type { ServerResponse } from 'http'
import type { MobileEvent } from '../../shared/mobileApi'

/**
 * 15 秒一条心跳。手机上这条长连接要穿过路由器与手机自己的省电策略，
 * 空闲久了会被悄悄掐掉——掐掉时浏览器不一定立刻报错，前端会以为还连着、
 * 一直等不到事件。定期发一条注释行既让中间设备看到流量，也让断开尽快暴露。
 */
const DEFAULT_HEARTBEAT_MS = 15_000

export interface SseHub {
  /** 把一个响应挂成 SSE 连接，返回退订函数（幂等，重复调用是空操作） */
  attach(res: ServerResponse): () => void
  push(e: MobileEvent): void
  readonly count: number
}

export function createSseHub(deps: { heartbeatMs?: number } = {}): SseHub {
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const clients = new Set<ServerResponse>()
  let timer: NodeJS.Timeout | null = null

  /** 写失败就当这条连接没了：对端已经断开时 write 会抛，不能让它冒到发事件的那一方 */
  const write = (res: ServerResponse, chunk: string): boolean => {
    try {
      res.write(chunk)
      return true
    } catch {
      return false
    }
  }

  const stopHeartbeat = (): void => {
    if (timer === null) return
    clearInterval(timer)
    timer = null
  }

  const startHeartbeat = (): void => {
    if (timer !== null) return
    timer = setInterval(() => {
      // `: ping` 是 SSE 的注释行，客户端会忽略它，只起「这条连接还活着」的作用
      for (const res of [...clients]) {
        if (!write(res, ': ping\n\n')) detach(res)
      }
    }, heartbeatMs)
    // 心跳不该让进程为它活着：主进程有窗口撑着无所谓，测试进程会因此退不出去
    timer.unref?.()
  }

  const detach = (res: ServerResponse): void => {
    // delete 返回 false 说明已经退订过了，后面的收尾不能再做一遍
    if (!clients.delete(res)) return
    if (clients.size === 0) stopHeartbeat()
    try {
      res.end()
    } catch {
      /* 连接已经断了，end 抛错不影响退订 */
    }
  }

  return {
    attach(res: ServerResponse): () => void {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        // no-transform 是挡中间层的压缩改写：压缩会把事件攒在缓冲区里，进度就不是实时的了
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // nginx 之类的反代默认会缓冲响应体，同样会把事件攒住
        'X-Accel-Buffering': 'no',
      })
      clients.add(res)
      // 先写一行注释：有的客户端要收到第一个字节才认为连接建立
      write(res, ': connected\n\n')
      startHeartbeat()
      // 手机切后台、断网、关页面都是从这里回来的；不退订的话 clients 只增不减
      res.on('close', () => detach(res))
      return () => detach(res)
    },

    push(e: MobileEvent): void {
      const chunk = `data: ${JSON.stringify(e)}\n\n`
      for (const res of [...clients]) {
        if (!write(res, chunk)) detach(res)
      }
    },

    get count(): number {
      return clients.size
    },
  }
}
