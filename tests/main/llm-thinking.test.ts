import { describe, expect, it } from 'vitest'
import { defaultAppConfig, type AppConfig } from '../../src/shared/config'
import type { LlmLogLine } from '../../src/shared/llm'
import { RunLog } from '../../src/main/llm/log'
import { claudeThinkingParams, openaiReasoningParams } from '../../src/main/llm/thinking'

function run(fn: (c: AppConfig, l: RunLog) => unknown, over: Partial<AppConfig>) {
  const lines: LlmLogLine[] = []
  const out = fn({ ...defaultAppConfig(), thinkingEnabled: true, ...over }, new RunLog((l) => lines.push(l)))
  return { out, lines }
}

describe('claudeThinkingParams', () => {
  it('关闭时什么都不发', () => {
    expect(run(claudeThinkingParams, { thinkingEnabled: false }).out).toEqual({})
  })

  it('adaptive：thinking.type=adaptive + output_config.effort', () => {
    expect(run(claudeThinkingParams, { thinkingFormat: 'adaptive', thinkingEffort: 'xhigh' }).out).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'xhigh' },
    })
  })

  it('budget：超过 maxTokens-1 收敛并告警', () => {
    const { out, lines } = run(claudeThinkingParams, { thinkingFormat: 'budget', maxTokens: 16000, thinkingBudgetTokens: 20000 })
    expect(out).toEqual({ thinking: { type: 'enabled', budget_tokens: 15999 } })
    expect(lines.some((l) => l.level === 'W' && l.text.includes('已收敛为 15999'))).toBe(true)
  })

  it('budget：小于 1024 抬到 1024 并告警', () => {
    const { out, lines } = run(claudeThinkingParams, { thinkingFormat: 'budget', maxTokens: 16000, thinkingBudgetTokens: 500 })
    expect(out).toEqual({ thinking: { type: 'enabled', budget_tokens: 1024 } })
    expect(lines.some((l) => l.level === 'W' && l.text.includes('已收敛为 1024'))).toBe(true)
  })

  it('budget：maxTokens 容纳不下 1024 时跳过并告警', () => {
    const { out, lines } = run(claudeThinkingParams, { thinkingFormat: 'budget', maxTokens: 1000, thinkingBudgetTokens: 5000 })
    expect(out).toEqual({})
    expect(lines.some((l) => l.level === 'W' && l.text.includes('跳过'))).toBe(true)
  })
})

describe('openaiReasoningParams', () => {
  it('关闭时什么都不发', () => {
    expect(run(openaiReasoningParams, { thinkingEnabled: false, openaiReasoningDialect: 'thinking_object' }).out).toEqual({})
  })

  it('reasoning_effort 写法：力度原样发，不降档', () => {
    expect(run(openaiReasoningParams, { openaiReasoningEffort: 'max' }).out).toEqual({ reasoning_effort: 'max' })
    expect(run(openaiReasoningParams, { openaiReasoningEffort: 'none' }).out).toEqual({ reasoning_effort: 'none' })
  })

  it('reasoning 对象（OpenRouter）：预算为 0 时发 effort，大于 0 时只发 max_tokens', () => {
    expect(run(openaiReasoningParams, { openaiReasoningDialect: 'reasoning_object', openaiReasoningEffort: 'low' }).out).toEqual({
      reasoning: { effort: 'low' },
    })
    expect(
      run(openaiReasoningParams, { openaiReasoningDialect: 'reasoning_object', openaiReasoningEffort: 'low', openaiReasoningBudget: 4096 }).out,
    ).toEqual({ reasoning: { max_tokens: 4096 } })
  })

  it('thinking 对象（DeepSeek / 智谱 / Kimi）：只发 type=enabled，不带力度', () => {
    expect(run(openaiReasoningParams, { openaiReasoningDialect: 'thinking_object', openaiReasoningEffort: 'max' }).out).toEqual({
      thinking: { type: 'enabled' },
    })
  })

  it('enable_thinking（通义千问）：预算大于 0 时带 thinking_budget', () => {
    expect(run(openaiReasoningParams, { openaiReasoningDialect: 'enable_thinking' }).out).toEqual({ enable_thinking: true })
    expect(run(openaiReasoningParams, { openaiReasoningDialect: 'enable_thinking', openaiReasoningBudget: 2048 }).out).toEqual({
      enable_thinking: true,
      thinking_budget: 2048,
    })
  })

  it('每次发送写一行日志', () => {
    const { lines } = run(openaiReasoningParams, { openaiReasoningEffort: 'xhigh' })
    expect(lines.map((l) => l.text)).toEqual(['[thinking] reasoning_effort=xhigh'])
  })
})
