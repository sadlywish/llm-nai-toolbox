import { NUMBER_RULES, type AppConfig, type NumericKey } from '@shared/config'

/** 数值项在输入框里的原文。单独存一份：半截输入（如「1e」）不能写回草稿，但得原样留在框里 */
export type NumericText = Record<NumericKey, string>

export function numericTextFrom(cfg: AppConfig): NumericText {
  const out = {} as NumericText
  for (const key of Object.keys(NUMBER_RULES) as NumericKey[]) out[key] = String(cfg[key])
  return out
}

/** 设置页上还没保存的一切：草稿、数值原文、三把钥匙的输入框 */
export interface SettingsDraft {
  draft: AppConfig
  numericText: NumericText
  /** 三个密钥输入框里的文本；留空表示不改动已存的那把 */
  secrets: readonly string[]
}

/**
 * 设置页有没有未保存的修改（保存栏的提示、「撤销修改」可不可点、顶栏标签上的黄点都看它）。
 *
 * 数值项比原文而不是比草稿：输入框里是「1e」时草稿还攥着上一个合法值，
 * 只比草稿会把这种半截输入当成没改过。
 */
export function isSettingsDirty({ draft, numericText, secrets }: SettingsDraft, saved: AppConfig): boolean {
  for (const key of Object.keys(saved) as (keyof AppConfig)[]) {
    if (draft[key] !== saved[key]) return true
  }
  for (const key of Object.keys(NUMBER_RULES) as NumericKey[]) {
    if (numericText[key] !== String(saved[key])) return true
  }
  return secrets.some((s) => s !== '')
}

/** 单行值的文本框（质量词、负面词、画面文字）：换行一律换成空格，值始终是一行 */
export function flattenLineBreaks(text: string): string {
  return text.replace(/\r\n|\r|\n/g, ' ')
}
