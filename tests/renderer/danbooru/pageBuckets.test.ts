import { describe, expect, it } from 'vitest'
import { computePageBuckets } from '@renderer/danbooru/pageBuckets'

/** 固定返回值的假随机源：只用来验证「落在区间的哪一端」，不测真实分布 */
function fixedRandom(value: number): () => number {
  return () => value
}

describe('总页数计算', () => {
  it('ceil(post_count / limit)', () => {
    expect(computePageBuckets(100, 10, fixedRandom(0)).totalPages).toBe(10)
    // 21/10 除不尽，必须向上取整成 3，不能截断成 2
    expect(computePageBuckets(21, 10, fixedRandom(0)).totalPages).toBe(3)
  })

  it('limit 非正数时视为没有可用页（不能拿它当除数）', () => {
    expect(computePageBuckets(100, 0)).toEqual({ totalPages: 0, buckets: [], collapsed: false })
    expect(computePageBuckets(100, -5)).toEqual({ totalPages: 0, buckets: [], collapsed: false })
  })
})

describe('post_count 为 0 或缺失时的行为', () => {
  it('0、负数、null、undefined 都归一为「没有例图」，不返回三档', () => {
    const expected = { totalPages: 0, buckets: [], collapsed: false }
    expect(computePageBuckets(0, 10)).toEqual(expected)
    expect(computePageBuckets(-3, 10)).toEqual(expected)
    expect(computePageBuckets(null, 10)).toEqual(expected)
    expect(computePageBuckets(undefined, 10)).toEqual(expected)
  })
})

describe('三档边界（总页数 = 10，不退化）', () => {
  // post_count=100, limit=10 → totalPages=10；A=ceil(2)=2，B=ceil(6)=6
  // 新=[1,2] 中=[3,6] 旧=[7,10]
  it('随机源取 0 时，每档落在各自区间的下界', () => {
    const r = computePageBuckets(100, 10, fixedRandom(0))
    expect(r.collapsed).toBe(false)
    expect(r.buckets).toEqual([
      { kind: 'new', page: 1 },
      { kind: 'mid', page: 3 },
      { kind: 'old', page: 7 },
    ])
  })

  it('随机源趋近 1 时，每档落在各自区间的上界', () => {
    const r = computePageBuckets(100, 10, fixedRandom(0.999999))
    expect(r.buckets).toEqual([
      { kind: 'new', page: 2 },
      { kind: 'mid', page: 6 },
      { kind: 'old', page: 10 },
    ])
  })

  it('三档区间互不重叠，覆盖 1..总页数', () => {
    const r = computePageBuckets(100, 10, fixedRandom(0.5))
    for (const b of r.buckets) {
      expect(b.page).toBeGreaterThanOrEqual(1)
      expect(b.page).toBeLessThanOrEqual(10)
    }
  })
})

describe('page 上限 1000 的 clamp（匿名用户）', () => {
  // post_count=2000, limit=1 → totalPages=2000；A=ceil(400)=400，B=ceil(1200)=1200
  // 新=[1,400] 中=[401,1200] 旧=[1201,2000]——中、旧的区间都超过 1000
  it('中档落在区间上界（1200）时被 clamp 到 1000', () => {
    const r = computePageBuckets(2000, 1, fixedRandom(0.999999))
    const mid = r.buckets.find((b) => b.kind === 'mid')
    expect(mid?.page).toBe(1000)
  })

  it('旧档落在区间上界（2000）时被 clamp 到 1000', () => {
    const r = computePageBuckets(2000, 1, fixedRandom(0.999999))
    const old = r.buckets.find((b) => b.kind === 'old')
    expect(old?.page).toBe(1000)
  })

  it('未超过 1000 的页码不受 clamp 影响', () => {
    const r = computePageBuckets(2000, 1, fixedRandom(0))
    const newBucket = r.buckets.find((b) => b.kind === 'new')
    expect(newBucket?.page).toBe(1)
  })
})

describe('总页数很小时的退化（collapsed）', () => {
  it('总页数=1：三档区间全部退化为同一页，collapsed=true', () => {
    // post_count=5, limit=10 → totalPages=1
    const r = computePageBuckets(5, 10, fixedRandom(0.5))
    expect(r.totalPages).toBe(1)
    expect(r.collapsed).toBe(true)
    expect(r.buckets).toEqual([
      { kind: 'new', page: 1 },
      { kind: 'mid', page: 1 },
      { kind: 'old', page: 1 },
    ])
  })

  it('总页数=2：旧档区间为空，整体退化，按顺序取已存在的页', () => {
    // post_count=11, limit=10 → totalPages=2
    const r = computePageBuckets(11, 10, fixedRandom(0.5))
    expect(r.totalPages).toBe(2)
    expect(r.collapsed).toBe(true)
    expect(r.buckets).toEqual([
      { kind: 'new', page: 1 },
      { kind: 'mid', page: 2 },
      { kind: 'old', page: 2 }, // 只有 2 页可取，旧档复用最后一页而不是越界
    ])
  })

  it('总页数=3：三档恰好各占一页，不退化', () => {
    // post_count=21, limit=10 → totalPages=3
    const r = computePageBuckets(21, 10, fixedRandom(0.5))
    expect(r.totalPages).toBe(3)
    expect(r.collapsed).toBe(false)
    expect(r.buckets).toEqual([
      { kind: 'new', page: 1 },
      { kind: 'mid', page: 2 },
      { kind: 'old', page: 3 },
    ])
  })
})
