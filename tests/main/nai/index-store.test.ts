import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ImageRecord, RoundRecord } from '../../../src/shared/gen'
import { emptyWorkspace } from '../../../src/shared/workspace'
import { IndexStore, loadRecentRounds } from '../../../src/main/nai/index-store'
import { takeSnapshot } from '../../../src/main/gen/snapshot'
import { defaultAppConfig } from '../../../src/shared/config'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ast-index-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function round(id = 'r1'): RoundRecord {
  return {
    id,
    startedAt: '2026-09-09T12:00:00+08:00',
    finishedAt: null,
    status: 'running',
    count: 1,
    snapshot: takeSnapshot(emptyWorkspace(), null, defaultAppConfig()),
    assembled: { positive: '1girl , no text', negative: '', characters: [] },
    images: [],
  }
}

function image(over: Partial<ImageRecord> = {}): ImageRecord {
  return { index: 0, file: '00001-42.png', seed: 42, status: 'ok', error: null, ...over }
}

describe('IndexStore', () => {
  it('首次读取返回空索引', () => {
    const idx = new IndexStore(root).read()
    expect(idx.version).toBe(1)
    expect(idx.rounds).toEqual([])
  })

  it('startRound 追加一轮，并保留完整快照', () => {
    const store = new IndexStore(root)
    store.startRound(round())
    const idx = new IndexStore(root).read()
    expect(idx.rounds).toHaveLength(1)
    expect(idx.rounds[0].snapshot.params.steps).toBe(28)
    expect(idx.rounds[0].assembled.positive).toBe('1girl , no text')
    // 出图时的字段顺序跟着快照落盘：溯源与手机端按它排块，读回来丢了就只能按当前设置排
    expect(idx.rounds[0].snapshot.promptOrder).toBe(defaultAppConfig().promptOrder)
    expect(idx.rounds[0].snapshot.naiCharPromptOrder).toBe(defaultAppConfig().naiCharPromptOrder)
  })

  it('putImage 把图记进对应的轮次', () => {
    const store = new IndexStore(root)
    store.startRound(round())
    store.putImage('r1', image())
    expect(new IndexStore(root).read().rounds[0].images).toHaveLength(1)
  })

  it('同一张图重复 putImage 时覆盖而不是追加', () => {
    const store = new IndexStore(root)
    store.startRound(round())
    store.putImage('r1', image({ status: 'failed', error: '超时' }))
    store.putImage('r1', image({ status: 'ok' }))
    const images = new IndexStore(root).read().rounds[0].images
    expect(images).toHaveLength(1)
    expect(images[0].status).toBe('ok')
  })

  it('不同 index 的图各记一条', () => {
    const store = new IndexStore(root)
    store.startRound(round())
    store.putImage('r1', image({ index: 0 }))
    store.putImage('r1', image({ index: 1, file: '00002-43.png' }))
    const images = new IndexStore(root).read().rounds[0].images
    expect(images.map((i) => i.index)).toEqual([0, 1])
  })

  it('失败的图也会被记录', () => {
    const store = new IndexStore(root)
    store.startRound(round())
    store.putImage('r1', image({ status: 'failed', error: '点数不足', file: '' }))
    const rec = new IndexStore(root).read().rounds[0].images[0]
    expect(rec.status).toBe('failed')
    expect(rec.error).toBe('点数不足')
  })

  it('finishRound 补上结束时间与传入的状态', () => {
    const store = new IndexStore(root)
    store.startRound(round())
    store.finishRound('r1', '2026-09-09T12:07:52+08:00', 'cancelled')
    const r = new IndexStore(root).read().rounds[0]
    expect(r.finishedAt).toBe('2026-09-09T12:07:52+08:00')
    expect(r.status).toBe('cancelled')
  })

  it('startRound 总是把状态钉成 running，不管传入的 round 里写的是什么', () => {
    // startRound 不该信任调用方传入的 status——一旦某条调用路径漏传或传错，
    // 写出去的就是一条状态本身就不对的轮次记录
    const store = new IndexStore(root)
    store.startRound({ ...round(), status: 'done' })
    expect(new IndexStore(root).read().rounds[0].status).toBe('running')
  })

  it('pauseRound 把状态写成 paused', () => {
    const store = new IndexStore(root)
    store.startRound(round())
    store.pauseRound('r1')
    expect(new IndexStore(root).read().rounds[0].status).toBe('paused')
  })

  it('对不存在的轮次操作时安静忽略，不抛异常', () => {
    const store = new IndexStore(root)
    expect(() => store.putImage('nope', image())).not.toThrow()
    expect(() => store.finishRound('nope', 'x', 'done')).not.toThrow()
    expect(() => store.pauseRound('nope')).not.toThrow()
  })

  it('索引文件损坏时按空索引处理', () => {
    writeFileSync(join(root, '_index.json'), '{ 坏掉的', 'utf-8')
    expect(new IndexStore(root).read().rounds).toEqual([])
  })

  it('startRound 用同一个 id 调两次时不产生重复条目', () => {
    const store = new IndexStore(root)
    store.startRound(round('dup'))
    store.startRound(round('dup'))
    expect(new IndexStore(root).read().rounds).toHaveLength(1)
  })
})

describe('loadRecentRounds', () => {
  const now = new Date(2026, 8, 9, 12, 0)

  it('根目录不存在时返回空数组', () => {
    expect(loadRecentRounds(join(root, 'nope'), 7, now)).toEqual([])
  })

  it('读出最近若干天的轮次', () => {
    const d1 = join(root, '2026-09-09')
    const d2 = join(root, '2026-09-08')
    mkdirSync(d1, { recursive: true })
    mkdirSync(d2, { recursive: true })
    new IndexStore(d1).startRound(round('today'))
    new IndexStore(d2).startRound(round('yesterday'))
    const ids = loadRecentRounds(root, 7, now).map((r) => r.id)
    expect(ids).toContain('today')
    expect(ids).toContain('yesterday')
  })

  it('超出天数范围的目录不读', () => {
    const old = join(root, '2026-08-01')
    mkdirSync(old, { recursive: true })
    new IndexStore(old).startRound(round('ancient'))
    expect(loadRecentRounds(root, 7, now).map((r) => r.id)).not.toContain('ancient')
  })

  it('按开始时间倒序，最新的在前', () => {
    const d1 = join(root, '2026-09-09')
    mkdirSync(d1, { recursive: true })
    const store = new IndexStore(d1)
    store.startRound({ ...round('early'), startedAt: '2026-09-09T10:00:00+08:00' })
    store.startRound({ ...round('late'), startedAt: '2026-09-09T18:00:00+08:00' })
    expect(loadRecentRounds(root, 7, now).map((r) => r.id)).toEqual(['late', 'early'])
  })

  it('损坏的日期目录跳过，不影响其余', () => {
    const good = join(root, '2026-09-09')
    const bad = join(root, '2026-09-08')
    mkdirSync(good, { recursive: true })
    mkdirSync(bad, { recursive: true })
    new IndexStore(good).startRound(round('good'))
    writeFileSync(join(bad, '_index.json'), '{ 坏掉的', 'utf-8')
    expect(loadRecentRounds(root, 7, now).map((r) => r.id)).toEqual(['good'])
  })

  it('跨时区偏移的 startedAt 也按真实时刻排序', () => {
    const dir = join(root, '2026-09-09')
    mkdirSync(dir, { recursive: true })
    const store = new IndexStore(dir)
    // east 是 10:00 UTC，utc 是 13:00 UTC —— east 更早。
    // 但按字符串字典序比较时 '18:00+08:00' 会排在 '13:00+00:00' 前面，
    // 也就是把更早的那条当成更晚的
    store.startRound({ ...round('east'), startedAt: '2026-09-09T18:00:00+08:00' })
    store.startRound({ ...round('utc'), startedAt: '2026-09-09T13:00:00+00:00' })
    expect(loadRecentRounds(root, 7, now).map((r) => r.id)).toEqual(['utc', 'east'])
  })

  it('生产实际写出的 UTC（Z 后缀）时间戳也按真实时刻排序', () => {
    // runner.ts 用 startedAt.toISOString()，写出的形状是 '...Z' 而不是
    // 带 +08:00 偏移的字符串。上面那条混合偏移的用例只覆盖了「偏移不一致」
    // 这个区分力，不能替代「生产实际写出的形状能被正确排序」这条覆盖
    const dir = join(root, '2026-09-09')
    mkdirSync(dir, { recursive: true })
    const store = new IndexStore(dir)
    store.startRound({ ...round('early'), startedAt: '2026-09-09T02:00:00.000Z' })
    store.startRound({ ...round('late'), startedAt: '2026-09-09T10:00:00.000Z' })
    expect(loadRecentRounds(root, 7, now).map((r) => r.id)).toEqual(['late', 'early'])
  })

  it('快照、拼接结果或图片列表缺失的畸形轮次被跳过', () => {
    // spec §11.1：跳过并记日志，不影响启动。isIndexFile 通不过就整个
    // _index.json 都回退为空索引，太粗；但一条手改坏的 round 混在一堆
    // 好数据中间时，isIndexFile 完全看不出来——只能在 loadRecentRounds
    // 里逐条过滤，否则 round.snapshot / round.assembled 相关的消费会直接 TypeError
    const dir = join(root, '2026-09-09')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, '_index.json'),
      JSON.stringify({
        version: 1,
        rounds: [
          round('good'),
          { ...round('bad-snapshot'), snapshot: undefined },
          { ...round('bad-assembled'), assembled: undefined },
          { ...round('bad-images'), images: undefined },
        ],
      }),
      'utf-8',
    )
    expect(loadRecentRounds(root, 7, now).map((r) => r.id)).toEqual(['good'])
  })

  it('running/paused 读回时改报 interrupted，但不回写文件', () => {
    // running/paused 不可能跨重启存活；但回写会抹掉「当时暂停在第几张」
    // 这条排查线索，所以推导只能发生在内存里
    const dir = join(root, '2026-09-09')
    mkdirSync(dir, { recursive: true })
    const store = new IndexStore(dir)
    store.startRound({ ...round('was-running'), status: 'running' })
    store.pauseRound('was-running')
    store.startRound({ ...round('was-paused'), status: 'paused' })
    store.pauseRound('was-paused')

    const before = readFileSync(join(dir, '_index.json'), 'utf-8')
    const rounds = loadRecentRounds(root, 7, now)
    expect(rounds.every((r) => r.status === 'interrupted')).toBe(true)
    expect(readFileSync(join(dir, '_index.json'), 'utf-8')).toBe(before)
  })
})
