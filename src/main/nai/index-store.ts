import { existsSync, readFileSync } from 'fs'
import { join, resolve, sep } from 'path'
import type { ImageMeta, ImageRecord, IndexFile, ReadImageInput, RoundRecord } from '@shared/gen'
import { JsonStore } from '../store'
import { readImageMeta } from './png'
import { dateDirName } from './save'

function emptyIndex(): IndexFile {
  return { version: 1, rounds: [] }
}

function isIndexFile(v: unknown): boolean {
  return typeof v === 'object' && v !== null && 'rounds' in v && Array.isArray(v.rounds)
}

/**
 * 单个日期目录下的 `_index.json`。
 *
 * 这个文件同时扛三个职责：溯源（本工具参数与拼接结果）、重建历史竖栏、复制信息回参数区。
 * 所以它记的是整轮快照 + 逐张图，而不只是逐张行记录。
 *
 * 写入复用 JsonStore 的原子写（先写临时文件、fsync、再 rename），
 * 跑图中途崩溃不会把索引写坏。
 */
export class IndexStore {
  private readonly store: JsonStore<IndexFile>

  constructor(dateDir: string) {
    this.store = new JsonStore<IndexFile>(join(dateDir, '_index.json'), emptyIndex, isIndexFile)
  }

  read(): IndexFile {
    return this.store.read()
  }

  startRound(round: RoundRecord): void {
    const idx = this.read()
    // 同 id 已存在时直接返回：重复 id 会让 putImage / finishRound 的 find
    // 永远只命中第一条，第二条变成补不上图、也永远不会结束的死数据。
    // 选择保留既有条目而不是覆盖，是因为覆盖会丢掉已经记进去的图
    if (idx.rounds.some((r) => r.id === round.id)) return
    // 轮次刚开始，状态只可能是 running——在这里钉死而不是信任调用方传入
    // 的值，免得将来某条调用路径漏传或传错，写出一条状态就不对的轮次记录
    idx.rounds.push({ ...round, status: 'running' })
    this.store.write(idx)
  }

  /**
   * 写入或覆盖一张图的记录。
   *
   * 用「覆盖」而不是「追加」：同一张（同一个 index）可能先失败
   * 后重试成功，追加会让同一格出现两条互相矛盾的记录。
   */
  putImage(roundId: string, rec: ImageRecord): void {
    const idx = this.read()
    const round = idx.rounds.find((r) => r.id === roundId)
    if (!round) return
    const at = round.images.findIndex((x) => x.index === rec.index)
    if (at >= 0) round.images[at] = rec
    else round.images.push(rec)
    this.store.write(idx)
  }

  /** status 由 Runner 传入队列跑完时的最终状态，收窄到三种终态——
   * 'running'/'paused' 不该出现在「结束」这个动作里 */
  finishRound(roundId: string, finishedAt: string, status: 'done' | 'cancelled' | 'aborted'): void {
    const idx = this.read()
    const round = idx.rounds.find((r) => r.id === roundId)
    if (!round) return
    round.finishedAt = finishedAt
    round.status = status
    this.store.write(idx)
  }

  /**
   * 429 暂停时把状态落盘为 paused。应用如果恰好在暂停期间被关掉，
   * 读取时 running/paused → interrupted 的推导才能进一步显示成
   * 「暂停中被中断」而不是笼统的「中断」——这是暂停路径唯一能补上
   * 这条信息的地方，finishRound 只有跑完/取消/中止才会被调用。
   */
  pauseRound(roundId: string): void {
    const idx = this.read()
    const round = idx.rounds.find((r) => r.id === roundId)
    if (!round) return
    round.status = 'paused'
    this.store.write(idx)
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isWellFormedRound(r: RoundRecord): boolean {
  return isRecord(r.snapshot) && isRecord(r.assembled) && Array.isArray(r.images)
}

/** 供日志用：具体点出缺了哪个字段，不影响 isWellFormedRound 本身的判定 */
function missingSnapshotFields(r: RoundRecord): string[] {
  const missing: string[] = []
  if (!isRecord(r.snapshot)) missing.push('snapshot')
  if (!isRecord(r.assembled)) missing.push('assembled')
  if (!Array.isArray(r.images)) missing.push('images')
  return missing
}

/**
 * 读取时的状态推导，只在内存里改，绝不回写。
 *
 * running/paused 不可能跨重启存活，一律改报 interrupted——但这条推导只能
 * 在读出来之后做：回写会把「这一轮当时暂停在第几张」这个信息抹掉，
 * 而那正是排查时唯一有用的线索，finishRound/pauseRound 才是唯一允许
 * 落盘状态的地方。
 */
function deriveStatus(round: RoundRecord): RoundRecord {
  if (round.status === 'running' || round.status === 'paused') {
    return { ...round, status: 'interrupted' }
  }
  return round
}

/**
 * 扫描最近 `days` 天的日期目录，汇总所有轮次，按开始时间倒序。
 *
 * 读不到或损坏的目录直接跳过：历史竖栏少一天，好过整个应用起不来。
 */
export function loadRecentRounds(
  rootDir: string,
  days: number,
  now: Date = new Date(),
): RoundRecord[] {
  if (!rootDir || !existsSync(rootDir)) return []

  const rounds: RoundRecord[] = []
  for (let i = 0; i < Math.max(1, days); i++) {
    const day = new Date(now)
    day.setDate(day.getDate() - i)
    const dir = join(rootDir, dateDirName(day))
    if (!existsSync(dir)) continue
    try {
      for (const round of new IndexStore(dir).read().rounds) {
        // 这里就是缺快照的轮次被丢弃的地方：过滤之后，历史竖栏与出图弹窗
        // 可以放心假定每条 RoundRecord 的 snapshot/assembled/images 都是
        // 合法结构，不必再逐处防御——想放宽这条过滤，要连带审查所有这类假设
        if (isWellFormedRound(round)) {
          rounds.push(deriveStatus(round))
        } else {
          // spec §11.1 写的是「跳过并记日志」，不能悄悄丢掉——用户看到的
          // 会是「我那一轮历史怎么不见了」，没有日志就没有任何线索可查
          console.warn(
            `轮次记录缺快照字段，已跳过：round=${round.id} dir=${dir} missing=${missingSnapshotFields(round).join(',')}`,
          )
        }
      }
    } catch (err) {
      // 单个目录坏掉不该拖垮整个历史竖栏，但同样不能静默——理由同上
      console.warn(`日期目录读取失败，已跳过：dir=${dir}`, err)
    }
  }

  // 按真实时刻排序，而不是 ISO 字符串的字典序：
  // 字典序只有在所有记录偏移量一致时才等于时间序，夏令时切换即可打破。
  // 非法时间戳兜底为 0（排到最旧），避免 NaN 让比较器行为未定义
  const atMs = (s: string): number => {
    const t = new Date(s).getTime()
    return Number.isFinite(t) ? t : 0
  }
  rounds.sort((a, b) => atMs(b.startedAt) - atMs(a.startedAt))
  return rounds
}

/**
 * 规范化后按前缀比较 `target` 是否落在 `root` 目录之下。
 *
 * 不能用字符串 `startsWith(root)`/`includes` 裸比：`C:\a` 与 `C:\ab`
 * 共享字符前缀，但后者根本不在前者目录下，裸比较会把这类路径误判为
 * 「在目录里」。给 root 补上一个尾部分隔符再比较，天然避开这个陷阱。
 */
export function isWithinDir(root: string, target: string): boolean {
  const normalizedRoot = resolve(root)
  const normalizedTarget = resolve(target)
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + sep)
}

/**
 * 读取历史图片字节，供渲染进程在 `npm run dev` 下显示——打包后 renderer
 * 的 origin 是 `file://`，`<img src="file://…">` 能直接加载；但开发模式下
 * origin 是 `http://localhost`，会被同源策略拦，出图弹窗一张图都看不见，
 * 只能靠这条 IPC 把字节搬过去。
 *
 * IPC 是渲染进程可任意调用的边界，不能假设调用方老实：即使当前唯一的
 * 调用方（出图弹窗）只会传 `_index.json` 里已经存在的裸文件名，这里仍
 * 按「外部输入」校验，而不是信任「反正只会这么调」。
 * - `file`/`roundStartedAt` 必须是字符串——「调用方一定传字符串」也是
 *   一种假设，非字符串不挡住的话会在下游 `path.join` 抛出未捕获异常，
 *   变成渲染进程那边的 rejected promise，而调用点大概率接不住
 * - `file` 必须是裸文件名：等于 `.`/`..`，或含路径分隔符（含 Windows
 *   的 `:` 盘符写法），一律拒绝——不含分隔符的字符串不可能构成多级路径，
 *   自然也就不会有 `..` 路径段，一道检查覆盖两类输入
 * - 拼出的绝对路径必须仍在 `saveDir` 之下才读，且判定要发生在
 *   `existsSync`/`readFileSync` 之前，校验失败绝不触碰磁盘
 */
export function readRoundImage(saveDir: string, input: ReadImageInput): ArrayBuffer | null {
  const { file, roundStartedAt } = input
  if (typeof file !== 'string' || typeof roundStartedAt !== 'string') return null
  if (!file || file === '.' || file === '..' || /[/\\:]/.test(file)) return null

  const startedAt = new Date(roundStartedAt)
  if (!Number.isFinite(startedAt.getTime())) return null

  const dateDir = join(saveDir, dateDirName(startedAt))
  const target = join(dateDir, file)
  if (!isWithinDir(saveDir, target)) return null

  if (!existsSync(target)) return null
  try {
    const bytes = readFileSync(target)
    // Buffer 可能是从更大的池分配出来的一段视图，必须按 byteOffset/byteLength
    // 截取，直接返回 .buffer 有截到无关字节的风险
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  } catch {
    return null
  }
}

/** 「图片元信息」页签与「复制信息」取 seed 用：路径校验同 readRoundImage，读不到返回 null */
export function readRoundImageMeta(saveDir: string, input: ReadImageInput): ImageMeta | null {
  const bytes = readRoundImage(saveDir, input)
  return bytes === null ? null : readImageMeta(Buffer.from(bytes))
}
