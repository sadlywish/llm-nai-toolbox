import { mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAppConfig, type AppConfig } from '../../../src/shared/config'
import type { GenImageEvent, GenerateResult, RunProgress } from '../../../src/shared/gen'
import { createCharacter, emptyWorkspace, type Workspace } from '../../../src/shared/workspace'
import { IndexStore } from '../../../src/main/nai/index-store'
import type { NaiRequestBody } from '../../../src/main/nai/payload'
import { saveImage } from '../../../src/main/nai/save'
import { GenRunner, type GenRunnerDeps } from '../../../src/main/gen/runner'

// 只有「落盘阶段抛异常」一条用例要让 saveImage 失败；其余走真实实现
vi.mock('../../../src/main/nai/save', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/nai/save')>()
  return { ...actual, saveImage: vi.fn(actual.saveImage) }
})

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nai-gen-runner-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const NOW = new Date(2026, 8, 14, 12, 0)
const DAY = '2026-09-14'

function config(over: Partial<AppConfig> = {}): AppConfig {
  return { ...defaultAppConfig(), saveDir: root, taskIntervalMs: 0, ...over }
}

function workspace(): Workspace {
  const ws = emptyWorkspace()
  ws.main.count = '1girl'
  ws.negative = 'lowres'
  const c = createCharacter()
  c.fields.character = 'miku'
  c.negative = 'bad hands'
  c.position = 'B3'
  const off = createCharacter()
  off.enabled = false
  off.fields.character = 'rin'
  ws.characters = [c, off]
  ws.useCoords = true
  return ws
}

function ok(seed: number | null = 99): GenerateResult {
  return { ok: true, images: [{ data: Buffer.from('IMG').toString('base64'), mimeType: 'image/png', seed }] }
}

/** 只含一个 tEXt「Comment」块的最小 PNG，元数据里写着指定 seed */
function pngWithSeedComment(seed: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const data = Buffer.concat([Buffer.from('Comment', 'latin1'), Buffer.from([0]), Buffer.from(JSON.stringify({ seed }), 'utf-8')])
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  return Buffer.concat([signature, len, Buffer.from('tEXt', 'ascii'), data, Buffer.alloc(4)])
}

interface Harness extends GenRunnerDeps {
  bodies: NaiRequestBody[]
  progresses: RunProgress[]
  images: GenImageEvent[]
  seeds: number[]
}

/** randomSeed 依次给 1001、1002…，便于断言每张用了哪个 seed */
function harness(generate: (body: NaiRequestBody, nth: number) => Promise<GenerateResult>): Harness {
  let next = 1000
  const h: Harness = {
    bodies: [],
    progresses: [],
    images: [],
    seeds: [],
    generate: async (body) => {
      h.bodies.push(body)
      return generate(body, h.bodies.length)
    },
    sleep: async () => {},
    onProgress: (p) => h.progresses.push({ ...p }),
    onImage: (e) => h.images.push(e),
    onSeedResolved: (s) => h.seeds.push(s),
    now: () => NOW,
    randomSeed: () => ++next,
  }
  return h
}

const readRounds = () => new IndexStore(join(root, DAY)).read().rounds

describe('GenRunner', () => {
  it('跑完一轮：图片落盘，_index.json 记下快照、拼接结果与每张图', async () => {
    const h = harness(async () => ok(99))
    const final = await new GenRunner(h).start({ workspace: workspace(), count: 2 }, config(), 'pst')

    expect([final.status, final.done, final.failed]).toEqual(['done', 2, 0])
    const [round] = readRounds()
    expect([round.count, round.status]).toEqual([2, 'done'])
    expect(round.finishedAt).not.toBeNull()
    expect(round.snapshot.characters.map((c) => c.fields.character)).toEqual(['miku'])
    expect(round.assembled.positive).toBe('1girl, no text')
    expect(round.images.map((i) => [i.index, i.status, i.file])).toEqual([
      [0, 'ok', '00001-99.png'],
      [1, 'ok', '00002-99.png'],
    ])
    expect(readdirSync(join(root, DAY)).sort()).toEqual(['00001-99.png', '00002-99.png', '_index.json'])
    expect(h.images.map((e) => [e.roundId, e.index])).toEqual([
      [round.id, 0],
      [round.id, 1],
    ])
  })

  it('请求体：每张用自己的 seed；只带参与本轮的角色，网格坐标换算好', async () => {
    const h = harness(async () => ok(null))
    await new GenRunner(h).start({ workspace: workspace(), count: 2 }, config(), 'pst')
    expect(h.bodies.map((b) => b.parameters.seed)).toEqual([1001, 1002])
    const v4 = h.bodies[0].parameters.v4_prompt as { caption: { char_captions: unknown[] }; use_coords: boolean }
    expect(v4.caption.char_captions).toEqual([{ char_caption: 'miku ,', centers: [{ x: 0.3, y: 0.5 }] }])
    expect(v4.use_coords).toBe(true)
    expect(h.bodies[0].parameters.negative_prompt).toBe('lowres')
  })

  it('seed 来源：接口回报 → PNG 元数据 → 请求时的值', async () => {
    const fromMeta: GenerateResult = { ok: true, images: [{ data: pngWithSeedComment(777).toString('base64'), mimeType: 'image/png', seed: null }] }
    const results = [ok(555), fromMeta, ok(null)]
    const h = harness(async (_b, nth) => results[nth - 1])
    await new GenRunner(h).start({ workspace: workspace(), count: 3 }, config(), 'pst')
    expect(readRounds()[0].images.map((i) => i.seed)).toEqual([555, 777, 1003])
  })

  it('seed 回填：每张随机模式跑完回填最后一张的 seed；固定且给了值时全程同一个、不回填', async () => {
    const h1 = harness(async () => ok(null))
    await new GenRunner(h1).start({ workspace: workspace(), count: 3 }, config(), 'pst')
    expect(h1.seeds).toEqual([1003])

    const ws = workspace()
    ws.params.seedMode = 'fixed'
    ws.params.seed = 42
    const h2 = harness(async () => ok(null))
    await new GenRunner(h2).start({ workspace: ws, count: 2 }, config(), 'pst')
    expect(h2.bodies.map((b) => b.parameters.seed)).toEqual([42, 42])
    expect(h2.seeds).toEqual([])
  })

  it('固定模式 seed 为 -1：开跑前就随机一个、全程复用，立即回填并记进快照', async () => {
    const ws = workspace()
    ws.params.seedMode = 'fixed'
    ws.params.seed = -1
    let seedsAtFirstRequest: number[] | null = null
    const h = harness(async () => {
      seedsAtFirstRequest ??= [...h.seeds]
      return ok(null)
    })
    await new GenRunner(h).start({ workspace: ws, count: 2 }, config(), 'pst')
    expect(h.bodies.map((b) => b.parameters.seed)).toEqual([1001, 1001])
    expect(seedsAtFirstRequest).toEqual([1001])
    expect(h.seeds).toEqual([1001])
    expect(readRounds()[0].snapshot.params.seed).toBe(1001)
  })

  it('非致命失败按张记 failed 并带原文，不中断整批', async () => {
    const h = harness(async (_b, nth) => (nth === 1 ? { ok: false, error: { kind: 'http', message: 'NovelAI 返回 500：boom' } } : ok(99)))
    const final = await new GenRunner(h).start({ workspace: workspace(), count: 2 }, config({ retryCount: 0 }), 'pst')
    expect([final.done, final.failed]).toEqual([1, 1])
    expect(readRounds()[0].images.find((i) => i.status === 'failed')).toMatchObject({ index: 0, file: '', error: 'NovelAI 返回 500：boom' })
  })

  it('Token 失效：整批中止，只记这一张失败，不再发后面的请求', async () => {
    const message = 'NovelAI Token 无效或已过期，请到设置里重新填写。'
    const h = harness(async () => ({ ok: false, error: { kind: 'unauthorized', message } }))
    const final = await new GenRunner(h).start({ workspace: workspace(), count: 3 }, config(), 'pst')
    expect([final.status, final.abortReason]).toEqual(['aborted', message])
    expect(h.bodies).toHaveLength(1)
    const [round] = readRounds()
    expect(round.status).toBe('aborted')
    expect(round.images).toHaveLength(1)
  })

  it('429：暂停、不记失败、落盘 paused；继续后从这张重发', async () => {
    let statusOnDiskWhilePaused = ''
    let imagesWhilePaused = -1
    const h = harness(async (_b, nth) => (nth === 1 ? { ok: false, error: { kind: 'concurrent', message: '并发冲突' } } : ok(99)))
    const runner: GenRunner = new GenRunner({
      ...h,
      onProgress: (p) => {
        if (p.status !== 'paused') return
        const [round] = readRounds()
        statusOnDiskWhilePaused = round.status
        imagesWhilePaused = round.images.length
        setTimeout(() => runner.resume(), 0)
      },
    })
    const final = await runner.start({ workspace: workspace(), count: 1 }, config(), 'pst')
    expect([statusOnDiskWhilePaused, imagesWhilePaused]).toEqual(['paused', 0])
    expect(final.status).toBe('done')
    expect(h.bodies.map((b) => b.parameters.seed)).toEqual([1001, 1001])
  })

  it('取消：保留已出的图，轮次记 cancelled，不回填 seed', async () => {
    const h = harness(async () => ok(99))
    const runner: GenRunner = new GenRunner({ ...h, onImage: () => runner.cancel() })
    const final = await runner.start({ workspace: workspace(), count: 3 }, config(), 'pst')
    expect(final.status).toBe('cancelled')
    const [round] = readRounds()
    expect(round.status).toBe('cancelled')
    expect(round.images).toHaveLength(1)
    expect(h.seeds).toEqual([])
  })

  it('预检：没设保存目录或没填 Token 时直接失败，不发请求、不留轮次', async () => {
    const h = harness(async () => ok())
    const runner = new GenRunner(h)
    await expect(runner.start({ workspace: workspace(), count: 1 }, config({ saveDir: '' }), 'pst')).rejects.toThrow('未设置图片保存目录，请先到设置里指定。')
    await expect(runner.start({ workspace: workspace(), count: 1 }, config(), '')).rejects.toThrow('未配置 NovelAI Token，请先到设置里填写。')
    expect(h.bodies).toHaveLength(0)
    expect(readdirSync(root)).toEqual([])
  })

  it('在途保护：上一轮没结束时再 start 被拒，不影响上一轮', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const h = harness(async () => {
      await gate
      return ok(99)
    })
    const runner = new GenRunner(h)
    const first = runner.start({ workspace: workspace(), count: 1 }, config(), 'pst')
    await expect(runner.start({ workspace: workspace(), count: 1 }, config(), 'pst')).rejects.toThrow('已有一轮正在进行中。请先等待它结束或取消。')
    release()
    expect((await first).status).toBe('done')
  })

  it('落盘阶段抛异常：这张记 failed，队列按失败继续', async () => {
    vi.mocked(saveImage).mockImplementationOnce(() => {
      throw new Error('磁盘满')
    })
    const h = harness(async () => ok(99))
    const final = await new GenRunner(h).start({ workspace: workspace(), count: 2 }, config({ retryCount: 0 }), 'pst')
    expect([final.done, final.failed]).toEqual([1, 1])
    const images = readRounds()[0].images
    expect(images.find((i) => i.index === 0)).toMatchObject({ status: 'failed', error: '磁盘满' })
    expect(images.find((i) => i.index === 1)?.status).toBe('ok')
  })

  it('通知渲染进程失败不影响已经记成 ok 的图', async () => {
    const h = harness(async () => ok(99))
    const final = await new GenRunner({
      ...h,
      onImage: () => {
        throw new Error('窗口没了')
      },
    }).start({ workspace: workspace(), count: 1 }, config(), 'pst')
    expect(final.done).toBe(1)
    expect(readRounds()[0].images[0].status).toBe('ok')
  })
})
