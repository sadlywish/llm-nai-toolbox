import { describe, expect, it } from 'vitest'
import type { GenImageEvent, GenSnapshot, ImageRecord, RoundRecord, RunProgress } from '../../src/shared/gen'
import { emptyWorkspace, type Workspace } from '../../src/shared/workspace'
import { applyRoundToMobile, catchUpFrom, genStatusText, mergeImage, needsCatchUp, restoreRound, slotsOf } from '../../src/mobile/src/slots'

/**
 * 出图页那点判断全在这里测（计划 Task 15）。
 *
 * 格子状态判错的后果是「明明出好了却一直显示生成中」；断线补齐判错的后果更重——
 * 补错了会把别人那一轮的图挂到自己这一轮上，补不上则永远停在「跑图中」（手机锁屏、
 * 切后台都会断 SSE，断线期间的进度事件是真的丢了，只能靠历史兜回来）。
 */

function progressOf(over: Partial<RunProgress> = {}): RunProgress {
  return {
    roundId: 'round-1',
    status: 'running',
    total: 4,
    done: 1,
    failed: 0,
    pauseReason: null,
    abortReason: null,
    current: 1,
    ...over,
  }
}

function image(index: number, over: Partial<GenImageEvent> = {}): GenImageEvent {
  return { roundId: 'round-1', index, file: `0000${index}-1.png`, seed: 1000 + index, status: 'ok', error: null, ...over }
}

function snapshotOf(over: Partial<GenSnapshot> = {}): GenSnapshot {
  const ws = emptyWorkspace()
  return {
    main: { ...ws.main, artist: 'artist:wlop' },
    text: 'hello',
    negative: 'bad hands',
    characters: [],
    useCoords: false,
    params: { ...ws.params, seed: -1, seedMode: 'perImage', steps: 28 },
    llm: null,
    ...over,
  }
}

function roundOf(images: ImageRecord[], over: Partial<RoundRecord> = {}): RoundRecord {
  return {
    id: 'round-1',
    startedAt: '2026-09-16T12:31:00.000Z',
    finishedAt: '2026-09-16T12:33:00.000Z',
    status: 'done',
    count: 4,
    snapshot: snapshotOf(),
    assembled: { positive: 'p', negative: 'n', characters: [] },
    images,
    ...over,
  }
}

describe('slotsOf', () => {
  it('还没出的格子是等待，正在出的那张是生成中，出好的带文件名与 seed', () => {
    expect(slotsOf(progressOf(), [image(0)])).toEqual([
      { index: 0, kind: 'ok', file: '00000-1.png', seed: 1000 },
      { index: 1, kind: 'running' },
      { index: 2, kind: 'waiting' },
      { index: 3, kind: 'waiting' },
    ])
  })

  it('失败的格子带上原因', () => {
    const failed = image(1, { file: '', seed: 5, status: 'failed', error: '点数不足' })
    expect(slotsOf(progressOf({ current: 2, done: 0, failed: 1 }), [failed])[1]).toEqual({
      index: 1,
      kind: 'failed',
      reason: '点数不足',
    })
  })

  it('原因缺失时也要说一句话，不能是空白格', () => {
    const failed = image(0, { file: '', status: 'failed', error: null })
    expect(slotsOf(progressOf(), [failed])[0]).toEqual({ index: 0, kind: 'failed', reason: '这张没出来' })
  })

  it('别的轮次的图不算进这一轮', () => {
    // SSE 是广播的：电脑自己跑的那一轮，手机照样收得到它的 gen-image
    expect(slotsOf(progressOf(), [image(0, { roundId: 'round-9' })])[0]).toEqual({ index: 0, kind: 'waiting' })
  })

  it('暂停时没有「生成中」的格子：那一张还在队首没发出去', () => {
    const slots = slotsOf(progressOf({ status: 'paused', current: null }), [image(0)])
    expect(slots.filter((s) => s.kind === 'running')).toEqual([])
  })

  it('还没开跑（progress 为 null）就没有格子', () => {
    expect(slotsOf(null, [image(0)])).toEqual([])
  })
})

describe('genStatusText', () => {
  it('跑图中报的是已处理张数，不是成功张数', () => {
    expect(genStatusText(progressOf({ done: 1, failed: 1 }))).toBe('跑图中 · 2 / 4 · 失败 1')
  })

  it('暂停、完成、取消、中断各有各的说法', () => {
    expect(genStatusText(progressOf({ status: 'paused', done: 2, current: null }))).toBe('已暂停 · 2 / 4')
    expect(genStatusText(progressOf({ status: 'done', done: 4, current: null }))).toBe('完成 · 4 / 4')
    expect(genStatusText(progressOf({ status: 'cancelled', done: 2, current: null }))).toBe('已取消 · 2 / 4')
    expect(genStatusText(progressOf({ status: 'aborted', done: 1, failed: 1, current: null }))).toBe('已中断 · 2 / 4 · 失败 1')
  })

  it('还没开跑时不报进度', () => {
    expect(genStatusText(null)).toBe('还没出过图')
  })
})

describe('needsCatchUp', () => {
  it('电脑那头已经不忙了而本地还停在跑图中：要补', () => {
    expect(needsCatchUp(progressOf(), false)).toBe(true)
    expect(needsCatchUp(progressOf({ status: 'paused', current: null }), false)).toBe(true)
  })

  it('电脑还在跑就不补：断线期间的进度会由重连后的事件接着报', () => {
    expect(needsCatchUp(progressOf(), true)).toBe(false)
  })

  it('本地已经收到结局了就不补', () => {
    expect(needsCatchUp(progressOf({ status: 'done', current: null }), false)).toBe(false)
    expect(needsCatchUp(null, false)).toBe(false)
  })
})

describe('catchUpFrom', () => {
  it('用历史里的那一轮把格子补齐', () => {
    const record = roundOf([
      { index: 0, file: 'a.png', seed: 11, status: 'ok', error: null },
      { index: 1, file: '', seed: 12, status: 'failed', error: '超时' },
      { index: 2, file: 'c.png', seed: 13, status: 'ok', error: null },
      { index: 3, file: 'd.png', seed: 14, status: 'ok', error: null },
    ])
    const caught = catchUpFrom(progressOf(), [record])
    expect(caught?.progress).toEqual({
      roundId: 'round-1',
      status: 'done',
      total: 4,
      done: 3,
      failed: 1,
      pauseReason: null,
      abortReason: null,
      current: null,
    })
    expect(slotsOf(caught?.progress ?? null, caught?.images ?? [])).toEqual([
      { index: 0, kind: 'ok', file: 'a.png', seed: 11 },
      { index: 1, kind: 'failed', reason: '超时' },
      { index: 2, kind: 'ok', file: 'c.png', seed: 13 },
      { index: 3, kind: 'ok', file: 'd.png', seed: 14 },
    ])
    expect(caught?.record).toBe(record)
  })

  it('只认自己那一轮：历史最上面的是别人那一轮也不能拿来充数', () => {
    const other = roundOf([{ index: 0, file: 'x.png', seed: 1, status: 'ok', error: null }], { id: 'round-9' })
    const caught = catchUpFrom(progressOf(), [other])
    expect(caught?.progress.roundId).toBe('round-1')
    expect(caught?.progress.status).toBe('aborted')
    expect(caught?.images).toEqual([])
    expect(caught?.record).toBe(null)
  })

  it('记录里还写着 running（电脑中途关掉了）一样收尾，不让界面一直转', () => {
    const record = roundOf([{ index: 0, file: 'a.png', seed: 11, status: 'ok', error: null }], {
      status: 'running',
      finishedAt: null,
    })
    expect(catchUpFrom(progressOf(), [record])?.progress.status).toBe('aborted')
  })

  it('本地本来就不在跑图中就不补（别把已经收到的结局覆盖掉）', () => {
    expect(catchUpFrom(progressOf({ status: 'done', current: null }), [roundOf([])])).toBe(null)
    expect(catchUpFrom(null, [roundOf([])])).toBe(null)
  })
})

describe('restoreRound', () => {
  const images: ImageRecord[] = [
    { index: 0, file: 'a.png', seed: 11, status: 'ok', error: null },
    { index: 1, file: '', seed: 12, status: 'failed', error: '超时' },
  ]

  it('重新加载后按 id 找回那一轮：跑完的也要（切出去等结果，回来就是这种情形）', () => {
    const got = restoreRound('round-1', [roundOf(images)], false)
    expect(got?.progress).toEqual({
      roundId: 'round-1', status: 'done', total: 4, done: 1, failed: 1, pauseReason: null, abortReason: null, current: null,
    })
    expect(got?.images.map((i) => i.roundId)).toEqual(['round-1', 'round-1'])
    expect(got?.record?.id).toBe('round-1')
  })

  it('电脑还在跑这一轮：状态照记录里的，不收成已中断', () => {
    const got = restoreRound('round-1', [roundOf(images, { status: 'running', finishedAt: null })], true)
    expect(got?.progress.status).toBe('running')
  })

  it('电脑已经不忙了，记录却还停在跑图中：收成已中断（跨重启的残留轮次）', () => {
    const got = restoreRound('round-1', [roundOf(images, { status: 'running', finishedAt: null })], false)
    expect(got?.progress.status).toBe('aborted')
  })

  it('历史里没有这一轮就返回 null，不拿最近一轮充数', () => {
    expect(restoreRound('round-9', [roundOf(images)], false)).toBeNull()
    expect(restoreRound('round-1', [], true)).toBeNull()
  })
})

describe('mergeImage', () => {
  it('同一格重复推来只留最后一条', () => {
    const merged = mergeImage([image(0), image(1)], image(1, { seed: 999 }))
    expect(merged.length).toBe(2)
    expect(merged[1].seed).toBe(999)
  })

  it('换了一轮就把上一轮的清掉', () => {
    expect(mergeImage([image(0), image(1)], image(0, { roundId: 'round-2' }))).toEqual([image(0, { roundId: 'round-2' })])
  })
})

describe('applyRoundToMobile', () => {
  const base: Workspace = { ...emptyWorkspace(), text: '原来的画面文字', runCount: 3 }

  it('整套参数写回手机这一份，seed 用这张的并改成固定', () => {
    const next = applyRoundToMobile(base, snapshotOf(), 3163646731)
    expect(next.main.artist).toBe('artist:wlop')
    expect(next.text).toBe('hello')
    expect(next.negative).toBe('bad hands')
    expect(next.params.seed).toBe(3163646731)
    expect(next.params.seedMode).toBe('fixed')
    // 跑图次数是「这一次要出几张」，不属于那一轮的参数（同桌面端「复制信息」）
    expect(next.runCount).toBe(3)
  })

  it('传进来的那一份一个字都不动：React 认的是新对象', () => {
    const next = applyRoundToMobile(base, snapshotOf(), 7)
    expect(base.text).toBe('原来的画面文字')
    expect(base.params.seedMode).toBe('perImage')
    expect(base.params.seed).toBe(-1)
    expect(next).not.toBe(base)
  })
})
