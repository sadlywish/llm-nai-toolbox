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
 * 换行统一成 LF：Windows 上 git 的 autocrlf 会把检出的文件改成 CRLF，
 * 不统一的话 \r 会跟着进配置、进发给 LLM 的请求。
 * 多行文案只去掉结尾空白（编辑器保存时常带一个换行；开头的缩进是文案本身）；
 * 单行的质量词、负面词两头都去掉。
 */
const toLf = (s: string): string => s.replace(/\r\n?/g, '\n')

export const multiLineText = (raw: string): string => toLf(raw).replace(/\s+$/, '')

export const singleLineText = (raw: string): string => toLf(raw).trim()

export const DEFAULT_TEXTS = {
  systemPrompt: multiLineText(systemMd),
  naiCharSystemPrompt: multiLineText(characterMd),
  tailInjection: multiLineText(tailMd),
  quality: singleLineText(qualityTxt),
  negativePrompt: singleLineText(negativeTxt),
} as const
