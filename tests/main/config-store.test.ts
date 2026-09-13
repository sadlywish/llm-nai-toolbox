import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../../src/main/config-store'
import { defaultAppConfig, type AppConfig } from '../../src/shared/config'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'config-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('ConfigStore', () => {
  it('config.json 不存在：exists 为 false，读出默认配置，读取不写盘', () => {
    const store = new ConfigStore(dir)
    expect(store.exists()).toBe(false)
    expect(store.read()).toEqual(defaultAppConfig())
    expect(store.exists()).toBe(false)
  })

  it('写入后读回一致，exists 为 true', () => {
    const store = new ConfigStore(dir)
    const cfg: AppConfig = { ...defaultAppConfig(), model: 'claude-opus-5', maxToolRounds: 6 }
    store.write(cfg)
    expect(store.exists()).toBe(true)
    expect(store.read()).toEqual(cfg)
  })

  it('默认文案不回退：保存的空串读回来还是空串', () => {
    const store = new ConfigStore(dir)
    store.write({ ...defaultAppConfig(), systemPrompt: '', quality: '' })
    expect(store.read().systemPrompt).toBe('')
    expect(store.read().quality).toBe('')
  })

  it('写入前先过 mergeConfig：坏值不会落盘', () => {
    const store = new ConfigStore(dir)
    store.write({ ...defaultAppConfig(), requestTimeoutSec: -1 })
    const onDisk = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8')) as AppConfig
    expect(onDisk.requestTimeoutSec).toBe(120)
  })
})
