/** 魔法书的数据形状（规格 docs/superpowers/specs/2026-09-15-magicbook-design.md §3）。主进程与渲染进程共用 */

/** 命中列表最多列这么多条；总数照算，列表底部提示还剩多少 */
export const MAGIC_SEARCH_LIMIT = 500

export interface MagicGroup {
  /** 一级分类名，如「头发」 */
  top: string
  /** 该组标签总数 */
  n: number
  /** 二级分类，按条数从多到少；cat 是完整键「一级/二级」，sub 是「/」后面那段 */
  subs: { cat: string; sub: string; n: number }[]
}

export interface MagicItem {
  /** 标签名（下划线形式，与 tag_browse.json 一致） */
  t: string
  /** 中文释义 */
  g: string
  /** 帖子数 */
  c: number
  /** 所属分类的完整键「一级/二级」 */
  cat: string
  /** gloss 里有字面误导提示 */
  trap: boolean
  /** gloss 里有辨析对 */
  vs: boolean
}

export interface MagicSearch {
  /** 全部命中条数（不受 limit 影响） */
  total: number
  /** 每个分类的命中数（按全部命中计） */
  byCat: Record<string, number>
  /** 排好序的命中，最多 limit 条 */
  items: MagicItem[]
}

/** 工具附带的中文说明（tag_gloss.json 一条 + 所属分类） */
export interface TagGloss {
  g: string
  trap?: string
  vs?: [string, string][]
  /** 在 tag_browse.json 里的分类；不在分类数据里时没有 */
  cat?: string
}
