/**
 * 补全的匹配规则。**与检索算法（search.ts）是两套东西，不要混用。**
 *
 * 规则照抄 a1111-sd-webui-tagcomplete 的 `javascript/tagAutocomplete.js`
 * （1237-1259 行）：它的正则是 `(^|[^a-zA-Z])<escaped query>`，即**词首匹配**
 * —— 查询要么在字符串开头，要么紧跟一个非 ASCII 字母的字符。于是 `bl` 既命中
 * `blue_hair`（开头）也命中 `sky_blue`（`_` 不是字母），而 `ue` 谁也不命中。
 * CJK 查询下这条规则自然退化成任意位置子串，因为 CJK 字符本身就不是 a-z。
 *
 * 为什么不用 search.ts 那套：那是**解析器**，输入是 LLM 递来的完整查询串，
 * 输出是最匹配的规范 tag，短查询被主动拒绝（`calcSimilarity` 里的
 * `hasCjk(nq) ? nq.length >= 2 : nq.length >= 3`，旁边记着 `nq="W"` 返回
 * 168 万字符的事故）。补全是**过滤器**，用户还会继续打字，召回比精度重要，
 * 每次按键的成本才是约束。
 *
 * 两处有意偏离 tagcomplete，都是 1:1 字符映射、不改变长度与下标，因此不影响
 * 词首判定：
 *  1. 下划线折成空格 —— 让 `blue h` 能命中 `blue_hair`（tagcomplete 不能）；
 *  2. 沿用 search.ts 的 CJK 变体折叠 —— 让日文新字体输入能命中。
 *
 * 第三处偏离是判据本身：词首取「**字母与非字母之间的边界**」，而不是
 * tagcomplete 的「前一个字符不是字母」。差别只在 CJK 紧跟拉丁字母时 ——
 * `cos初音` 里 初 的前一个字符是 s（字母），按 tagcomplete 的判据这里不是
 * 词首，「初音」就查不到了。按边界判据则成立。实测代价是索引 posting 多 5%
 * （182.9 万 → 192.6 万）。
 *
 * 这里不用正则而用显式的位置扫描：查询词来自用户输入，走正则就得先转义，
 * 而且每次按键都要为一个新查询编译一个正则、对几十万个名字跑 `search()`。
 * 位置扫描能和索引共用同一套「可匹配位置」定义（见 `completionKeys`），
 * 预筛和校验因此保证同源。
 */
import { foldCjk } from './search'

/**
 * 索引键的长度。改这个数会改变补全索引的键——但索引是每次启动时从 JSON
 * 现建的，没有持久化缓存可言，改完重启一次就是全新索引。真到哪天索引被
 * 落盘缓存了，改这个数才需要连带让缓存失效。
 */
export const COMPLETION_KEY_LEN = 2

/**
 * 补全用的折叠：小写 + 下划线折成空格 + CJK 变体归一。
 *
 * **不删符号** —— 词首匹配靠符号定位词边界，删了就没有词首可言了。
 * 这是它和 search.ts 的 `normalize` 唯一的实质区别。
 */
export function foldForCompletion(s: string): string {
  return foldCjk(s.toLowerCase().replace(/_/g, ' '))
}

/** 是不是 ASCII 小写字母。词首判据只认这一类字符构成的「词」。 */
function isLatinLetter(ch: string): boolean {
  return ch >= 'a' && ch <= 'z'
}

/**
 * 折叠后字符串里所有可匹配位置的下标。一个下标是可匹配位置，当且仅当：
 *  - 它是 0，或者它前后跨了一道**字母/非字母的边界**；且
 *  - 它自己不是空白。
 *
 * 传入的必须是 `foldForCompletion` 的结果。
 *
 * 「边界」而不是「前一个字符不是字母」：后者会漏掉 CJK 紧跟拉丁字母的情形
 * （`cos初音` 里 初 的前一个字符是 s），「初音」就查不到了。
 *
 * 跳过空白是因为查询词进来前已经 `trim` 过，不可能以空白开头 —— 留着只会
 * 白占索引桶。注意这不影响「跨词查询」：`blue h` 是从下标 0 那个位置匹配
 * 整段 `blue hair` 的，不需要空格自己是个词首。
 */
export function matchStarts(folded: string): number[] {
  const out: number[] = []
  for (let i = 0; i < folded.length; i++) {
    if (/\s/.test(folded[i])) continue
    if (i === 0) {
      out.push(i)
      continue
    }
    if (!isLatinLetter(folded[i - 1]) || !isLatinLetter(folded[i])) out.push(i)
  }
  return out
}

/**
 * 折叠后的名字里，是否存在一个可匹配位置以折叠后的查询词开头。
 * 两个参数都必须是 `foldForCompletion` 的结果。
 */
export function matchesAt(folded: string, foldedQuery: string): boolean {
  if (foldedQuery.length === 0) return false
  for (const p of matchStarts(folded)) {
    if (folded.startsWith(foldedQuery, p)) return true
  }
  return false
}

/**
 * 这个折叠后的名字该进哪些索引桶：每个可匹配位置起的 `COMPLETION_KEY_LEN`
 * 个字符，去重。末尾不足长度时就取剩下的，这样单字符的名字也有键。
 *
 * 与 `matchesAt` 共用 `matchStarts`，所以索引键必然覆盖每一个可能的命中
 * 位置 —— 预筛不会静默丢候选。
 */
export function completionKeys(folded: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const p of matchStarts(folded)) {
    const key = folded.slice(p, p + COMPLETION_KEY_LEN)
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}
