// 手机端配对与设备令牌。不 import electron：HTTP 服务与设备表要能在 node 环境下单独跑测试，
// 也让 Task 4 能把它当一个纯粹的存储层注入进去。
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto'
import { newId } from '../../shared/ids'
import { JsonStore } from '../store'

export interface PairedDevice {
  id: string
  name: string
  pairedAt: string
  lastSeenAt: string
}

export interface DeviceStore {
  /** 生成一次性配对码（4 位数字），5 分钟内有效，用一次即废 */
  newPairingCode(): { code: string; expiresAt: number }
  currentCode(): { code: string; expiresAt: number } | null
  /** 配对码换令牌；码不对或过期返回 null */
  pair(code: string, deviceName: string): { token: string; device: PairedDevice } | null
  /** 校验令牌，命中时刷新 lastSeenAt */
  verify(token: string | null): PairedDevice | null
  list(): PairedDevice[]
  revoke(id: string): void
  revokeAll(): void
}

/** 落盘里的一条设备记录：只存令牌的哈希，明文令牌永远不落盘 */
interface DeviceRecord {
  id: string
  name: string
  pairedAt: string
  lastSeenAt: string
  tokenHash: string
}

interface DevicesFile {
  version: 1
  devices: DeviceRecord[]
}

function isDeviceRecord(v: unknown): v is DeviceRecord {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    typeof r.pairedAt === 'string' &&
    typeof r.lastSeenAt === 'string' &&
    typeof r.tokenHash === 'string'
  )
}

function isDevicesFile(v: unknown): v is DevicesFile {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return r.version === 1 && Array.isArray(r.devices) && r.devices.every(isDeviceRecord)
}

const PAIRING_TTL_MS = 5 * 60_000

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf-8').digest('hex')
}

function toPaired(d: DeviceRecord): PairedDevice {
  return { id: d.id, name: d.name, pairedAt: d.pairedAt, lastSeenAt: d.lastSeenAt }
}

export interface DeviceStoreDeps {
  now?: () => number
  randomToken?: () => string
  randomCode?: () => string
}

/**
 * 配对码只在内存里存一份（不落盘）：它是给「配对」这个一次性动作用的临时凭证，
 * 应用重启后失效是应有之义，没必要为它单独维护一份可能与设备表不一致的持久状态。
 */
class DeviceStoreImpl implements DeviceStore {
  private readonly store: JsonStore<DevicesFile>
  private readonly now: () => number
  private readonly randomToken: () => string
  private readonly randomCode: () => string
  private pairing: { code: string; expiresAt: number } | null = null

  constructor(filePath: string, deps: DeviceStoreDeps) {
    this.store = new JsonStore<DevicesFile>(filePath, () => ({ version: 1, devices: [] }), isDevicesFile)
    this.now = deps.now ?? Date.now
    this.randomToken = deps.randomToken ?? (() => randomBytes(32).toString('hex'))
    // 4 位数字，允许前导 0：人眼在手机上输入，位数比熵值重要
    this.randomCode = deps.randomCode ?? (() => String(randomInt(0, 10_000)).padStart(4, '0'))
  }

  newPairingCode(): { code: string; expiresAt: number } {
    // 直接覆盖，不判断旧码是否还有效——这就是「作废上一个码」
    this.pairing = { code: this.randomCode(), expiresAt: this.now() + PAIRING_TTL_MS }
    return { ...this.pairing }
  }

  currentCode(): { code: string; expiresAt: number } | null {
    if (this.pairing === null || this.now() >= this.pairing.expiresAt) return null
    return { ...this.pairing }
  }

  pair(code: string, deviceName: string): { token: string; device: PairedDevice } | null {
    const p = this.pairing
    if (p === null || this.now() >= p.expiresAt || code !== p.code) return null
    // 码错了允许重试，不作废；只有真正配对成功才消耗掉这个一次性码
    this.pairing = null

    const token = this.randomToken()
    const nowIso = new Date(this.now()).toISOString()
    const record: DeviceRecord = {
      id: newId('dev'),
      name: deviceName,
      pairedAt: nowIso,
      lastSeenAt: nowIso,
      tokenHash: hashToken(token),
    }
    const file = this.store.read()
    file.devices.push(record)
    this.store.write(file)
    return { token, device: toPaired(record) }
  }

  verify(token: string | null): PairedDevice | null {
    if (token === null || token === '') return null
    // 用哈希缓冲区做 timingSafeEqual，而不是直接比较令牌字符串或哈希十六进制串，
    // 避免字符串 === 在第一个不相等字符处提前退出，把耗时差异泄露给攻击者
    const target = Buffer.from(hashToken(token), 'hex')
    const file = this.store.read()
    const match = file.devices.find((d) => {
      const candidate = Buffer.from(d.tokenHash, 'hex')
      return candidate.length === target.length && timingSafeEqual(candidate, target)
    })
    if (match === undefined) return null

    match.lastSeenAt = new Date(this.now()).toISOString()
    this.store.write(file)
    return toPaired(match)
  }

  list(): PairedDevice[] {
    return this.store.read().devices.map(toPaired)
  }

  revoke(id: string): void {
    const file = this.store.read()
    const devices = file.devices.filter((d) => d.id !== id)
    if (devices.length === file.devices.length) return // 没这个设备，不必写盘
    this.store.write({ version: 1, devices })
  }

  revokeAll(): void {
    this.store.write({ version: 1, devices: [] })
  }
}

export function createDeviceStore(filePath: string, deps: DeviceStoreDeps = {}): DeviceStore {
  return new DeviceStoreImpl(filePath, deps)
}
