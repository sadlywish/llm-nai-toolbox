/**
 * 标签检索算法。从 koishi-plugin-reforge 的 tag-db.ts 搬运并裁剪。
 *
 * 三层优化（顺序不能调）：
 *  1. CJK 变体归一化 —— 繁体/日文新字体/异体字统一为简体；
 *  2. Trigram 倒排索引 —— 加载时构建，查询时预筛候选集；
 *  3. Levenshtein 编辑距离 —— 拼写纠错，弥补 bigram Jaccard 评分的断崖。
 *
 * ⚠️ 改 `normalize()` 会改变倒排索引的键——索引就建在 normalize 的结果上。
 * 今天这不构成风险：索引是加载时从 JSON 现建的，进程里没有任何持久化缓存，
 * 改完归一规则重启一次就是全新索引。这句话是留给以后的——如果哪天索引被
 * 落盘缓存，缓存必须跟着归一规则一起失效；在那之前，没有缓存可失效。
 *
 * 本模块**不读文件**：加载与索引构建归主进程（main/tagdb/loader.ts），
 * 这里只留纯函数，好在 node 环境单测。
 *
 * ⚠️ 这是个**解析器**，不是补全用的过滤器。它的输入是一个完整的查询串
 * （LLM 递来的「初音未来」），输出是最匹配的规范 tag，所以 `searchOne` 有
 * 「≥0.85 全给、0.5~0.85 只给最高一个、<0.5 不给」的收口，`calcSimilarity`
 * 有 `hasCjk(nq) ? nq.length >= 2 : nq.length >= 3` 这道门 —— 短查询是被
 * 主动拒绝的。**逐字补全不要用这里的任何打分函数**，它在 completionMatch.ts。
 */

// ─── CJK 变体映射 ──────────────────────────────────────────
// 紧凑编码："源字目标字源字目标字..." — 日文新字体/繁体 → 简体
// 由 gen_cjk_map.py 从 tags_enriched_v2.json 实际出现的字符生成
const CJK_VARIANT_PAIRS =
  '戦战絵绘桜樱剣剑沢泽様样竜龙鉄铁気气焼烧転转悪恶霊灵氷冰浜滨撃击歩步弾弹糸丝戯戏辺边隠隐対对広广変变図图薬药雑杂壊坏歳岁総总弁辩栄荣脳脑縁缘麺面覚觉豊丰軽轻芸艺涙泪蛍萤帰归駅驿継继駆驱錬炼黙默砕碎専专拡扩齢龄権权譲让択择歴历摂摄猟猎営営挙举賛赞悩恼訳译従从厳严聴听拠据庁厅顕显' +
  '吒咤乾干'

const cjkMap = new Map<string, string>()
for (let i = 0; i < CJK_VARIANT_PAIRS.length; i += 2) {
  cjkMap.set(CJK_VARIANT_PAIRS[i], CJK_VARIANT_PAIRS[i + 1])
}

// ─── 数据结构 ─────────────────────────────────────────────────

export interface TagEntry {
  tag: string
  count: number
  zh: string[]
  zhFull: string[]   // 完整译名（如"初音未来"）
  zhShort: string[]  // 缩写名（如"未来"）
  zhNick: string[]   // 昵称（如"呆毛王"）
  ja: string[]
  en: string[]
  other: string[]
  series: string[]
}

/** Trigram 倒排索引 */
export interface TagIndex {
  trigrams: Map<string, number[]>
  entries: TagEntry[]
}

// ─── Trigram 索引构建 ────────────────────────────────────────

/**
 * 提取 n-grams 用于倒排索引。
 * CJK 文本额外提取 bigrams — 中文每字信息量高，bigram 足以区分，
 * 且能匹配 2 字短名（如"绝望"）与 3+ 字查询（如"绝望眼"）之间的交集。
 */
function extractTrigrams(s: string): string[] {
  if (s.length === 0) return []
  if (s.length === 1) return [s]

  const result: string[] = []
  const cjk = hasCjk(s)

  // CJK 文本和极短串：提取 bigrams
  if (cjk || s.length < 3) {
    for (let i = 0; i <= s.length - 2; i++) {
      result.push(s.substring(i, i + 2))
    }
  }

  // 长度 >= 3 时额外提取 trigrams
  if (s.length >= 3) {
    for (let i = 0; i <= s.length - 3; i++) {
      result.push(s.substring(i, i + 3))
    }
  }

  return result
}

/**
 * 收集条目所有可搜索名称，供打分与建索引共用。
 * 导出：Task 4 建补全索引时要枚举「一个条目的所有名字」。
 */
export function collectNames(entry: TagEntry): string[] {
  const names: string[] = [entry.tag]
  for (const arr of [entry.zh, entry.zhFull, entry.zhShort, entry.zhNick,
                      entry.ja, entry.en, entry.other]) {
    for (const name of arr) {
      if (name) names.push(name)
    }
  }
  return names
}

/** 构建 trigram 倒排索引 */
export function buildIndex(entries: TagEntry[]): TagIndex {
  const trigrams = new Map<string, number[]>()

  for (let i = 0; i < entries.length; i++) {
    const names = collectNames(entries[i])
    const seen = new Set<string>()

    for (const name of names) {
      const normalized = normalize(name)
      for (const tri of extractTrigrams(normalized)) {
        if (seen.has(tri)) continue
        seen.add(tri)
        let list = trigrams.get(tri)
        if (!list) {
          list = []
          trigrams.set(tri, list)
        }
        list.push(i)
      }
    }
  }

  return { trigrams, entries }
}

/**
 * 从索引中检索候选条目索引。
 * 导出：Task 5 的档 2（trigram 倒排那档）直接复用这套预筛。
 */
export function getCandidates(index: TagIndex, query: string): number[] | null {
  const nq = normalize(query)
  if (nq.length <= 1) return null // 极短查询回退线性扫描

  const queryTrigrams = extractTrigrams(nq)
  if (queryTrigrams.length === 0) return null

  const counts = new Map<number, number>()
  for (const tri of queryTrigrams) {
    const indices = index.trigrams.get(tri)
    if (!indices) continue
    for (const idx of indices) {
      counts.set(idx, (counts.get(idx) || 0) + 1)
    }
  }

  // 阈值：至少命中 20% 的 query trigrams（最少 1 个）
  const threshold = Math.max(1, Math.ceil(queryTrigrams.length * 0.2))
  const candidates: number[] = []
  for (const [idx, count] of counts) {
    if (count >= threshold) candidates.push(idx)
  }

  return candidates
}

// ─── 匹配算法 ────────────────────────────────────────────────

/**
 * CJK 变体折叠：日文新字体 / 异体字统一成简体。
 *
 * 1:1 字符映射，**不改变字符串长度，也不改变任何字符的下标**。补全的词首
 * 匹配依赖这个性质 —— 折叠后位置还对得上，才能拿折叠结果直接做词边界判定。
 *
 * 映射表 `CJK_VARIANT_PAIRS` 是由脚本从真实数据里出现过的字符生成的，
 * 覆盖的是日文新字体（絵→绘、桜→樱、気→气……），**不是通用繁简表**：
 * 「藍」「髮」「來」这些常见繁体字不在表里。扩表会改变两份索引的键，
 * 但两份索引都是加载时从 JSON 现建、没有持久化缓存——今天没有缓存要失效，
 * 只有哪天真的把索引落盘缓存了，扩表才需要连带让缓存失效。
 */
export function foldCjk(s: string): string {
  let result = ''
  for (const ch of s) {
    result += cjkMap.get(ch) ?? ch
  }
  return result
}

export function normalize(s: string): string {
  return foldCjk(s.toLowerCase().replace(/[\s_\-()（）【】\[\]·・、。，]/g, ''))
}

/** 生成 bigram 集合 */
function bigrams(s: string): Set<string> {
  const result = new Set<string>()
  for (let i = 0; i < s.length - 1; i++) {
    result.add(s.substring(i, i + 2))
  }
  return result
}

/**
 * Levenshtein 编辑距离（单行 DP + 早期终止）
 * 超过 maxDist 时返回 -1
 */
function levenshtein(a: string, b: string, maxDist: number): number {
  const m = a.length
  const n = b.length
  if (Math.abs(m - n) > maxDist) return -1

  // 确保 b 是较短串以节省空间
  let short_ = b, long_ = a
  if (m < n) { short_ = a; long_ = b }
  const sLen = short_.length
  const lLen = long_.length

  const row = new Array<number>(sLen + 1)
  for (let j = 0; j <= sLen; j++) row[j] = j

  for (let i = 1; i <= lLen; i++) {
    let prevDiag = row[0]
    row[0] = i
    let rowMin = row[0]
    for (let j = 1; j <= sLen; j++) {
      const temp = row[j]
      if (long_[i - 1] === short_[j - 1]) {
        row[j] = prevDiag
      } else {
        row[j] = 1 + Math.min(prevDiag, row[j], row[j - 1])
      }
      prevDiag = temp
      if (row[j] < rowMin) rowMin = row[j]
    }
    if (rowMin > maxDist) return -1
  }

  return row[sLen] <= maxDist ? row[sLen] : -1
}

function calcSimilarity(query: string, target: string): number {
  const nq = normalize(query)
  const nt = normalize(target)
  if (!nq || !nt) return 0

  // 精确匹配
  if (nq === nt) return 1.0

  // 包含匹配，两个方向的语义不同，公式也不同：
  //
  // ① 目标包含查询（nt ⊇ nq）：查到的是**更具体的变体**。
  //    如查 rice_shower 命中 rice_shower_(umamusume)。这类应保持高分——
  //    用户查得笼统而库里有细分版本，全都该返回供其挑选。基数 0.9 不动。
  //
  // ② 查询包含目标（nq ⊇ nt）：查到的是**更笼统的上位词**。
  //    如查「蒸汽身体」命中「蒸汽」(steam)。这类要看覆盖率：
  //    同时命中的「蒸汽体」(3/4) 比「蒸汽」(2/4) 匹配得完整，分数必须拉开，
  //    否则泛义短标签(steam/clothes/tongue)会盖过精确的长标签。
  //    系数从 0.1 提到 0.3，让 3/4 与 2/4 的差距从 0.025 扩大到 0.075。
  //
  // 但「包含」要成立得有分量。查询太短、或只占目标一小截时，命中是巧合不是变体：
  // 实测 nq="W" 时库里 6819 个角色标签只要含字母 w 就全拿到 0.9+，
  // 单次 search_tags 因此返回 168 万字符，直接把 100 万 token 的上下文撑爆。
  // 不够分量的就别给「变体」待遇，往下走通用判据自然会得低分。
  if (nt.includes(nq)) {
    const cover = nq.length / nt.length
    // CJK 单字信息量大（「湿」），拉丁字母单字基本是噪声，所以门槛不同
    const enough = hasCjk(nq) ? nq.length >= 2 : nq.length >= 3
    if (enough && cover >= 0.15) return 0.9 + 0.1 * cover
  } else if (nq.includes(nt)) {
    return 0.6 + 0.3 * (nt.length / nq.length)
  }

  const maxLen = Math.max(nq.length, nt.length)
  const cjk = hasCjk(nq) || hasCjk(nt)

  // Levenshtein 编辑距离。
  // **只对非 CJK 启用**：英文里改 1~2 个字母多半是拼写错误，中文里改 1 个字
  // 就是另一个概念——「湿衣服」vs「脏衣服」编辑距离 1，本会拿 0.867 的高分，
  // 与真正同义的「湿衣」同分，正确答案因此排不到前面。
  if (!cjk && Math.abs(nq.length - nt.length) <= 2 && maxLen >= 3) {
    const maxDist = Math.min(2, Math.ceil(maxLen * 0.3))
    const dist = levenshtein(nq, nt, maxDist)
    if (dist >= 0) {
      const editScore = 1.0 - (dist / maxLen) * 0.4
      if (editScore > 0.65) return editScore
    }
  }

  // 字集合 Jaccard。中文的信息在「用了哪些字」而非字序：
  // 「舌头上的精液」与「精液在舌头上」同义，bigram 只给 0.43（语序不同被重罚），
  // 字集合给 0.71。这一维专治中文的语序灵活性。
  let charJaccard = 0
  if (cjk) {
    const cq = new Set([...nq])
    const ct = new Set([...nt])
    let ci = 0
    for (const c of cq) { if (ct.has(c)) ci++ }
    charJaccard = ci / (cq.size + ct.size - ci)
  }

  // Bigram Jaccard 相似度（保留字序信息，与字集合互补）
  const bq = bigrams(nq)
  const bt = bigrams(nt)
  let bigramJaccard = 0
  if (bq.size > 0 && bt.size > 0) {
    let intersection = 0
    for (const b of bq) { if (bt.has(b)) intersection++ }
    bigramJaccard = intersection / new Set([...bq, ...bt]).size
  }

  if (cjk) {
    // 两维取加权：字集合为主（管同义换序），bigram 为辅（管字序）。
    // 上限 0.84 —— 压在 0.85 采信线之下，这类模糊匹配必须由 LLM 看释义定夺，
    // 不能像编辑距离那样直接拿 0.867 冒充高置信。
    const combined = charJaccard * 0.7 + bigramJaccard * 0.3
    return Math.min(0.84, combined * 1.15)
  }
  if (bq.size > 0 && bt.size > 0) return bigramJaccard * 0.65

  // 单字符 Jaccard（极短字符串）
  const sq = new Set([...nq])
  const st = new Set([...nt])
  let inter = 0
  for (const c of sq) { if (st.has(c)) inter++ }
  const union = new Set([...sq, ...st]).size
  return (inter / union) * 0.5
}

/** 检测字符串是否包含 CJK 字符 */
export function hasCjk(s: string): boolean {
  for (const c of s) {
    const code = c.charCodeAt(0)
    if ((code >= 0x4E00 && code <= 0x9FFF) || // CJK 统一汉字
        (code >= 0x3040 && code <= 0x30FF))    // 平假名 + 片假名
      return true
  }
  return false
}

/** 对一个条目的所有名称匹配，返回最高分和匹配来源 */
export function matchEntry(query: string, entry: TagEntry): { score: number; field: string } {
  let best = calcSimilarity(query, entry.tag)
  let bestField = 'tag'

  // 结构化 zh 评分：zhFull/zhShort/zhNick 按名称长度和类型差异化加权
  const hasStructured = entry.zhFull.length > 0 || entry.zhShort.length > 0 || entry.zhNick.length > 0

  if (hasStructured) {
    // 完整译名：按长度递减加分（短名歧义高）
    for (const name of entry.zhFull) {
      const s = calcSimilarity(query, name)
      let adjusted: number
      if (!hasCjk(name)) {
        adjusted = s // 非CJK名不加权
      } else if (name.length === 1) {
        adjusted = Math.max(s - 0.03, 0)   // 1字完整名高度歧义
      } else if (name.length === 2) {
        adjusted = Math.min(s + 0.01, 1.0)  // 2字完整名轻度歧义
      } else {
        adjusted = Math.min(s + 0.02, 1.0)  // 3+字可靠
      }
      if (adjusted > best) { best = adjusted; bestField = 'zhFull' }
    }

    // 缩写名：按长度施加歧义惩罚
    for (const name of entry.zhShort) {
      const s = calcSimilarity(query, name)
      let adjusted: number
      if (!hasCjk(name)) {
        adjusted = s // 非CJK名不加权
      } else if (name.length === 1) {
        adjusted = Math.max(s - 0.15, 0)    // 1字极度歧义
      } else if (name.length === 2) {
        adjusted = Math.max(s - 0.05, 0)    // 2字中度歧义
      } else if (name.length === 3) {
        adjusted = Math.max(s - 0.02, 0)    // 3字轻度歧义
      } else {
        adjusted = s
      }
      if (adjusted > best) { best = adjusted; bestField = 'zhShort' }
    }

    // 昵称：-0.01 微调（非正式名称），非CJK不加权
    for (const name of entry.zhNick) {
      const s = calcSimilarity(query, name)
      const adjusted = hasCjk(name) ? Math.max(s - 0.01, 0) : s
      if (adjusted > best) { best = adjusted; bestField = 'zhNick' }
    }

    // 兜底：zh 数组中可能包含未归入结构化字段的别名（如日文汉字）
    const structured = new Set([...entry.zhFull, ...entry.zhShort, ...entry.zhNick])
    for (const name of entry.zh) {
      if (structured.has(name)) continue
      const s = calcSimilarity(query, name)
      if (s > best) { best = s; bestField = 'zh' }
    }
  } else {
    // 无结构化数据时回退到平铺 zh 数组
    for (const name of entry.zh) {
      const s = calcSimilarity(query, name)
      if (s > best) { best = s; bestField = 'zh' }
    }
  }

  // ja / en / other 字段
  const fields: Array<[string, string[]]> = [
    ['ja', entry.ja], ['en', entry.en], ['other', entry.other],
  ]
  for (const [field, arr] of fields) {
    for (const name of arr) {
      const s = calcSimilarity(query, name)
      if (s > best) { best = s; bestField = field }
    }
  }

  // tag 名是最权威标识，匹配到 tag 本身时加分
  if (bestField === 'tag' && best > 0 && best < 1.0) {
    best = Math.min(best + 0.03, 1.0)
  }

  return { score: best, field: bestField }
}

// ─── 搜索 ─────────────────────────────────────────────────────

export interface SearchMatch {
  tag: string
  score: number
  count: number
  zh: string[]
  series: string[]
  wiki: string
}

/**
 * 查询类别。
 *
 * 「作品」独立成一类而不是并进「概念」：series 本来就是单独的库、单独的倒排索引，
 * 只是过去没有查询入口，仅在跨类兜底和角色消歧时被动用到。
 * 并进概念会让作品名混进通用标签的候选里，把普通概念词的排序搅乱。
 */
export type SearchType = '画师' | '角色' | '概念' | '作品'

export interface SearchResult {
  query: string
  type: SearchType
  matches: SearchMatch[]
}

function searchOne(
  entries: TagEntry[], query: string, type: SearchType,
  index?: TagIndex, wikiMap?: Map<string, string>,
): SearchResult {
  const scored: Array<{ entry: TagEntry; score: number }> = []

  const candidates = index ? getCandidates(index, query) : null

  if (candidates !== null) {
    for (const idx of candidates) {
      const entry = entries[idx]
      const { score } = matchEntry(query, entry)
      if (score >= 0.5) {
        scored.push({ entry, score: Math.round(score * 100) / 100 })
      }
    }
  } else {
    for (const entry of entries) {
      const { score } = matchEntry(query, entry)
      if (score >= 0.5) {
        scored.push({ entry, score: Math.round(score * 100) / 100 })
      }
    }
  }

  // 短查询加大 count 权重和阈值，帮助消歧
  const nqLen = normalize(query).length
  const countWeight = nqLen <= 2 ? 0.05 : 0.03
  const scoreThreshold = 0.10 + Math.max(0, 3 - nqLen) * 0.03 // 1字=0.16, 2字=0.13, 3+=0.10

  // 分差大时纯按分排序，分差小时混合 count 权重
  scored.sort((a, b) => {
    const diff = b.score - a.score
    if (Math.abs(diff) >= scoreThreshold) return diff
    const wa = b.score + Math.log10(b.entry.count + 1) * countWeight
    const wb = a.score + Math.log10(a.entry.count + 1) * countWeight
    return wa - wb
  })

  // 返回规则：
  // >= 0.85 全部返回
  // 0.5 ~ 0.85 仅返回最高1个
  // < 0.5 不返回
  let matches: SearchMatch[]
  const highScoreItems = scored.filter(s => s.score >= 0.85)

  if (highScoreItems.length > 0) {
    matches = highScoreItems.map(s => toMatch(s.entry, s.score, wikiMap))
  } else if (scored.length > 0) {
    matches = [toMatch(scored[0].entry, scored[0].score, wikiMap)]
  } else {
    matches = []
  }

  return { query, type, matches }
}

function toMatch(entry: TagEntry, score: number, wikiMap?: Map<string, string>): SearchMatch {
  return {
    tag: entry.tag,
    score,
    count: entry.count,
    zh: entry.zh,
    series: entry.series,
    // 原样带出；wiki 文本截不截、截多长是调用方（LLM 工具层）的事，这里不管
    wiki: wikiMap?.get(entry.tag) || '',
  }
}

/** 搜索单个类别（供外部降级逻辑使用） */
export function searchCategory(
  entries: TagEntry[], query: string, type: SearchType,
  index?: TagIndex, wikiMap?: Map<string, string>,
): SearchResult {
  return searchOne(entries, query, type, index, wikiMap)
}
