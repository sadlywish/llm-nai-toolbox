import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDeviceStore } from '../../../src/main/server/devices'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'devices-'))
  file = join(dir, 'devices.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('newPairingCode / currentCode', () => {
  it('生成 4 位数字配对码，带 5 分钟后的过期时间', () => {
    let t = 1_000_000
    const store = createDeviceStore(file, { now: () => t })
    const { code, expiresAt } = store.newPairingCode()
    expect(code).toMatch(/^\d{4}$/)
    expect(expiresAt).toBe(t + 5 * 60_000)
    expect(store.currentCode()).toEqual({ code, expiresAt })
  })

  it('再次调用会作废上一个码', () => {
    const store = createDeviceStore(file, { randomCode: (() => {
      let n = 0
      return () => String(1111 * ++n)
    })() })
    const first = store.newPairingCode()
    const second = store.newPairingCode()
    expect(second.code).not.toBe(first.code)
    expect(store.pair(first.code, 'x')).toBeNull()
    expect(store.pair(second.code, 'x')).not.toBeNull()
  })

  it('过期后 currentCode 返回 null', () => {
    let t = 1_000_000
    const store = createDeviceStore(file, { now: () => t })
    store.newPairingCode()
    t += 5 * 60_000 + 1
    expect(store.currentCode()).toBeNull()
  })

  it('没生成过配对码时 currentCode 返回 null', () => {
    expect(createDeviceStore(file).currentCode()).toBeNull()
  })
})

describe('pair', () => {
  it('配对码只能用一次，用过就失效', () => {
    const store = createDeviceStore(file)
    const { code } = store.newPairingCode()
    expect(store.pair(code, '小米 14')).not.toBeNull()
    expect(store.pair(code, '小米 14')).toBeNull()
  })

  it('配对码 5 分钟后过期', () => {
    let t = 1_000_000
    const store = createDeviceStore(file, { now: () => t })
    const { code } = store.newPairingCode()
    t += 5 * 60_000 + 1
    expect(store.pair(code, 'x')).toBeNull()
  })

  it('码不对时返回 null，且不消耗掉真正有效的码（允许重试）', () => {
    const store = createDeviceStore(file)
    const { code } = store.newPairingCode()
    const wrong = code === '0000' ? '1111' : '0000'
    expect(store.pair(wrong, 'x')).toBeNull()
    expect(store.pair(code, 'x')).not.toBeNull()
  })

  it('没生成过配对码时 pair 直接返回 null', () => {
    expect(createDeviceStore(file).pair('1234', 'x')).toBeNull()
  })

  it('成功配对后设备立即出现在 list 里，字段齐全但不含令牌', () => {
    let t = 1_000_000
    const store = createDeviceStore(file, { now: () => t })
    const { code } = store.newPairingCode()
    const result = store.pair(code, '小米 14')!
    expect(result.device.name).toBe('小米 14')
    expect(result.device.pairedAt).toBe(new Date(t).toISOString())
    expect(result.device.lastSeenAt).toBe(result.device.pairedAt)
    expect(result.device).not.toHaveProperty('tokenHash')
    expect(store.list()).toEqual([result.device])
  })
})

describe('verify / revoke', () => {
  it('令牌可校验；吊销后立刻失效；错误令牌不通过', () => {
    // 固定 now：verify 命中会刷新 lastSeenAt，用真实时钟会让这里的 toEqual 因为
    // 毫秒级时间差而假失败——这条断言要测的是「字段原样对得上」，不是时间流逝
    const store = createDeviceStore(file, { now: () => 1_000_000 })
    const { code } = store.newPairingCode()
    const { token, device } = store.pair(code, '小米 14')!

    expect(store.verify(token)).toEqual(device)
    expect(store.verify('不是这个令牌')).toBeNull()
    expect(store.verify(null)).toBeNull()

    store.revoke(device.id)
    expect(store.verify(token)).toBeNull()
    expect(store.list()).toEqual([])
  })

  it('verify 命中时刷新 lastSeenAt', () => {
    let t = 1_000_000
    const store = createDeviceStore(file, { now: () => t })
    const { code } = store.newPairingCode()
    const { token, device } = store.pair(code, 'x')!
    t += 60_000
    const seen = store.verify(token)!
    expect(seen.lastSeenAt).toBe(new Date(t).toISOString())
    expect(seen.lastSeenAt).not.toBe(device.lastSeenAt)
    // 落盘也要跟着更新，不能只是内存里改了返回值
    expect(store.list()[0].lastSeenAt).toBe(seen.lastSeenAt)
  })

  it('revoke 不存在的 id 时安静忽略，不抛错', () => {
    const store = createDeviceStore(file)
    expect(() => store.revoke('没有这个设备')).not.toThrow()
  })

  it('revokeAll 清空所有设备', () => {
    const store = createDeviceStore(file)
    store.pair(store.newPairingCode().code, 'a')
    store.pair(store.newPairingCode().code, 'b')
    expect(store.list()).toHaveLength(2)
    store.revokeAll()
    expect(store.list()).toEqual([])
  })

  it('多台设备各自独立：吊销一台不影响另一台', () => {
    const store = createDeviceStore(file, { now: () => 1_000_000 })
    const a = store.pair(store.newPairingCode().code, 'a')!
    const b = store.pair(store.newPairingCode().code, 'b')!
    store.revoke(a.device.id)
    expect(store.verify(a.token)).toBeNull()
    expect(store.verify(b.token)).toEqual(b.device)
  })
})

describe('落盘形状与容错', () => {
  it('落盘里只有哈希，没有明文令牌', () => {
    const store = createDeviceStore(file)
    const { code } = store.newPairingCode()
    const { token } = store.pair(code, 'x')!
    expect(readFileSync(file, 'utf8')).not.toContain(token)
  })

  it('devices.json 的形状是 version 1 + devices 数组', () => {
    const store = createDeviceStore(file)
    store.pair(store.newPairingCode().code, 'x')
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed.version).toBe(1)
    expect(parsed.devices).toHaveLength(1)
    expect(typeof parsed.devices[0].tokenHash).toBe('string')
    expect(parsed.devices[0].tokenHash).toHaveLength(64) // sha256 十六进制
  })

  it('文件不存在时当作没有任何设备，不抛错', () => {
    expect(createDeviceStore(file).list()).toEqual([])
  })

  it('文件损坏时当作没有任何设备，不抛错', () => {
    writeFileSync(file, '{{{')
    expect(createDeviceStore(file).list()).toEqual([])
  })

  it('文件形状不对（devices 不是数组）时当作没有任何设备', () => {
    writeFileSync(file, JSON.stringify({ version: 1, devices: 'nope' }))
    expect(createDeviceStore(file).list()).toEqual([])
  })

  it('令牌用 randomToken 依赖注入时确定性可测', () => {
    const store = createDeviceStore(file, { randomToken: () => 'fixed-token' })
    const { token } = store.pair(store.newPairingCode().code, 'x')!
    expect(token).toBe('fixed-token')
  })
})
