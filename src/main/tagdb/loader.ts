import { readFile } from 'fs/promises'
import type { TagdbStatus } from '@shared/ipc'
import type { TagEntry, TagIndex } from '@shared/tagdb/search'
import { buildIndex, collectNames } from '@shared/tagdb/search'
import { completionKeys, foldForCompletion } from '@shared/tagdb/completionMatch'
import { TAGDB_FILES, tagdbFilePath } from './paths'

export interface Category {
  entries: TagEntry[]
  index: TagIndex
  /**
   * 补全索引：**每个词首**起的 2 个字符 → 条目下标（按条目去重）。
   *
   * 与 `index`（trigram 倒排）是两份，各服务一套规则，都不能省：
   *  - `index` 的键建在 `normalize` 的结果上，那个函数**删掉**了下划线与
   *    括号，所以它无法回答「哪些名字有个词以 bl 开头」；
   *  - 而 `getCandidates` 对 1 字符查询 `return null`、调用处 `complete.ts`
   *    写的是 `?? []`，null 变空数组，**不会**退化成全表扫描；2 字符的拉丁
   *    查询在 trigram 索引里则通常零命中（`extractTrigrams` 对非 CJK 长名
   *    只产 trigram）。真正挡住短查询走 trigram 索引的是 `normalize`（删掉
   *    下划线与括号）与 `foldForCompletion`（下划线折成空格）对词边界的
   *    看法分歧，细节见 `complete.ts` 的 `fullMatchEnabled`。逐字补全因此
   *    走不了它。
   *
   * 实测规模（四类合计约 170872 条、70 万个名字）：posting 总量 192.6 万个
   * 下标（约 7.3 MB），287444 种键。最大的桶是 artists 的 `")"` 28625 条
   * —— 那是 `xxx_(yyy)` 的收尾括号，只有把 `)` 当查询首字符才会碰到，实际
   * 不可达。单字符查询要把所有以它开头的桶并起来，最坏是 artists 的 `"s"`
   * 17898 条、general 的 `"s"` 10173 条。
   *
   * 键取 2 个字符而不是 1 个，因为 2 个字符的查询能一次 `get` 拿到**确切**
   * 答案、不必回头重新折叠整桶名字去校验；1 个字符的查询才需要并桶，遍历
   * 键集合（artists 111554 种）做 `startsWith` 是微秒级。
   *
   * 词首不足 2 个字符时就用剩下的那 1 个做键，这样单字符的名字也进得了桶。
   */
  completionIndex: Map<string, number[]>
}

export interface TagdbCategories {
  artists: Category
  characters: Category
  series: Category
  general: Category
}

/**
 * 补齐真实数据里不存在的字段。
 *
 * tags_index_v2.json 的条目只有 tag/count/zh/ja/en/other/series；
 * 检索算法还会读 zhFull/zhShort/zhNick（完整译名/缩写/昵称），
 * 缺了会在 collectNames 里变成 undefined 并让 for..of 抛错。
 *
 * 两层校验，不只判「有没有」：
 *  - 元素本身不是对象（字符串、数字……）就整条跳过——旧写法会让它落进
 *    `e.tag` 这类属性访问，取到 undefined 后被 `String(undefined ?? '')`
 *    抹成合法却毫无意义的 `tag: ''`，报表里凭空多出一条空标签；
 *  - 该是数组的字段类型不对（`{ zh: "蓝发" }`，字符串而不是数组）就退化成
 *    `[]`，不能就地断言成 `string[]` 直接收下——那会把一个字符串塞进本该是
 *    数组的字段，`collectNames` 对它 `for..of` 倒是不会抛错（字符串可迭代），
 *    但吐出来的是一个个汉字，不是名字，补全索引会被这些假「名字」污染。
 */
export function fillEntries(raw: unknown): TagEntry[] {
  if (!Array.isArray(raw)) return []
  const asStringArray = (x: unknown): string[] => (Array.isArray(x) ? x : [])
  const out: TagEntry[] = []
  for (const e of raw as unknown[]) {
    if (typeof e !== 'object' || e === null) continue
    const rec = e as Record<string, unknown>
    out.push({
      tag: String(rec.tag ?? ''),
      count: Number(rec.count ?? 0),
      zh: asStringArray(rec.zh),
      zhFull: asStringArray(rec.zhFull),
      zhShort: asStringArray(rec.zhShort),
      zhNick: asStringArray(rec.zhNick),
      ja: asStringArray(rec.ja),
      en: asStringArray(rec.en),
      other: asStringArray(rec.other),
      series: asStringArray(rec.series),
    })
  }
  return out
}

/**
 * 建补全索引。键是**每个词首**起的 2 个字符，值是条目下标（按条目去重）。
 *
 * 键的产生完全交给 `completionKeys`，它和查询端的 `matchesAt` 共用同一套
 * 「可匹配位置」定义 —— 所以索引必然覆盖每一个可能的命中位置，预筛不会
 * 静默丢候选。**不要在这里自己算词首。**
 *
 * 去重是按**条目**而不是按名字：一个条目的多个别名常落进同一个桶
 * （`blue_hair` 与别名 `blue hair` 折叠后一模一样），不去重会让同一条目
 * 在候选里出现多次。
 */
export function buildCompletionIndex(entries: TagEntry[]): Map<string, number[]> {
  const map = new Map<string, number[]>()
  for (let i = 0; i < entries.length; i++) {
    const seen = new Set<string>()
    for (const name of collectNames(entries[i])) {
      for (const key of completionKeys(foldForCompletion(name))) {
        if (seen.has(key)) continue
        seen.add(key)
        let list = map.get(key)
        if (list === undefined) {
          list = []
          map.set(key, list)
        }
        list.push(i)
      }
    }
  }
  return map
}

/**
 * 标签索引的加载器。
 *
 * 用 `fs/promises` 的 readFile 而不是插件那份同步 readFileSync ——
 * 后者在 Electron 主进程会把启动卡住（这个文件 29MB）。
 * 注意 `JSON.parse` 本身仍是同步的、仍会占住主线程一两秒；这是刻意接受的
 * 一次性代价，界面在此期间显示「标签库载入中」（状态经回调广播出去）。
 *
 * 「缺文件」与「文件损坏」分成 missing / error 两种状态：前者是用户没放数据，
 * 提示他去放；后者是数据坏了，提示他重新取一份。混成一种会让人查错方向。
 */
export class TagdbLoader {
  private _status: TagdbStatus = {
    state: 'idle',
    detail: '尚未开始加载',
    counts: null,
  }
  private _categories: TagdbCategories | null = null
  private _loadPromise: Promise<void> | null = null

  constructor(
    private readonly dir: string,
    private readonly onStatus: (s: TagdbStatus) => void,
  ) {}

  get status(): TagdbStatus {
    return this._status
  }

  get categories(): TagdbCategories | null {
    return this._categories
  }

  private set(next: Partial<TagdbStatus>): void {
    this._status = { ...this._status, ...next }
    try {
      this.onStatus(this._status)
    } catch {
      // 监听方的失败不该中断加载。Task 6 里这个回调是 webContents.send，
      // 窗口销毁后会抛 —— 那是界面的事，标签库该照常载完，
      // 后来者仍可以通过 `status` / `categories` 读到结果。
    }
  }

  /**
   * 幂等：并发调用共享同一次加载。
   *
   * 不能用布尔量守卫 —— 布尔量在第一个 await 之前就置位了，第二个调用者会
   * 立刻拿到一个已完成的 promise，`await` 返回时 `categories` 其实还是 null。
   * 缓存 promise 才能让所有调用者等到同一次真正的完成。
   */
  load(): Promise<void> {
    this._loadPromise ??= this.run()
    return this._loadPromise
  }

  private async run(): Promise<void> {
    const path = tagdbFilePath(this.dir, TAGDB_FILES.index)
    this.set({ state: 'loading', detail: `正在加载 ${TAGDB_FILES.index}` })

    let raw: string
    try {
      raw = await readFile(path, 'utf-8')
    } catch (e) {
      // 分开两种失败：文件确实没放，和文件在但读不了（权限、被占用、同名目录）。
      // 混成一句「找不到」会把人支到错误的方向去查。
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        this.set({
          state: 'missing',
          detail: `找不到 ${TAGDB_FILES.index}。请把它放进 ${this.dir}，标签补全在此之前不可用。`,
          counts: null,
        })
      } else {
        this.set({
          state: 'error',
          detail: `读取 ${TAGDB_FILES.index} 失败：${String(e)}。请检查文件权限或是否被其他程序占用。`,
          counts: null,
        })
      }
      return
    }

    try {
      const data = JSON.parse(raw) as Record<string, unknown>
      const artists = fillEntries(data.artists)
      const characters = fillEntries(data.characters)
      const series = fillEntries(data.series)
      const general = fillEntries(data.general)

      const loaded = { artists, characters, series, general }
      const empty = Object.entries(loaded)
        .filter(([, list]) => list.length === 0)
        .map(([name]) => name)
      if (empty.length > 0) {
        // 逐类判空，不是只判「四类全空」：旧版 schema、文件被截断、或只有一类，
        // 都会让 total > 0 而挂上 ready —— 那时状态条整条消失，对应字段打字
        // 静默无候选，用户没有任何线索。宁可整体报错，也不给半个能用的库。
        this._categories = null
        this.set({
          state: 'error',
          detail: `${TAGDB_FILES.index} 缺少这些类别的数据：${empty.join('、')}。文件可能是旧版本或不完整，请重新取一份。`,
          counts: null,
        })
        return
      }

      const mk = (entries: TagEntry[]): Category => ({
        entries,
        index: buildIndex(entries),
        completionIndex: buildCompletionIndex(entries),
      })
      this._categories = {
        artists: mk(artists),
        characters: mk(characters),
        series: mk(series),
        general: mk(general),
      }
      this.set({
        state: 'ready',
        detail: `${TAGDB_FILES.index} 已就绪`,
        counts: {
          artists: artists.length,
          characters: characters.length,
          series: series.length,
          general: general.length,
        },
      })
    } catch (e) {
      this._categories = null
      this.set({
        state: 'error',
        detail: `${TAGDB_FILES.index} 解析失败：${String(e)}。文件可能不完整，请重新取一份。`,
        counts: null,
      })
    }
  }
}
