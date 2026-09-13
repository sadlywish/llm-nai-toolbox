import type { AppConfig } from '@shared/config'
import type { RunLog } from './log'
import type { JsonObject } from './types'

/**
 * 思维链参数（规格 §9.3）。
 *
 * **关闭时不发送任何参数，而不是发 disabled**：Opus 5 等模型默认自带 adaptive thinking，
 * 显式 disabled 会让它偶尔把工具调用写进正文，表现为「未调用工具」（插件 docs/decisions.md）。
 */

/**
 * budget 格式的预算：必须 ≥1024 且 < maxTokens，超出自动收敛并告警。
 * maxTokens 本身容纳不下 1024 时返回 null，本次跳过思维链。
 */
export function thinkingBudget(config: AppConfig, log: RunLog): number | null {
  const cap = config.maxTokens - 1
  let budget = config.thinkingBudgetTokens
  if (budget < 1024 && cap >= 1024) {
    log.warn(`[thinking] budget_tokens(${budget}) 小于最小值 1024，已收敛为 1024`)
    budget = 1024
  }
  if (budget > cap) {
    log.warn(`[thinking] budget_tokens(${budget}) 必须小于 max_tokens(${config.maxTokens})，已收敛为 ${cap}`)
    budget = cap
  }
  if (budget < 1024) {
    log.warn(`[thinking] budget_tokens 最小 1024，当前 max_tokens=${config.maxTokens} 容纳不下，本次跳过 thinking`)
    return null
  }
  return budget
}

/** Claude：adaptive → thinking.type=adaptive + output_config.effort；budget → thinking.type=enabled + budget_tokens */
export function claudeThinkingParams(config: AppConfig, log: RunLog): JsonObject {
  if (!config.thinkingEnabled) return {}
  if (config.thinkingFormat === 'budget') {
    const budget = thinkingBudget(config, log)
    if (budget === null) return {}
    log.info(`[thinking] budget 模式：budget_tokens=${budget}`)
    return { thinking: { type: 'enabled', budget_tokens: budget } }
  }
  log.info(`[thinking] adaptive 模式：effort=${config.thinkingEffort}`)
  return { thinking: { type: 'adaptive' }, output_config: { effort: config.thinkingEffort } }
}

/**
 * OpenAI 兼容：按设置里的「参数写法」生成（各家写法见 shared/config.ts 的 OpenAIReasoningDialect）。
 * 力度原样发送，不在这里降档——各家各模型支持的档位不同，由端点决定收不收；
 * 端点不认时由 openai.ts 去掉参数重发并告警。
 */
export function openaiReasoningParams(config: AppConfig, log: RunLog): JsonObject {
  if (!config.thinkingEnabled) return {}
  const effort = config.openaiReasoningEffort
  const budget = config.openaiReasoningBudget
  switch (config.openaiReasoningDialect) {
    case 'reasoning_effort':
      log.info(`[thinking] reasoning_effort=${effort}`)
      return { reasoning_effort: effort }
    case 'reasoning_object':
      // OpenRouter 的 effort 与 max_tokens 二选一
      if (budget > 0) {
        log.info(`[thinking] reasoning.max_tokens=${budget}`)
        return { reasoning: { max_tokens: budget } }
      }
      log.info(`[thinking] reasoning.effort=${effort}`)
      return { reasoning: { effort } }
    case 'thinking_object':
      // 智谱、Kimi 不认力度字段；DeepSeek 要调力度时由附加请求参数整体覆盖 thinking
      log.info('[thinking] thinking.type=enabled')
      return { thinking: { type: 'enabled' } }
    case 'enable_thinking':
      log.info(`[thinking] enable_thinking=true${budget > 0 ? `, thinking_budget=${budget}` : ''}`)
      return budget > 0 ? { enable_thinking: true, thinking_budget: budget } : { enable_thinking: true }
  }
}
