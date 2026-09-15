/**
 * 标签分类浏览（browse_tags 的数据层）。从 koishi-plugin-reforge 的 tag-browse.ts 搬运。
 *
 * 解决的问题：字符串匹配对「从上往下看 → from_above」这类无能为力——
 * 用户的口语说法（4~7 字短句）与标签别名（2~3 字词典词）词汇空间不重叠，
 * 补别名治标不治本。
 *
 * 换成人的检索方式：先缩小到分类，再在小范围内靠语义挑选。
 * LLM 在「画面构成/构图与视角」这 200 条里选，几乎不会错。
 *
 * 本模块不读文件：读盘归 extras.ts，这里只收已经 JSON.parse 过的对象，好在 node 环境单测。
 */

export interface BrowseItem {
  t: string
  g: string
  c: number
  /**
   * keyword 的匹配面：标签名 + 中英日别名 + wiki 正文，构建期拼好（build-browse-index.py）。
   * 只用于匹配，从不回传给 LLM，所以它再长也不占 token。
   *
   * 有它才谈得上「中英混合检索」：可见内容是英文标签名 + 中文释义，
   * 英文关键词只够得着英文那半、中文关键词只够得着中文那半，两边都是半盲。
   * 老索引没有这个字段，回退到 t + g（行为等同改造前）。
   */
  m?: string
}
export interface BrowseToc { cat: string; n: number; top: string }
export interface BrowseDb {
  toc: BrowseToc[]
  cats: Map<string, BrowseItem[]>
}

/**
 * 单页字符预算。按字符切而不是按条数切，因为要控的本来就是 token：
 * 「物件/objects」一条平均 29 字符、「服装/attire-制服与戏服」一条平均 36 字符，
 * 固定条数会让两者的返回体量差出一半。
 *
 * 12000 字符 ≈ 7k token。102 个分类里九成能一次返完（中位数 52 条 / 约 1600 字符），
 * 只有 objects(957)、headwear(359) 这几个大类需要翻页。
 */
export const DEFAULT_PAGE_CHARS = 12000
/** 字符预算再紧也至少给这么多条，避免释义特别长的分类退化成一条一页。 */
const MIN_PAGE_ITEMS = 30

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 把 tag_browse.json 的内容整理成 BrowseDb。
 *
 * 插件直接把数组断言成 BrowseItem[]；这里逐条校验——缺 `g` 的条目会让
 * browseCategory 的 `i.g.length` 当场抛错，一条坏数据不该让整个工具失效。
 */
export function parseBrowseDb(raw: unknown): BrowseDb {
  const cats = new Map<string, BrowseItem[]>()
  if (!isRecord(raw)) return { toc: [], cats }
  for (const [key, value] of Object.entries(raw)) {
    if (key === '_toc' || !Array.isArray(value)) continue
    const items: BrowseItem[] = []
    for (const it of value) {
      if (!isRecord(it) || typeof it.t !== 'string' || typeof it.g !== 'string') continue
      const entry: BrowseItem = { t: it.t, g: it.g, c: typeof it.c === 'number' ? it.c : 0 }
      if (typeof it.m === 'string') entry.m = it.m
      items.push(entry)
    }
    cats.set(key, items)
  }
  const toc: BrowseToc[] = []
  if (Array.isArray(raw._toc)) {
    for (const x of raw._toc) {
      if (isRecord(x) && typeof x.cat === 'string' && typeof x.n === 'number' && typeof x.top === 'string') {
        toc.push({ cat: x.cat, n: x.n, top: x.top })
      }
    }
  }
  return { toc, cats }
}

/**
 * 渲染分类目录，供系统提示词常驻。
 *
 * 按一级分类分组、组内按条数降序。平铺 102 行的话 LLM 要扫完才知道有哪些大方向，
 * 分组后它先定方向再选二级，与「先缩小范围」的检索思路一致。
 *
 * 条数极少的分类（< minSize）折叠成一行：它们几乎不会被浏览，
 * 但每行都要付常驻 token。折叠后仍列出名字，需要时依然查得到。
 */
export function formatToc(db: BrowseDb, minSize = 20): string {
  if (db.toc.length === 0) return ''

  const groups = new Map<string, BrowseToc[]>()
  for (const x of db.toc) {
    const top = x.cat.split('/')[0]
    if (!groups.has(top)) groups.set(top, [])
    groups.get(top)!.push(x)
  }

  const lines: string[] = []
  for (const [top, items] of groups) {
    items.sort((a, b) => b.n - a.n)
    const big = items.filter(x => x.n >= minSize)
    const small = items.filter(x => x.n < minSize)
    lines.push(`**${top}**`)
    for (const x of big) {
      const sub = x.cat.split('/').slice(1).join('/')
      // 每类只列 2 个代表标签：目录是常驻成本，2 个足够定位方向
      const tags = x.top.split(',').slice(0, 2).map(t => t.trim()).join(', ')
      lines.push(`  ${sub}（${x.n}）${tags}`)
    }
    if (small.length > 0) {
      lines.push(`  小类：${small.map(x => `${x.cat.split('/').slice(1).join('/')}(${x.n})`).join('、')}`)
    }
  }

  return [
    '### 标签分类目录',
    '',
    'search_tags 没查准、或想不出该用哪个标签时，用 browse_tags 浏览对应分类，',
    '在小范围内看着中文释义自己挑。传参格式「一级/二级」，如 browse_tags(category="身体/面部与表情")。',
    '分类默认整类返回，超长的大类才分页（用 page 翻页）。',
    'keyword 只是把命中项提到最前，不会删掉其余条目，中文英文都能匹配'
      + '（直接用用户原话里的中文词即可，不必先译成英文）。它不替你筛选，仍要通读释义。',
    '',
    ...lines,
  ].join('\n')
}

/**
 * 浏览某个分类。
 *
 * 分类名做宽松匹配：LLM 可能写「面部与表情」而不是完整的「身体/面部与表情」，
 * 为这种小偏差返回"未找到"纯属浪费一轮调用。
 */
export function browseCategory(
  db: BrowseDb,
  category: string,
  keyword?: string,
  page = 1,
  pageChars = DEFAULT_PAGE_CHARS,
): string {
  const q = String(category || '').trim().toLowerCase()
  if (!q) return '请提供 category 参数。'

  let key = [...db.cats.keys()].find(k => k.toLowerCase() === q)
  if (!key) key = [...db.cats.keys()].find(k => k.toLowerCase().endsWith('/' + q))
  if (!key) key = [...db.cats.keys()].find(k => k.toLowerCase().includes(q))
  if (!key) {
    const near = db.toc.slice(0, 12).map(x => x.cat).join('、')
    return `未找到分类 "${category}"。请使用目录中的分类名，如：${near}`
  }

  const all = db.cats.get(key)!
  const kw = String(keyword || '').trim().toLowerCase()

  // keyword 只排序、不删除。
  //
  // 原来它是硬过滤，等于把 browse_tags 存在的理由又丢了一遍：可见内容是
  // 英文标签名 + 中文释义，英文关键词只够得着英文那半。查「cum」时 gokkun
  // （释义「吞精癖，角色正在或即将吞下精液」）没有一个英文字母，直接被滤掉——而它正是目标。
  //
  // 两道修法一起上：
  //   一、匹配面扩成双语（BrowseItem.m 含别名与 wiki），cum 现在能经
  //       en 别名 cum_drinking 与 wiki "A cum-swallowing fetish" 命中 gokkun；
  //   二、命中项只「提到最前面」，不再删掉其余条目。匹配面再全也仍有盲区
  //       （wiki 没提到的说法就是查不着），所以兜底必须是「不丢」。
  // 大分类翻页时，命中项因此必定落在第 1 页；没命中的照旧全部列出让 LLM 读释义。
  let items = all
  let hits = 0
  if (kw) {
    const hit: BrowseItem[] = []
    const rest: BrowseItem[] = []
    for (const i of all) {
      const field = i.m || (i.t + ' ' + i.g).toLowerCase()
      if (field.includes(kw)) hit.push(i)
      else rest.push(i)
    }
    hits = hit.length
    items = [...hit, ...rest]
  }

  const pages = splitByChars(items, pageChars)
  const totalPages = pages.length
  const p = Math.min(Math.max(1, Math.floor(page) || 1), totalPages)
  const slice = pages[p - 1]

  let head = `[分类] ${key}　共 ${items.length} 条`
    + (totalPages > 1 ? `　第 ${p}/${totalPages} 页` : '')
  if (kw) {
    head += hits > 0
      ? `\n[关键词 "${keyword}"] 字面命中 ${hits} 条，已排在最前；`
        + `其余条目照常全部列出，请按释义挑选。`
      : `\n[关键词 "${keyword}"] 字面无命中——中文释义与英文关键词本就常不重合，`
        + `这不代表分类里没有你要的标签，请直接看下面的释义挑选。`
  }
  const rows = slice.map(i => `  ${i.t} — ${i.g}`)
  const tail = p < totalPages
    ? `\n（还有 ${totalPages - p} 页，用 page=${p + 1} 继续。关键词命中项已全在本页，`
      + `翻页是为了看完整分类）`
    : ''
  return [head, ...rows].join('\n') + tail
}

/** 按字符预算把条目切成若干页，每页至少 MIN_PAGE_ITEMS 条。 */
function splitByChars(items: BrowseItem[], budget: number): BrowseItem[][] {
  const pages: BrowseItem[][] = []
  let cur: BrowseItem[] = []
  let n = 0
  for (const i of items) {
    const cost = i.t.length + i.g.length + 5
    if (cur.length >= MIN_PAGE_ITEMS && n + cost > budget) {
      pages.push(cur)
      cur = []
      n = 0
    }
    cur.push(i)
    n += cost
  }
  if (cur.length > 0) pages.push(cur)
  return pages.length > 0 ? pages : [[]]
}


/**
 * 对概念类的字面查询给出「改用 browse_tags」的提示，附在 search_tags 返回值里。
 *
 * 定位是**纠正工具选择**，不是补救低分：概念类本来就该先用 browse_tags，
 * 用了 search_tags 就是走错了路，哪怕这次侥幸查到高分。
 *
 * 为什么要在返回值里说而不只靠提示词：提示词说了 LLM 也未必照做——
 * web_search 就吃过这个亏（提示词写明了调用顺序，模型依然我行我素）。
 * 返回值是它必然会读的，确定性更高。
 */
export function buildBrowseHint(
  db: BrowseDb,
  queries: Array<{ q: string; score: number; type: string }>,
): string {
  if (db.toc.length === 0) return ''
  // 只对概念类提示：角色/画师/作品是专名，字面匹配正是它们的正确方式
  const concepts = queries.filter(x => x.type === '概念')
  if (concepts.length === 0) return ''

  const weak = concepts.filter(x => x.score < 0.9)
  const names = (weak.length > 0 ? weak : concepts)
    .map(x => `"${x.q}"(${x.score.toFixed(2)})`).slice(0, 6).join('、')

  if (weak.length > 0) {
    return `\n\n[工具选择提示] ${names} 匹配度不足 0.9，很可能没查准。`
      + `\n概念类（外貌/服装/动作/表情/构图/场景/光线）应当用 browse_tags 浏览分类挑选，`
      + `而不是字面搜索——中文口语与英文标签的字面常常毫不重合，换关键词重查通常也无效。`
      + `\n请从系统提示词的分类目录里选最贴近的分类，用 browse_tags 浏览后看释义挑。`
      + `\n若上面结果的释义确实吻合，可直接采用，无需浏览。`
  }
  return `\n\n[工具选择提示] 本次概念查询字面命中较好，可直接采用。`
    + `\n但下次遇到查不准的概念，请直接用 browse_tags 浏览分类挑选，不必反复换关键词重查。`
}
