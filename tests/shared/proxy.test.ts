import { describe, expect, it } from 'vitest'
import { parseProxyRules } from '@shared/proxy'

function ok(raw: string): string {
  const r = parseProxyRules(raw)
  if (!r.ok) throw new Error(`期望合法，实际报错：${r.message}`)
  return r.rules
}

function bad(raw: string): string {
  const r = parseProxyRules(raw)
  if (r.ok) throw new Error(`期望报错，实际得到 ${r.rules}`)
  return r.message
}

describe('parseProxyRules', () => {
  it('空串表示跟随系统代理', () => {
    expect(ok('')).toBe('')
    expect(ok('   ')).toBe('')
  })

  it('不写协议时按 http 代理处理', () => {
    expect(ok('127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
  })

  it('支持的协议原样保留，协议名统一小写', () => {
    expect(ok('socks5://127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080')
    expect(ok('HTTPS://proxy.local:443')).toBe('https://proxy.local:443')
  })

  it('首尾空白去掉，中间有空格报错', () => {
    expect(ok('  127.0.0.1:7890  ')).toBe('http://127.0.0.1:7890')
    expect(bad('127.0.0.1: 7890')).toContain('空格')
  })

  it('不支持的协议报错并点名', () => {
    expect(bad('ftp://127.0.0.1:21')).toContain('ftp')
  })

  it('带用户名密码的代理明确拒绝 —— Chromium 会静默退回直连', () => {
    expect(bad('http://user:pass@127.0.0.1:7890')).toContain('用户名密码')
  })

  it('带路径报错', () => {
    expect(bad('127.0.0.1:7890/pac')).toContain('路径')
  })

  it('缺端口报错', () => {
    expect(bad('127.0.0.1')).toContain('主机:端口')
    expect(bad('127.0.0.1:')).toContain('主机:端口')
  })

  it('端口不是数字或越界报错', () => {
    expect(bad('127.0.0.1:abc')).toContain('不是数字')
    expect(bad('127.0.0.1:0')).toContain('超出')
    expect(bad('127.0.0.1:65536')).toContain('超出')
  })
})
