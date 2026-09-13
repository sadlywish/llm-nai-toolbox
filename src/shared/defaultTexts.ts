import characterMd from '../../resources/prompts/character.md?raw'
import negativeTxt from '../../resources/prompts/negative.txt?raw'
import qualityTxt from '../../resources/prompts/quality.txt?raw'
import systemMd from '../../resources/prompts/system.md?raw'
import tailMd from '../../resources/prompts/tail.md?raw'

/**
 * 随包默认文案（规格 §14.1）。
 *
 * 一份文案一个文件，构建期用 vite 的 `?raw` 导入成字符串常量：这些文案动辄
 * 上万字，塞进 TS 字符串字面量里没法读、没法 diff。
 *
 * ⚠️ 只在「config.json 不存在」时经 defaultAppConfig() 进入配置，
 * 以及设置抽屉的「恢复默认」。任何取值处都不许拿它当空白回退。
 *
 * 多行文案只去掉结尾空白（编辑器保存时常带一个换行）；单行的质量词、
 * 负面词两头都去掉。
 */
const trimEnd = (s: string): string => s.replace(/\s+$/, '')

export const DEFAULT_TEXTS = {
  systemPrompt: trimEnd(systemMd),
  naiCharSystemPrompt: trimEnd(characterMd),
  tailInjection: trimEnd(tailMd),
  quality: qualityTxt.trim(),
  negativePrompt: negativeTxt.trim(),
} as const
