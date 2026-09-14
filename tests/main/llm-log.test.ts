import { describe, expect, it } from 'vitest'
import type { LlmLogLine } from '../../src/shared/llm'
import { RunLog } from '../../src/main/llm/log'

describe('RunLog', () => {
  it('时间补零成 HH:MM:SS，级别按方法名', () => {
    const lines: LlmLogLine[] = []
    const log = new RunLog((l) => lines.push(l), () => new Date(2026, 8, 13, 9, 5, 7))
    log.info('a')
    log.warn('b')
    log.error('c')
    expect(lines).toEqual([
      { time: '09:05:07', level: 'I', text: 'a' },
      { time: '09:05:07', level: 'W', text: 'b' },
      { time: '09:05:07', level: 'E', text: 'c' },
    ])
  })

  it('sink 抛错不外泄', () => {
    const log = new RunLog(() => {
      throw new Error('窗口没了')
    })
    expect(() => log.info('x')).not.toThrow()
  })
})
