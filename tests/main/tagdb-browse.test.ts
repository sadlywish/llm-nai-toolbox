import { describe, expect, it } from 'vitest'
import {
  browseCategory,
  buildBrowseHint,
  formatToc,
  parseBrowseDb,
  type BrowseItem,
} from '../../src/main/tagdb/browse'

const item = (t: string, g: string, c = 1, m?: string): BrowseItem =>
  m === undefined ? { t, g, c } : { t, g, c, m }

describe('parseBrowseDb', () => {
  it('_toc 不当分类；不是数组的值忽略；缺 t 或 g 的条目丢掉', () => {
    const db = parseBrowseDb({
      _toc: [{ cat: '身体/face tags', n: 2, top: 'smile, blush' }, { cat: 3 }],
      '身体/face tags': [{ t: 'smile', g: '微笑', c: 10 }, { t: 'blush' }, 'x'],
      broken: { t: 'a' },
    })
    expect([...db.cats.keys()]).toEqual(['身体/face tags'])
    expect(db.cats.get('身体/face tags')).toEqual([{ t: 'smile', g: '微笑', c: 10 }])
    expect(db.toc).toEqual([{ cat: '身体/face tags', n: 2, top: 'smile, blush' }])
  })

  it('m 是字符串才收', () => {
    const db = parseBrowseDb({ a: [{ t: 'x', g: 'y', c: 1, m: 'x y 别名' }, { t: 'z', g: 'w', c: 1, m: 3 }] })
    expect(db.cats.get('a')).toEqual([{ t: 'x', g: 'y', c: 1, m: 'x y 别名' }, { t: 'z', g: 'w', c: 1 }])
  })

  it('不是对象时给空库', () => {
    const db = parseBrowseDb([1, 2])
    expect(db.toc).toEqual([])
    expect(db.cats.size).toBe(0)
  })
})

describe('formatToc', () => {
  const db = parseBrowseDb({
    _toc: [
      { cat: '身体/face tags', n: 30, top: 'smile, blush, open mouth' },
      { cat: '身体/hands', n: 50, top: 'holding, waving' },
      { cat: '身体/nails', n: 5, top: 'nail polish' },
      { cat: '画面构成/image composition', n: 200, top: 'solo, from above' },
    ],
  })
  const text = formatToc(db)

  it('按一级分类分组、组内按条数降序，每类只列 2 个代表标签', () => {
    expect(text).toContain('**身体**\n  hands（50）holding, waving\n  face tags（30）smile, blush\n')
    expect(text).not.toContain('open mouth')
  })

  it('条数少于 20 的折叠成一行小类', () => {
    expect(text).toContain('  小类：nails(5)')
  })

  it('目录为空时返回空串', () => {
    expect(formatToc(parseBrowseDb({}))).toBe('')
  })
})

describe('browseCategory', () => {
  const faceItems = Array.from({ length: 40 }, (_, i) => item(`tag_${i}`, `释义${i}`))
  const db = parseBrowseDb({
    _toc: [{ cat: '身体/face tags', n: 40, top: 'tag_0' }],
    '身体/face tags': faceItems,
    '服装/attire-tops': [item('shirt', '衬衫', 5, 'shirt 衬衫 シャツ'), item('jacket', '夹克', 3)],
  })

  it('分类名宽松匹配：全名、只写二级、包含', () => {
    expect(browseCategory(db, '身体/face tags')).toContain('[分类] 身体/face tags')
    expect(browseCategory(db, 'face tags')).toContain('[分类] 身体/face tags')
    expect(browseCategory(db, 'tops')).toContain('[分类] 服装/attire-tops')
  })

  it('找不到分类时列出目录里的分类名', () => {
    expect(browseCategory(db, '不存在')).toBe('未找到分类 "不存在"。请使用目录中的分类名，如：身体/face tags')
  })

  it('keyword 只把命中项提到最前，不删掉其余条目', () => {
    const lines = browseCategory(db, 'tops', '夹克').split('\n')
    expect(lines[1]).toContain('字面命中 1 条')
    expect(lines[2]).toBe('  jacket — 夹克')
    expect(lines[3]).toBe('  shirt — 衬衫')
  })

  it('keyword 的匹配面优先用 m（别名与 wiki）', () => {
    const lines = browseCategory(db, 'tops', 'シャツ').split('\n')
    expect(lines[1]).toContain('字面命中 1 条')
    expect(lines[2]).toBe('  shirt — 衬衫')
  })

  it('keyword 无命中时照常全部列出并说明', () => {
    const text = browseCategory(db, 'tops', 'xyz')
    expect(text).toContain('字面无命中')
    expect(text).toContain('  shirt — 衬衫')
    expect(text).toContain('  jacket — 夹克')
  })

  it('按字符预算分页，每页至少 30 条；页码越界收到最后一页', () => {
    const p1 = browseCategory(db, 'face tags', undefined, 1, 300)
    expect(p1).toContain('共 40 条　第 1/2 页')
    expect(p1.split('\n').filter((l) => l.startsWith('  tag_'))).toHaveLength(30)
    expect(p1).toContain('用 page=2 继续')
    const p2 = browseCategory(db, 'face tags', undefined, 99, 300)
    expect(p2).toContain('第 2/2 页')
    expect(p2).toContain('  tag_39 — 释义39')
    expect(p2).not.toContain('继续')
  })
})

describe('buildBrowseHint', () => {
  const db = parseBrowseDb({ _toc: [{ cat: 'a/b', n: 1, top: 'x' }], 'a/b': [item('x', 'y')] })

  it('没有概念类查询时不提示', () => {
    expect(buildBrowseHint(db, [{ q: '初音', score: 0.5, type: '角色' }])).toBe('')
  })

  it('概念类有低于 0.9 的：只点名低分的，建议改用 browse_tags', () => {
    const t = buildBrowseHint(db, [
      { q: '俯视', score: 0.72, type: '概念' },
      { q: '蓝发', score: 1, type: '概念' },
    ])
    expect(t).toContain('"俯视"(0.72) 匹配度不足 0.9')
    expect(t).not.toContain('蓝发')
  })

  it('概念类都 ≥0.9：说可以直接采用', () => {
    expect(buildBrowseHint(db, [{ q: '蓝发', score: 0.95, type: '概念' }])).toContain('本次概念查询字面命中较好')
  })

  it('分类目录为空时不提示', () => {
    expect(buildBrowseHint(parseBrowseDb({}), [{ q: '俯视', score: 0.1, type: '概念' }])).toBe('')
  })
})
