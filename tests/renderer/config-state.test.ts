import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAppConfig } from '../../src/shared/config'

type Mod = typeof import('../../src/renderer/src/state/config')

let mod: Mod
let api: {
  loadConfig: ReturnType<typeof vi.fn>
  saveConfig: ReturnType<typeof vi.fn>
}

beforeEach(async () => {
  vi.resetModules()
  api = {
    loadConfig: vi.fn().mockResolvedValue({
      config: { ...defaultAppConfig(), model: 'claude-opus-5' },
      hasLlmApiKey: true,
      hasNaiToken: false,
      configExists: false,
    }),
    saveConfig: vi.fn().mockResolvedValue(undefined),
  }
  ;(globalThis as Record<string, unknown>).window = { api }
  mod = await import('../../src/renderer/src/state/config')
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
})

describe('useConfig', () => {
  it('载入前 configExists 当作 true —— 否则设置抽屉会在 load 返回前抢先弹一下', () => {
    expect(mod.useConfig.getState().configExists).toBe(true)
    expect(mod.useConfig.getState().loaded).toBe(false)
  })

  it('load 成功：配置、是否有 Key、config.json 在不在都更新', async () => {
    await mod.useConfig.getState().load()
    const s = mod.useConfig.getState()
    expect(s.loaded).toBe(true)
    expect(s.config.model).toBe('claude-opus-5')
    expect(s.hasLlmApiKey).toBe(true)
    expect(s.hasNaiToken).toBe(false)
    expect(s.configExists).toBe(false)
  })

  it('load 失败：loadError 写明原因，loaded 保持 false', async () => {
    api.loadConfig.mockRejectedValueOnce(new Error('读不了'))
    await mod.useConfig.getState().load()
    expect(mod.useConfig.getState().loadError).toContain('读不了')
    expect(mod.useConfig.getState().loaded).toBe(false)
  })

  it('save 把 Key 原样传给主进程，undefined 不转成空串', async () => {
    const cfg = defaultAppConfig()
    await mod.useConfig.getState().save(cfg)
    expect(api.saveConfig).toHaveBeenLastCalledWith({ config: cfg, llmApiKey: undefined, naiToken: undefined })
    await mod.useConfig.getState().save(cfg, 'sk-x')
    expect(api.saveConfig).toHaveBeenLastCalledWith({ config: cfg, llmApiKey: 'sk-x', naiToken: undefined })
    await mod.useConfig.getState().save(cfg, undefined, 'pst-x')
    expect(api.saveConfig).toHaveBeenLastCalledWith({ config: cfg, llmApiKey: undefined, naiToken: 'pst-x' })
  })

  it('save：NovelAI Token 与 LLM Key 各管各的 has 标记', async () => {
    await mod.useConfig.getState().load()
    const cfg = defaultAppConfig()
    await mod.useConfig.getState().save(cfg, undefined, 'pst-x')
    expect(mod.useConfig.getState().hasNaiToken).toBe(true)
    expect(mod.useConfig.getState().hasLlmApiKey).toBe(true)
    await mod.useConfig.getState().save(cfg, '', undefined)
    expect(mod.useConfig.getState().hasNaiToken).toBe(true)
    expect(mod.useConfig.getState().hasLlmApiKey).toBe(false)
    await mod.useConfig.getState().save(cfg, undefined, '')
    expect(mod.useConfig.getState().hasNaiToken).toBe(false)
  })

  it('save 成功：configExists 变 true；Key 不传不改 hasLlmApiKey，传非空变 true，传空串变 false', async () => {
    // 先 load：mock 的 hasLlmApiKey 是 true。初值本来就是 false，用它做
    // 「不传 Key」的起点区分不出「保留原值」与「一律置 false」——两者结果相同。
    await mod.useConfig.getState().load()
    const cfg = { ...defaultAppConfig(), maxToolRounds: 3 }

    await mod.useConfig.getState().save(cfg)
    expect(mod.useConfig.getState().configExists).toBe(true)
    expect(mod.useConfig.getState().config.maxToolRounds).toBe(3)
    expect(mod.useConfig.getState().hasLlmApiKey).toBe(true)

    await mod.useConfig.getState().save(cfg, '')
    expect(mod.useConfig.getState().hasLlmApiKey).toBe(false)

    // 再次不传 Key：应保持上一步置为的 false，而不是回弹
    await mod.useConfig.getState().save(cfg)
    expect(mod.useConfig.getState().hasLlmApiKey).toBe(false)

    await mod.useConfig.getState().save(cfg, 'k')
    expect(mod.useConfig.getState().hasLlmApiKey).toBe(true)
  })

  it('save 失败：saveError 写明原因，配置不变', async () => {
    api.saveConfig.mockRejectedValueOnce(new Error('磁盘满'))
    await mod.useConfig.getState().save({ ...defaultAppConfig(), maxToolRounds: 3 })
    expect(mod.useConfig.getState().saveError).toContain('磁盘满')
    expect(mod.useConfig.getState().config.maxToolRounds).toBe(10)
    mod.useConfig.getState().dismissSaveError()
    expect(mod.useConfig.getState().saveError).toBeNull()
  })
})
