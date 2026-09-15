import type { ApiType } from '@shared/config'
import type { MultiCharacterMode } from '@shared/llm'
import type { StyleMode } from '@shared/workspace'

/** 指令区与溯源信息「LLM 请求」共用的文案 */

export const API_LABELS: Record<ApiType, string> = { claude: 'Claude', openai: 'OpenAI 兼容' }

export const MULTI_LABELS: Record<MultiCharacterMode, string> = {
  off: '关闭',
  auto: '位置由模型安排',
  coords: '手动指定坐标',
}

export const STYLE_MODE_LABELS: Record<StyleMode, string> = {
  none: '不覆盖',
  preset: '用预设画风覆盖',
  current: '用当前 artist 块覆盖',
}
