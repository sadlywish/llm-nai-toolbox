import type { CompletionPrefer } from '@shared/blockCompletion'
import type { CompletionItem } from '@shared/ipc'
import {
  COMPLETION_KEY_LEN,
  foldForCompletion,
  matchesAt,
} from '@shared/tagdb/completionMatch'
import type { TagEntry } from '@shared/tagdb/search'
import { collectNames, getCandidates, hasCjk, matchEntry, normalize } from '@shared/tagdb/search'
import type { Category, TagdbCategories } from './loader'

/**
 * 档 2 的分数下限。
 *
 * 不是拍脑袋定的：这就是 `searchOne` 里「<0.5 不给」的那道线，插件用它
 * 已久。别往下调——档 2 的作用是捞回词中间的子串，不是把整个库都倒出来。
 */
const FULL_MATCH_MIN_SCORE = 0.5

/** 排序档位。数字小的在前。 */
const TIER_EXACT = 0
const TIER_WORD_START = 1
const TIER_FULL_MATCH = 2

/** 内部用：带上档位与分数，排完序就丢掉。 */
interface Ranked {
  item: CompletionItem
  tier: number
  /**
   * 只有档 2 有意义；档 0/1 统一填 **1**，好让一个比较函数吃三档。
   *
   * 填 1（而不是 0 或 undefined）是有意的：1 是分数上界，所以
   * 「先比档位再比分数」与「先比分数再比档位」两种写法结果恒等
   * —— 档 2 的分数 <1 时排在后面，等于 1 时打平再由档位决定。
   * 比较器因此对这两个子句的先后不敏感，改动顺序不会悄悄改变行为。
   * 若哪天把这里改成 0，那个等价性立刻消失，比较器的子句顺序就变成
   * 承重的了。
   */
  score: number
}

const CATEGORY: Record<CompletionPrefer, keyof TagdbCategories> = {
  artist: 'artists',
  character: 'characters',
  series: 'series',
  general: 'general',
}

/**
 * `CompletionPrefer` 的全部取值，供 ipc.ts 校验外部传入的 `prefer` 用——
 * 别处手写一遍这四个字符串，两份列表迟早会漂移。
 */
export const COMPLETION_PREFERS = Object.keys(CATEGORY) as CompletionPrefer[]

function toItem(entry: TagEntry): CompletionItem {
  return { tag: entry.tag, count: entry.count, zh: entry.zh, series: entry.series }
}

/**
 * 档 2（完整检索逻辑）能不能用。传入的是 `normalize` 的结果 —— 因为档 2 走
 * 的是 trigram 倒排索引，那个索引的键就建在 `normalize` 上。
 *
 * 判据本身照抄 `calcSimilarity` 的那一行
 * （`const enough = hasCjk(nq) ? nq.length >= 2 : nq.length >= 3`），
 * 旁边记着 `nq="W"` 一次返回 168 万字符的事故。
 *
 * **但这道门槛在这里挡的不是那个事故**，理由要说准（实测过）：
 *  - `getCandidates` 对 `nq.length <= 1` 确实 `return null`，可本函数的调用处
 *    写的是 `?? []`，null 直接变空数组，**不会**退化成全表扫描。所以「1 个
 *    字符会全表扫 + 每条跑 Levenshtein」对这份代码不成立，别这么注释。
 *  - 2 个字符的**拉丁**查询在 trigram 索引里通常零命中：`extractTrigrams`
 *    对非 CJK 且长度 ≥3 的名字只产 trigram，`bluehair` 只有 `blu/lue/ueh/…`，
 *    查询 `bl` 产出的 bigram 不在索引里。
 *  - 真正被挡住的是这一类：`normalize` 会**删掉**下划线，而
 *    `foldForCompletion` 把它折成**空格**，两者对词边界的看法因此会分歧。
 *    实测 `normalize('a_b') === 'ab'`（长度 2，于是索引里有 bigram `ab`），
 *    而 `foldForCompletion('a_b') === 'a b'`，词首键是 `['a ', 'b']`、没有
 *    `'ab'`。于是查 `ab` 时档 1 漏掉 `a_b`、档 2 却能给它打出 1.0 分。
 *    门槛关掉，短查询就会捞出这种「只因为归一化抹掉了词边界才成立」的匹配
 *    —— 用户打两个字母时并没打算要它。
 *  - 2 个字符含 CJK 则放行：`extractTrigrams` 的 `cjk || s.length < 3` 分支
 *    给 CJK 名字建了 bigram，命中是真命中。
 */
export function fullMatchEnabled(nq: string): boolean {
  return hasCjk(nq) ? nq.length >= 2 : nq.length >= 3
}

/**
 * 档 0/1 的预筛：从词首索引里取出可能命中的条目下标。
 *
 * 查询长度 ≥ `COMPLETION_KEY_LEN` 时一次 `get` 就够，但桶只保证**前两个
 * 字符**对得上，后面的还得让 `matchesAt` 校验（`bl` 的桶里有 `blue_hair`
 * 也有 `black_hair`，查 `blu` 时后者要被筛掉）。
 *
 * 查询更短时桶键本身比查询长，得把所有以查询开头的桶并起来。这一档**不需要
 * 校验**：桶键取自词首、且首字符就是查询本身，所以必然命中。并桶会撞同一个
 * 条目（一个条目的多个名字可能落在 `ba` 和 `bz` 两个桶里），用 Set 去重。
 */
function prefilterWordStart(cat: Category, fq: string): Iterable<number> {
  if (fq.length >= COMPLETION_KEY_LEN) {
    return cat.completionIndex.get(fq.slice(0, COMPLETION_KEY_LEN)) ?? []
  }
  const picked = new Set<number>()
  for (const [key, list] of cat.completionIndex) {
    if (!key.startsWith(fq)) continue
    for (const i of list) picked.add(i)
  }
  return picked
}

/**
 * 在 prefer 指定的那一类里取补全候选。
 *
 * 三档，档内规则不同：
 *
 *  | 档 | 是什么 | 来源 | 档内排序 | 何时可用 |
 *  |---|---|---|---|---|
 *  | 0 | exact | 折叠后等于查询 | 图数降序 | 总是 |
 *  | 1 | 词首命中 | 词首索引 + `matchesAt` | 图数降序 | 总是 |
 *  | 2 | 完整检索 | `getCandidates` + `matchEntry` ≥ 0.5 | 分数降序，同分图数 | 见 `fullMatchEnabled` |
 *
 * 档 2 是搬运来的检索逻辑，它内部的 `nt.includes(nq)` 分支能捞到**词中间**
 * 的子串 —— 查 `ress` 命中 `red_dress` / `sundress`，而词首档一个都给不了。
 * 短查询时档 2 关掉，理由见 `fullMatchEnabled`（**不是**「会全表扫」，那句
 * 对这份代码不成立）。
 *
 * **档 2 不提供拼写纠错**：`getCandidates` 先按 trigram 预筛，`bleu` 与
 * `bluehair` 的 trigram 集合交集为空，`calcSimilarity` 里的 Levenshtein
 * 段根本走不到。别在任何地方承诺纠错。
 *
 * **默认全量返回**。`limit` 只给测试与特殊调用方；渲染压力不在这一层解决
 * —— CodeMirror 的补全下拉只为可见项建 DOM。
 *
 * 只搜一类，不做跨类兜底：补全是高频操作，跨类会让 character 段里冒出
 * 画风词这种明显不对的候选。跨类兜底留给 LLM 的 search_tags（计划 3）。
 */
export function completeFrom(
  cats: TagdbCategories,
  query: string,
  prefer: CompletionPrefer,
  limit?: number,
): CompletionItem[] {
  const raw = query.trim()
  // 先折叠再 trim：'_' 会折成空格，折完才知道它其实是空查询。
  // raw 为空时 foldForCompletion('') 恒为 ''，下面这条判断已经兜住了，
  // 不必在这之前再单独判一次 raw
  const fq = foldForCompletion(raw).trim()
  if (fq.length === 0) return []

  const cat = cats[CATEGORY[prefer]]
  // 按条目下标存，天然去重：一个条目两档都命中时只保留先写进去的那档（更高档）
  const ranked = new Map<number, Ranked>()

  // ── 档 0 / 档 1：词首 ──
  const needVerify = fq.length >= COMPLETION_KEY_LEN
  for (const i of prefilterWordStart(cat, fq)) {
    const entry = cat.entries[i]
    if (entry === undefined) continue
    const folded = collectNames(entry).map(foldForCompletion)
    if (needVerify && !folded.some((n) => matchesAt(n, fq))) continue
    ranked.set(i, {
      item: toItem(entry),
      tier: folded.includes(fq) ? TIER_EXACT : TIER_WORD_START,
      score: 1,
    })
  }

  // ── 档 2：完整检索 ──
  // 传 raw 而不是 fq：getCandidates 与 matchEntry 自己会调 normalize，
  // 而 normalize 的规则（删符号）和 foldForCompletion（留符号）不一样。
  if (fullMatchEnabled(normalize(raw))) {
    for (const i of getCandidates(cat.index, raw) ?? []) {
      if (ranked.has(i)) continue // 已在更高档，不降档
      const entry = cat.entries[i]
      if (entry === undefined) continue
      const score = matchEntry(raw, entry).score
      if (score < FULL_MATCH_MIN_SCORE) continue
      ranked.set(i, { item: toItem(entry), tier: TIER_FULL_MATCH, score })
    }
  }

  const out = [...ranked.values()]
  out.sort((a, b) => a.tier - b.tier || b.score - a.score || b.item.count - a.item.count)
  const items = out.map((r) => r.item)
  return limit === undefined ? items : items.slice(0, limit)
}
