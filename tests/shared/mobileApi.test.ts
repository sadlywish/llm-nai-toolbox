import { describe, expect, it } from 'vitest'
import { apiError, isPrivateAddress, MOBILE_API_VERSION } from '@shared/mobileApi'

describe('isPrivateAddress', () => {
  it('环回与私有网段放行', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.0.0.5', '192.168.1.8', '172.16.0.1', '172.31.255.254'])
      expect(isPrivateAddress(a)).toBe(true)
  })
  it('公网地址与缺失一律挡掉', () => {
    for (const a of ['8.8.8.8', '172.32.0.1', '203.0.113.9', '', undefined]) expect(isPrivateAddress(a)).toBe(false)
  })
})

describe('apiError', () => {
  it('形状固定为 { error: { kind, message } }', () => {
    expect(apiError('busy', '电脑正在出图')).toEqual({ error: { kind: 'busy', message: '电脑正在出图' } })
    expect(MOBILE_API_VERSION).toBe(1)
  })
})
