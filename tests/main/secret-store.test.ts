import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SecretStore, type SecretCrypto } from '../../src/main/secret-store'

/** 假加密：可逆、明文不直接出现在密文里，解不开时抛错（模拟换机器后 DPAPI 解密失败） */
const fakeCrypto: SecretCrypto = {
  encrypt: (plain) => `enc:${Buffer.from(plain, 'utf-8').toString('base64')}`,
  decrypt: (cipher) => {
    if (!cipher.startsWith('enc:')) throw new Error('解不开')
    return Buffer.from(cipher.slice(4), 'base64').toString('utf-8')
  },
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secrets-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('SecretStore', () => {
  it('没存过时读出空串', () => {
    expect(new SecretStore(dir, fakeCrypto).read('llmApiKey')).toBe('')
  })

  it('写入后读回明文，磁盘上不出现明文', () => {
    const store = new SecretStore(dir, fakeCrypto)
    store.write('llmApiKey', 'sk-ant-秘密')
    expect(store.read('llmApiKey')).toBe('sk-ant-秘密')
    expect(readFileSync(join(dir, 'secrets.json'), 'utf-8')).not.toContain('sk-ant-秘密')
  })

  it('解不开（换机器、换用户）当作未设置，而不是抛错', () => {
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ llmApiKey: 'garbage' }))
    expect(new SecretStore(dir, fakeCrypto).read('llmApiKey')).toBe('')
  })

  it('写空串清除这把钥匙', () => {
    const store = new SecretStore(dir, fakeCrypto)
    store.write('llmApiKey', 'k')
    store.write('llmApiKey', '')
    expect(store.read('llmApiKey')).toBe('')
    expect(JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf-8'))).toEqual({})
  })

  it('secrets.json 形状不对时当作全部未设置', () => {
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify(['llmApiKey']))
    expect(new SecretStore(dir, fakeCrypto).read('llmApiKey')).toBe('')
  })

  it('两把钥匙各管各的：LLM Key 与 NovelAI Token 互不影响', () => {
    const store = new SecretStore(dir, fakeCrypto)
    store.write('llmApiKey', 'a')
    store.write('naiToken', 'b')
    expect(store.read('llmApiKey')).toBe('a')
    expect(store.read('naiToken')).toBe('b')

    store.write('naiToken', '')
    expect(store.read('naiToken')).toBe('')
    expect(store.read('llmApiKey')).toBe('a')
  })
})
