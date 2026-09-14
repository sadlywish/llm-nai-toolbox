import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CHARACTER_FIELDS, MAIN_FIELDS } from '../../src/shared/fields'
import type { GenImageEvent, RoundRecord, RunProgress } from '../../src/shared/gen'
import { emptyWorkspace } from '../../src/shared/workspace'

const genStart = vi.fn()
const genResume = vi.fn(() => Promise.resolve())
const genCancel = vi.fn(() => Promise.resolve())
const loadHistory = vi.fn(() => Promise.resolve([] as RoundRecord[]))
const saveWorkspace = vi.fn(() => Promise.resolve())

const offProgress = vi.fn()
const offImage = vi.fn()
const offSeed = vi.fn()
let progressHandler: ((p: RunProgress) => void) | null = null
let imageHandler: ((e: GenImageEvent) => void) | null = null
let seedHandler: ((seed: number) => void) | null = null
const onGenProgress = vi.fn((cb: (p: RunProgress) => void) => {
  progressHandler = cb
  return offProgress
})
const onGenImage = vi.fn((cb: (e: GenImageEvent) => void) => {
  imageHandler = cb
  return offImage
})
const onGenSeed = vi.fn((cb: (seed: number) => void) => {
  seedHandler = cb
  return offSeed
})

// 必须先装 window 再 import：store 与 workspace store 都直接引用 window.api
vi.stubGlobal('window', {
  api: { genStart, genResume, genCancel, loadHistory, onGenProgress, onGenImage, onGenSeed, saveWorkspace },
  addEventListener: () => {},
})

const { useGen, initGenSubscriptions, mergeHistoryWithProgress } = await import('../../src/renderer/src/state/gen')
const { useWorkspace } = await import('../../src/renderer/src/state/workspace')

function progress(over: Partial<RunProgress> = {}): RunProgress {
  return { roundId: 'r-new', status: 'running', total: 4, done: 0, failed: 0, pauseReason: null, abortReason: null, current: null, ...over }
}

function round(id: string): RoundRecord {
  const ws = emptyWorkspace()
  return {
    id,
    startedAt: '2026-09-14T00:00:00.000Z',
    finishedAt: '2026-09-14T00:05:00.000Z',
    status: 'done',
    count: 2,
    snapshot: { main: ws.main, text: '', negative: '', characters: [], useCoords: false, params: ws.params },
    assembled: { positive: 'x', negative: '', characters: [] },
    images: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  progressHandler = null
  imageHandler = null
  seedHandler = null
  useGen.setState({ progress: null, images: {}, history: [], runError: null, dialogOpen: false, viewingRoundId: null, starting: null })
})

describe('useGen', () => {
  it('initGenSubscriptions 订阅三路事件，cleanup 全部退订', () => {
    const cleanup = initGenSubscriptions()
    expect([onGenProgress, onGenImage, onGenSeed].map((f) => f.mock.calls.length)).toEqual([1, 1, 1])
    cleanup()
    expect([offProgress, offImage, offSeed].map((f) => f.mock.calls.length)).toEqual([1, 1, 1])
  })

  it('start 立刻打开出图弹窗，不等整轮跑完；跑完后刷新历史、清掉 starting', async () => {
    let resolveStart: (p: RunProgress) => void = () => {}
    genStart.mockImplementationOnce(() => new Promise<RunProgress>((resolve) => (resolveStart = resolve)))
    useGen.setState({ progress: progress({ roundId: 'r-prev', status: 'done' }) })
    const input = { workspace: emptyWorkspace(), count: 2 }

    const p = useGen.getState().start(input)
    expect(useGen.getState().dialogOpen).toBe(true)
    expect(useGen.getState().progress).toBeNull()
    expect(useGen.getState().starting?.input).toBe(input)

    resolveStart(progress({ status: 'done' }))
    await p
    expect(useGen.getState().dialogOpen).toBe(true)
    expect(loadHistory).toHaveBeenCalledTimes(1)
    expect(useGen.getState().starting).toBeNull()
  })

  it('start 预检失败：收回弹窗、不刷新历史、runError 去掉 Electron 前缀', async () => {
    genStart.mockRejectedValueOnce(new Error("Error invoking remote method 'gen:start': Error: 未设置图片保存目录，请先到设置里指定。"))
    await expect(useGen.getState().start({ workspace: emptyWorkspace(), count: 1 })).resolves.toBeUndefined()
    expect(useGen.getState().runError).toBe('未设置图片保存目录，请先到设置里指定。')
    expect(useGen.getState().dialogOpen).toBe(false)
    expect(loadHistory).not.toHaveBeenCalled()
  })

  it('generate：超出 token 上限时不发请求，runError 写明', async () => {
    const ws = emptyWorkspace()
    ws.params.model = 'nai-diffusion-4-5-full'
    ws.main.tags = Array.from({ length: 600 }, () => 'abcd').join(' ')
    await useGen.getState().generate(ws, MAIN_FIELDS, CHARACTER_FIELDS)
    expect(genStart).not.toHaveBeenCalled()
    expect(useGen.getState().runError).toMatch(/^提示词超出 token 上限（\d+ \/ 512），先删减再生成。$/)
  })

  it('generate：没超限时按工作区的跑图次数开跑', async () => {
    genStart.mockResolvedValueOnce(progress({ status: 'done' }))
    const ws = emptyWorkspace()
    ws.runCount = 3
    await useGen.getState().generate(ws, MAIN_FIELDS, CHARACTER_FIELDS)
    expect(genStart).toHaveBeenCalledWith({ workspace: ws, count: 3 })
  })

  it('closeDialog 只改显示状态，不碰进度与图片；openRound 指定展示那一轮', () => {
    useGen.setState({ dialogOpen: true, progress: progress(), images: { 0: { roundId: 'r-new', index: 0, file: 'a.png', seed: 1, status: 'ok', error: null } } })
    useGen.getState().closeDialog()
    expect(useGen.getState().dialogOpen).toBe(false)
    expect(useGen.getState().progress?.status).toBe('running')
    expect(Object.keys(useGen.getState().images)).toEqual(['0'])
    expect(genCancel).not.toHaveBeenCalled()
    useGen.getState().openRound('r-42')
    expect([useGen.getState().dialogOpen, useGen.getState().viewingRoundId]).toEqual([true, 'r-42'])
  })

  it('进度事件：未知轮次补一次历史刷新，同一轮后续 tick 不重复；已知轮次不刷新', async () => {
    const cleanup = initGenSubscriptions()
    progressHandler?.(progress())
    await Promise.resolve()
    await Promise.resolve()
    expect(loadHistory).toHaveBeenCalledTimes(1)
    progressHandler?.(progress({ done: 1 }))
    await Promise.resolve()
    expect(loadHistory).toHaveBeenCalledTimes(1)

    useGen.setState({ history: [round('r-known')] })
    progressHandler?.(progress({ roundId: 'r-known' }))
    await Promise.resolve()
    expect(loadHistory).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('单张事件按 index 记进 images', () => {
    const cleanup = initGenSubscriptions()
    const e: GenImageEvent = { roundId: 'r-new', index: 2, file: '', seed: 5, status: 'failed', error: 'NovelAI 返回 500：boom' }
    imageHandler?.(e)
    expect(useGen.getState().images[2]).toEqual(e)
    cleanup()
  })

  it('seed 事件写回参数区的 seed', () => {
    useWorkspace.setState({ workspace: emptyWorkspace() })
    const cleanup = initGenSubscriptions()
    seedHandler?.(2961054388)
    expect(useWorkspace.getState().workspace?.params.seed).toBe(2961054388)
    cleanup()
  })
})

describe('mergeHistoryWithProgress', () => {
  it('没有进度时原样返回历史', () => {
    const history = [round('r1')]
    expect(mergeHistoryWithProgress(history, null, null)).toEqual([{ round: history[0], live: null }])
  })

  it('进度命中历史里的一条时，只有那一条带 live', () => {
    const history = [round('r1'), round('r2')]
    const p = progress({ roundId: 'r2' })
    expect(mergeHistoryWithProgress(history, p, null)).toEqual([
      { round: history[0], live: null },
      { round: history[1], live: p },
    ])
  })

  it('进度的轮次不在历史里时，用 starting 合成占位记录钉在最前：张数、参数、只含参与本轮的角色', () => {
    const ws = emptyWorkspace()
    ws.params.width = 832
    ws.characters = [
      { id: 'a', enabled: true, fields: { count: 'girl', character: 'miku', appearance: '', tags: '', nltags: '' }, negative: '', position: '' },
      { id: 'b', enabled: false, fields: { count: '', character: 'rin', appearance: '', tags: '', nltags: '' }, negative: '', position: '' },
    ]
    const p = progress({ roundId: 'r-new' })
    const [first, second] = mergeHistoryWithProgress([round('r1')], p, { input: { workspace: ws, count: 3 }, at: '2026-09-14T01:30:00.000Z' })
    expect(first.live).toBe(p)
    expect([first.round.id, first.round.count, first.round.startedAt, first.round.status]).toEqual(['r-new', 3, '2026-09-14T01:30:00.000Z', 'running'])
    expect(first.round.snapshot.params.width).toBe(832)
    expect(first.round.snapshot.characters.map((c) => c.fields.character)).toEqual(['miku'])
    expect(second.round.id).toBe('r1')
  })

  it('没有 starting 时占位记录按 0 张处理，不抛错', () => {
    const [first] = mergeHistoryWithProgress([], progress(), null)
    expect([first.round.count, first.round.images]).toEqual([0, []])
  })
})
