/**
 * 例图表的新/中/旧分档（spec §13.1）。
 *
 * 三档各自对应 posts.json 的一个页码，从该页随机抽取的位置代表「早期/中期/
 * 近期」画风——页码越大代表越旧（Danbooru 按上传时间倒序分页）。这是本任务
 * 唯一有明确对错的逻辑，独立成纯函数是为了能注入随机源与直接单测边界。
 *
 * 边界算法：spec 明确「新」档用 [1, ceil(总页数 × 0.2)]，「中」「旧」只给了
 * 实数区间 (总页数 × 0.2, 总页数 × 0.6]、(总页数 × 0.6, 总页数]，没规定取整
 * 方式。这里让三档首尾相接、互不重叠、也不留空隙——中/旧的下界紧跟在
 * 上一档的上界之后（而不是各自独立套用 floor/ceil），换算下来是：
 *
 *   A = ceil(总页数 × 0.2)   新 = [1, A]
 *   B = ceil(总页数 × 0.6)   中 = [A+1, B]，旧 = [B+1, 总页数]
 *
 * 代价是「中」档的上界可能比总页数 × 0.6 本身略大（至多一页）——总页数很小
 * 时这点误差换来的是一套没有重叠、也不会出现空区间的整数分档，比追求实数
 * 边界的字面精确更重要：分档存在的意义是让用户粗略感知早中近期画风，
 * 不是要对齐到小数点后的页码。
 */

export type PageBucketKind = 'new' | 'mid' | 'old'

/** 匿名用户能查询到的 page 上限；超过这个值 Danbooru 会拒绝或返回空结果 */
const ANONYMOUS_PAGE_LIMIT = 1000

const NEW_RATIO = 0.2
const MID_RATIO = 0.6

const BUCKET_KINDS: readonly PageBucketKind[] = ['new', 'mid', 'old']

export interface PageBucket {
  kind: PageBucketKind
  /** 最终用于 posts.json 的页码，已按匿名上限 1000 clamp */
  page: number
}

export interface PageBucketsResult {
  totalPages: number
  buckets: PageBucket[]
  /**
   * 总页数太小、三档区间退化（出现空区间）时为 true。界面必须据此标注——
   * 不标注的话，用户会拿着三行其实来自同一页的图，误以为看到了三个不同
   * 年代的画风（spec §13.1 明确要求标注这一点）。
   */
  collapsed: boolean
}

interface Range {
  lo: number
  hi: number
}

function isEmpty(r: Range): boolean {
  return r.lo > r.hi
}

/** 给定总页数，算出三档各自的候选区间（未处理退化情形） */
function bucketRanges(totalPages: number): Record<PageBucketKind, Range> {
  const a = Math.ceil(totalPages * NEW_RATIO)
  const b = Math.ceil(totalPages * MID_RATIO)
  return {
    new: { lo: 1, hi: Math.min(a, totalPages) },
    mid: { lo: a + 1, hi: Math.min(b, totalPages) },
    old: { lo: b + 1, hi: totalPages },
  }
}

/**
 * 例图表的新/中/旧分档。
 *
 * @param postCount 该 tag 的用图数（来自补全结果或 tags.json）；0、负数、
 *   非有限数、null/undefined 一律视为「没有例图」
 * @param limit 每页条数，须与实际调用 posts.json 时用的 limit 一致——
 *   总页数是拿它反推出来的，两处 limit 不一致会让页码和实际内容对不上
 * @param random 随机源，返回 [0, 1)；默认 Math.random，测试注入固定值
 *   即可断言「落在哪个区间」
 */
export function computePageBuckets(
  postCount: number | null | undefined,
  limit: number,
  random: () => number = Math.random,
): PageBucketsResult {
  const count = typeof postCount === 'number' && Number.isFinite(postCount) ? postCount : 0
  if (count <= 0 || !Number.isFinite(limit) || limit <= 0) {
    return { totalPages: 0, buckets: [], collapsed: false }
  }

  const totalPages = Math.ceil(count / limit)
  const ranges = bucketRanges(totalPages)
  const collapsed = BUCKET_KINDS.some((k) => isEmpty(ranges[k]))

  const buckets = BUCKET_KINDS.map((kind, i) => {
    let page: number
    if (collapsed) {
      // 退化为「有几页取几页」：按顺序取已存在的页，页数不够三个时
      // 后面的档复用最后一页，而不是往区间外随机出一个不存在的页码
      page = Math.min(i + 1, totalPages)
    } else {
      const { lo, hi } = ranges[kind]
      page = lo + Math.floor(random() * (hi - lo + 1))
    }
    return { kind, page: Math.min(page, ANONYMOUS_PAGE_LIMIT) }
  })

  return { totalPages, buckets, collapsed }
}
