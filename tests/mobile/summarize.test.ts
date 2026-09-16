import { describe, expect, it } from 'vitest'
import type { ImageRecord, RoundRecord } from '../../src/shared/gen'
import { emptyWorkspace } from '../../src/shared/workspace'
import { summarize } from '../../src/mobile/src/summarize'

/**
 * 历史列表一条文字的测试（计划 Task 16）。
 *
 * 「今天/昨天/更早」判错的后果是历史列表整体看着像串了：真正要防的是按小时数判断
 * （23:50 出的图第二天 00:30 看该是「昨天」而不是因为没满 24 小时就算「今天」），
 * 所以专门写了一条跨日但不满 24 小时的用例。
 */

function image(index: number, status: 'ok' | 'failed'): ImageRecord {
  return {
    index,
    file: status === 'ok' ? `0000${index}-1.png` : '',
    seed: 1000 + index,
    status,
    error: status === 'failed' ? '超时' : null,
  }
}

function roundOf(images: ImageRecord[], startedAt: Date, over: Partial<RoundRecord> = {}): RoundRecord {
  const ws = emptyWorkspace()
  return {
    id: 'round-1',
    // 照 tests/renderer/formatTime.test.ts 的写法：用本地时间分量造 Date 再转 ISO，
    // 这样 new Date(iso) 读回来的本地时钟和写的时候一致，测试才不会随运行机器的时区飘
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    status: 'done',
    count: images.length,
    snapshot: {
      main: ws.main,
      text: '',
      negative: '',
      characters: [],
      useCoords: false,
      params: { ...ws.params, width: 832, height: 1216 },
      llm: null,
    },
    assembled: { positive: '', negative: '', characters: [] },
    images,
    ...over,
  }
}

describe('summarize', () => {
  it('今天：标题是时间与张数，副标题是尺寸与成功/失败数', () => {
    const now = new Date(2026, 8, 16, 15, 0)
    const round = roundOf([image(0, 'ok'), image(1, 'ok'), image(2, 'ok'), image(3, 'failed')], new Date(2026, 8, 16, 12, 31))
    expect(summarize(round, now)).toEqual({ title: '今天 12:31 · 4 张', sub: '832×1216 · 成功 3 · 失败 1' })
  })

  it('全成功时不写失败数', () => {
    const now = new Date(2026, 8, 16, 15, 0)
    const round = roundOf([image(0, 'ok'), image(1, 'ok')], new Date(2026, 8, 16, 11, 2))
    expect(summarize(round, now).sub).toBe('832×1216 · 成功 2')
  })

  it('昨天', () => {
    const now = new Date(2026, 8, 16, 8, 0)
    const round = roundOf([image(0, 'ok')], new Date(2026, 8, 15, 22, 14))
    expect(summarize(round, now).title).toBe('昨天 22:14 · 1 张')
  })

  it('更早的日子按 MM-DD', () => {
    const now = new Date(2026, 8, 16, 8, 0)
    const round = roundOf([image(0, 'ok')], new Date(2026, 8, 10, 9, 0))
    expect(summarize(round, now).title).toBe('09-10 09:00 · 1 张')
  })

  it('跨日但不满 24 小时也算「昨天」：按日历日比较，不是按满没满一天', () => {
    const now = new Date(2026, 8, 16, 0, 30)
    const round = roundOf([image(0, 'ok')], new Date(2026, 8, 15, 23, 50))
    expect(summarize(round, now).title).toBe('昨天 23:50 · 1 张')
  })

  it('时间解析不了时原样给出来，不编一个假的「今天」', () => {
    const round = roundOf([image(0, 'ok')], new Date(2026, 8, 16, 12, 0), { startedAt: 'not-a-date' })
    expect(summarize(round, new Date()).title).toBe('not-a-date · 1 张')
  })
})
