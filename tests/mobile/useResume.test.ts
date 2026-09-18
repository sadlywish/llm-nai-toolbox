import { describe, expect, it } from 'vitest'
import { RECONNECT_AFTER_HIDDEN_MS, shouldReconnect } from '../../src/mobile/src/useResume'

/**
 * 回前台要不要换一条 SSE 连接。判紧了（从不重连）就会出现「状态点是绿的、事件却再也不来」，
 * 判松了（每次切回来都重连）则是白扔一次握手——所以这条线要有测试钉住。
 */
describe('shouldReconnect', () => {
  it('离开久了就重建连接：后台冻过之后连接常常是半死的', () => {
    expect(shouldReconnect(RECONNECT_AFTER_HIDDEN_MS)).toBe(true)
    expect(shouldReconnect(RECONNECT_AFTER_HIDDEN_MS + 60_000)).toBe(true)
  })

  it('只切走一下（看一眼通知）不折腾连接', () => {
    expect(shouldReconnect(0)).toBe(false)
    expect(shouldReconnect(RECONNECT_AFTER_HIDDEN_MS - 1)).toBe(false)
  })
})
