/**
 * 标签语义字典（gloss）、废弃标签表，以及「层 1」输入扫描注入。
 * 从 koishi-plugin-reforge 的 tag-gloss.ts 与 tag-inject.ts 搬运。
 *
 * 层 1 解决的问题：LLM 看到 deep_skin 认为自己认识（「深色皮肤」），因而不会调用
 * search_tags——「不知道自己不知道」靠 LLM 自觉治不好，只能由代码确定性拦截。
 * 防误报是第一要务：只扫描 tag 串上下文，绝不扫描自由文本。
 *
 * 本模块不读文件：读盘归 extras.ts。
 */

export interface GlossEntry {
  /** 中文精炼释义，硬上限 40 字 */
  g: string
  /** 字面误导提示。存在此字段者即 B 类，层 1 扫描命中时注入 */
  trap?: string
  /** A 类辨析对：[对立 tag, 一句话区别] */
  vs?: Array<[string, string]>
}

export type GlossDb = Map<string, GlossEntry>
export type DeprecatedDb = Map<string, string>

/** 归一化为查表键：小写 + 空白转下划线 + 去首尾空白。与 tags_index_v2 的 tag 形式一致 */
export function normalizeTagKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '_')
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * tag_gloss.json → GlossDb。逐项校验形状：插件只判了 `g`，`vs` 形状不对时
 * formatSearchResults 里的解构会抛错，一条坏条目不该让整次搜索失败。
 */
export function parseGlossDb(raw: unknown): GlossDb {
  const db: GlossDb = new Map()
  if (!isRecord(raw)) return db
  for (const [tag, entry] of Object.entries(raw)) {
    if (!isRecord(entry) || typeof entry.g !== 'string' || entry.g === '') continue
    const out: GlossEntry = { g: entry.g }
    if (typeof entry.trap === 'string' && entry.trap !== '') out.trap = entry.trap
    if (Array.isArray(entry.vs)) {
      const vs: Array<[string, string]> = []
      for (const pair of entry.vs) {
        if (Array.isArray(pair) && typeof pair[0] === 'string') {
          vs.push([pair[0], typeof pair[1] === 'string' ? pair[1] : ''])
        }
      }
      if (vs.length > 0) out.vs = vs
    }
    db.set(normalizeTagKey(tag), out)
  }
  return db
}

export function lookupGloss(db: GlossDb, tag: string): GlossEntry | undefined {
  return db.get(normalizeTagKey(tag))
}

/** tag_deprecated.json → DeprecatedDb。只收字符串理由 */
export function parseDeprecatedDb(raw: unknown): DeprecatedDb {
  const db: DeprecatedDb = new Map()
  if (!isRecord(raw)) return db
  for (const [tag, reason] of Object.entries(raw)) {
    if (typeof reason === 'string') db.set(normalizeTagKey(tag), reason)
  }
  return db
}

/** 单个片段是否像 tag：只含 ASCII 字母、数字、下划线、空格、连字符，且不超过 4 个词。 */
function looksLikeTag(seg: string): boolean {
  const s = seg.trim()
  if (!s || s.length > 40) return false
  if (!/^[a-zA-Z0-9_\-'. ]+$/.test(s)) return false
  return s.split(/\s+/).length <= 4
}

/**
 * 把文本切成候选 tag 片段。
 *
 * 只接受逗号/换行分隔的结构化列表——这正是 <现有参数> 块和 TAG 串的形态。
 * 若切分后「像 tag 的片段」占比过低，判定为自由文本，整体放弃扫描。
 *
 * 注意这里只是粗筛：最终是否注入取决于能否在 gloss 库里精确查到且带 trap，
 * 所以「A girl, standing on the beach」这种英文散句即便通过粗筛也查不出东西。
 */
function extractCandidates(text: string): string[] {
  if (!text || !text.trim()) return []

  // 先剥掉行首的「字段名: 」前缀。<现有参数> 块的形态是
  //   appearance: white hair, deep skin
  // 不剥的话 "appearance: white hair" 因含冒号而不像 tag，整块会被判成自由文本
  // ——而修改模式正是层 1 的主战场。
  const stripped = text.replace(/^[ \t]*[a-z_]{2,20}:[ \t]*/gim, '')

  const segs = stripped.split(/[,，\n]/).map(s => s.trim()).filter(Boolean)
  if (segs.length === 0) return []

  // 这里不为「只有一个片段」提前返回：整句没有逗号的中文
  //（"用 cowboy shot 的构图画一个少女"）也要能走到下面的 CJK 补捞。

  // 像 tag 的片段。无论整体是 TAG 串还是中文自然语言，都只取这些片段：
  // 中文片段本身不参与匹配，所以 belly/collar 那类常见词不会在中文语境里误报；
  // 而用户在中文描述里夹英文 tag（"画一个女孩，deep skin，微笑"）同样能被拦截。
  const tagLike = segs.filter(looksLikeTag)

  // 补一类：多词 tag 直接嵌在中文句子中间、没有逗号分隔的情形，
  // 例如「要有 deep skin 的效果」。这里从含 CJK 的片段里再捞一次。
  //
  // 只捞**多词**组合（含空格/下划线），单词 tag 一律不参与——这是防误报的关键：
  // belly / nude / comic / collar 这些单词在中文句子里出现时多半是别的意思，
  // 而 "deep skin" "cowboy shot" 这类组合出现在中文语境里几乎必然是 tag。
  const cjkSegs = segs.filter(s => /[\u4e00-\u9fff]/.test(s))
  for (const seg of cjkSegs) {
    const m = seg.match(/[a-zA-Z][a-zA-Z0-9_'-]*(?:[ _][a-zA-Z][a-zA-Z0-9_'-]*)+/g)
    if (m) tagLike.push(...m)
  }

  return tagLike
}

/**
 * 生成注入块。只注入「字面会读错的」（B 类，即带 trap 的条目）与废弃标签，
 * 普通标签不注入——否则一串 30 个 tag 的参数会让注入块比参数本身还长。
 *
 * @returns 注入块文本；无命中时返回 null
 */
export function buildInjectionBlock(
  text: string,
  glossDb: GlossDb,
  depDb: DeprecatedDb,
  maxItems = 20,
): string | null {
  const candidates = extractCandidates(text)
  if (candidates.length === 0) return null

  const lines: string[] = []
  const seen = new Set<string>()
  let hitTotal = 0

  for (const seg of candidates) {
    const key = normalizeTagKey(seg)
    if (seen.has(key)) continue

    const dep = depDb.get(key)
    const ge = lookupGloss(glossDb, key)
    const isTrap = !!ge?.trap
    if (!dep && !isTrap) continue

    seen.add(key)
    hitTotal++
    if (lines.length >= maxItems) continue

    if (dep) {
      lines.push(`- ${key} = 【已废弃】${dep}`)
    } else {
      lines.push(`- ${key} = ${ge!.g}（${ge!.trap}）`)
    }
  }

  if (lines.length === 0) return null

  const omitted = hitTotal - lines.length
  const tail = omitted > 0 ? `\n（另有 ${omitted} 条未列出）` : ''
  return [
    '<标签释义>',
    '以下标签的含义与字面不同，处理时以此为准：',
    ...lines,
    tail ? tail.trim() : '',
    '</标签释义>',
  ].filter(Boolean).join('\n')
}
