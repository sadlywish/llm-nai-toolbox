import { create } from 'zustand'
import { defaultAppConfig, type AppConfig } from '@shared/config'

interface ConfigState {
  config: AppConfig
  /** 是否存过 LLM API Key。设置抽屉不回显明文，只显示「已保存 / 必填」 */
  hasLlmApiKey: boolean
  /** 是否存过 NovelAI Token，同 hasLlmApiKey */
  hasNaiToken: boolean
  loaded: boolean
  /**
   * config.json 在不在。false = 用户从没保存过设置，启动时要自动弹设置抽屉。
   *
   * 与「配置等于默认值」不是一回事：用户完全可能保存了一份与默认值相同的配置，
   * 那种情况不该再打扰他。只有文件本身不在才算没配过。
   */
  configExists: boolean
  loadError: string | null
  saveError: string | null
  load: () => Promise<void>
  /** 两把钥匙传 undefined 都表示不改动已存的那把 */
  save: (config: AppConfig, llmApiKey?: string, naiToken?: string) => Promise<void>
  dismissSaveError: () => void
}

export const useConfig = create<ConfigState>((set) => ({
  config: defaultAppConfig(),
  hasLlmApiKey: false,
  hasNaiToken: false,
  loaded: false,
  // 载入完成前先当作「已存在」：默认 false 会让抽屉在 load() 返回之前
  // 抢先弹出来一下，配置文件其实好好在那儿
  configExists: true,
  loadError: null,
  saveError: null,

  load: async () => {
    // 必须接住：打包后没有 devtools，未处理的 rejection 用户看不见，
    // 界面只会永远停在「载入配置中」
    try {
      const { config, hasLlmApiKey, hasNaiToken, configExists } = await window.api.loadConfig()
      set({ config, hasLlmApiKey, hasNaiToken, configExists, loaded: true, loadError: null })
    } catch (err) {
      set({ loadError: `配置载入失败：${String(err)}` })
    }
  },

  save: async (config, llmApiKey, naiToken) => {
    try {
      await window.api.saveConfig({ config, llmApiKey, naiToken })
      set((s) => ({
        config,
        // 保存成功即意味着 config.json 已落盘，下次启动不再自动弹设置
        configExists: true,
        hasLlmApiKey: llmApiKey === undefined ? s.hasLlmApiKey : llmApiKey !== '',
        hasNaiToken: naiToken === undefined ? s.hasNaiToken : naiToken !== '',
        saveError: null,
      }))
    } catch (err) {
      set({ saveError: `保存失败：${String(err)}` })
    }
  },

  dismissSaveError: () => set({ saveError: null }),
}))
