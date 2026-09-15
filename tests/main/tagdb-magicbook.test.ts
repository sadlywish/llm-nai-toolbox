import { describe, expect, it } from 'vitest'
import { parseBrowseDb } from '../../src/main/tagdb/browse'
import { parseGlossDb } from '../../src/main/tagdb/gloss'
import {
  buildTree,
  glossOf,
  glossSupplement,
  hasCjk,
  listCategory,
  searchMagic,
  withGloss,
} from '../../src/main/tagdb/magicbook'
import type { CompletionItem } from '../../src/shared/ipc'

const db = parseBrowseDb({
  _toc: [],
  '头发/hair styles': [
    { t: 'long_hair', g: '长发，长度过肩', c: 5000, m: 'long hair long_hair 长发，长度过肩 长髪' },
    { t: 'ahoge', g: '头顶翘起的一撮呆毛', c: 800, m: 'ahoge 头顶翘起的一撮呆毛 呆毛 アホ毛' },
    { t: 'short_hair', g: '短发', c: 3000, m: 'short hair short_hair 短发 ショート' },
  ],
  '头发/hair color': [{ t: 'blue_hair', g: '蓝色头发', c: 900, m: 'blue hair blue_hair 蓝色头发 青髪' }],
  '画面构成/image composition': [
    { t: 'from_above', g: '俯视视角，从上方看向角色', c: 1200, m: 'from above from_above 俯视视角，从上方看向角色 俯瞰' },
    // 帖子数故意比 from_above 多：分档用例要能区分「按档」与「按帖子数」
    { t: 'looking_down', g: '低头向下看', c: 5500, m: 'looking down looking_down 低头向下看 俯视' },
    { t: 'hair_focus', g: '画面聚焦在头发上', c: 50 },
  ],
})
const gloss = parseGlossDb({
  ahoge: { g: '头顶翘起的一撮呆毛', trap: '与 ahegao 无关', vs: [['ahegao', 'ahegao是表情']] },
  long_hair: { g: '长发，长度过肩' },
  from_above: { g: '俯视视角，从上方看向角色', vs: [['looking_down', '那是角色低头']] },
})

describe('buildTree', () => {
  it('一级按数据首次出现的顺序，二级按条数从多到少，计数与总数', () => {
    const { groups, total } = buildTree(db)
    expect(groups.map((g) => g.top)).toEqual(['头发', '画面构成'])
    expect(groups[0]).toEqual({
      top: '头发',
      n: 4,
      subs: [
        { cat: '头发/hair styles', sub: 'hair styles', n: 3 },
        { cat: '头发/hair color', sub: 'hair color', n: 1 },
      ],
    })
    expect(total).toBe(7)
  })
})

describe('listCategory', () => {
  it('按帖子数从多到少，带分类与 trap/vs 标记', () => {
    const items = listCategory(db, gloss, '头发/hair styles')!
    expect(items.map((i) => i.t)).toEqual(['long_hair', 'short_hair', 'ahoge'])
    expect(items[2]).toEqual({ t: 'ahoge', g: '头顶翘起的一撮呆毛', c: 800, cat: '头发/hair styles', trap: true, vs: true })
    expect(items[0]).toMatchObject({ trap: false, vs: false })
  })

  it('gloss 不可用时标记全为 false', () => {
    expect(listCategory(db, null, '头发/hair styles')!.every((i) => !i.trap && !i.vs)).toBe(true)
  })

  it('不存在的分类返回 null', () => {
    expect(listCategory(db, gloss, '头发/nope')).toBeNull()
  })
})

describe('searchMagic', () => {
  it('空查询与纯空白返回空结果', () => {
    expect(searchMagic(db, gloss, '   ')).toEqual({ total: 0, byCat: {}, items: [] })
  })

  it('多个词要同时命中，不分大小写', () => {
    expect(searchMagic(db, gloss, 'HAIR 长发').items.map((i) => i.t)).toEqual(['long_hair'])
  })

  it('分档：标签名命中 › 释义命中 › 别名命中，同档按帖子数', () => {
    // 「俯视」：from_above 释义命中（档 1，1200 帖），looking_down 只在别名里（档 2，5500 帖）——档位优先于帖子数
    expect(searchMagic(db, gloss, '俯视').items.map((i) => i.t)).toEqual(['from_above', 'looking_down'])
    // 「hair」：long_hair / short_hair / blue_hair / hair_focus 标签名命中（档 0，按帖子数），ahoge 不含 hair
    expect(searchMagic(db, gloss, 'hair').items.map((i) => i.t)).toEqual(['long_hair', 'short_hair', 'blue_hair', 'hair_focus'])
  })

  it('没有 m 的条目回退到标签名 + 释义', () => {
    expect(searchMagic(db, gloss, '聚焦').items.map((i) => i.t)).toEqual(['hair_focus'])
  })

  it('total 与 byCat 按全部命中计，items 截到 limit', () => {
    const r = searchMagic(db, gloss, 'hair', 2)
    expect(r.total).toBe(4)
    expect(r.byCat).toEqual({ '头发/hair styles': 2, '头发/hair color': 1, '画面构成/image composition': 1 })
    expect(r.items.map((i) => i.t)).toEqual(['long_hair', 'short_hair'])
  })

  it('传了分类：items 只留这一类（先筛再截断），total 与 byCat 不变', () => {
    const r = searchMagic(db, gloss, 'hair', 2, '画面构成/image composition')
    expect(r.items.map((i) => i.t)).toEqual(['hair_focus'])
    expect(r.total).toBe(4)
    expect(r.byCat['头发/hair styles']).toBe(2)
  })
})

describe('glossOf', () => {
  it('带上所属分类；标签名按 normalizeTagKey 归一', () => {
    expect(glossOf(gloss, db, 'AHOGE')).toEqual({
      g: '头顶翘起的一撮呆毛',
      trap: '与 ahegao 无关',
      vs: [['ahegao', 'ahegao是表情']],
      cat: '头发/hair styles',
    })
    expect(glossOf(gloss, db, 'long hair')?.cat).toBe('头发/hair styles')
  })

  it('browse 不可用时不带分类', () => {
    expect(glossOf(gloss, null, 'ahoge')).not.toHaveProperty('cat')
  })

  it('gloss 里没有或 gloss 不可用时返回 null', () => {
    expect(glossOf(gloss, db, 'short_hair')).toBeNull()
    expect(glossOf(null, db, 'ahoge')).toBeNull()
  })
})

describe('hasCjk', () => {
  it('含中文字符为真', () => {
    expect(hasCjk('俯视')).toBe(true)
    expect(hasCjk('look 俯')).toBe(true)
    expect(hasCjk('looking')).toBe(false)
  })
})

describe('glossSupplement', () => {
  it('非中文查询返回空', () => {
    expect(glossSupplement(db, 'hair', new Set(), 10)).toEqual([])
  })

  it('只匹配释义文字，不看别名；按帖子数；排除已有；有上限', () => {
    // 「俯视」在 looking_down 的别名里，但不在它的释义里 → 不补
    expect(glossSupplement(db, '俯视', new Set(), 10).map((i) => i.t)).toEqual(['from_above'])
    expect(glossSupplement(db, '发', new Set(), 10).map((i) => i.t)).toEqual(['long_hair', 'short_hair', 'blue_hair', 'hair_focus'])
    expect(glossSupplement(db, '发', new Set(['short_hair']), 2).map((i) => i.t)).toEqual(['long_hair', 'blue_hair'])
  })
})

describe('withGloss', () => {
  const item = (tag: string, count = 1): CompletionItem => ({ tag, count, zh: [], series: [] })

  it('给原结果填释义，没有说明的不带 gloss 字段', () => {
    const out = withGloss([item('ahoge'), item('short_hair')], gloss, db, 'a', 0)
    expect(out[0].gloss).toBe('头顶翘起的一撮呆毛')
    expect(out[1]).not.toHaveProperty('gloss')
  })

  it('补充行追加在末尾，带 byGloss，不和原结果重复', () => {
    const out = withGloss([item('from_above', 1200)], gloss, db, '俯视', 10)
    expect(out.map((i) => i.tag)).toEqual(['from_above'])
    const out2 = withGloss([item('looking_down', 5500)], gloss, db, '俯视', 10)
    expect(out2.map((i) => [i.tag, i.byGloss ?? false])).toEqual([
      ['looking_down', false],
      ['from_above', true],
    ])
    expect(out2[1]).toMatchObject({ count: 1200, zh: [], series: [], gloss: '俯视视角，从上方看向角色' })
  })

  it('glossMax 为 0 或 browse 不可用时不补', () => {
    expect(withGloss([], gloss, db, '俯视', 0)).toEqual([])
    expect(withGloss([], gloss, null, '俯视', 10)).toEqual([])
  })

  it('传了 limit 时补充封顶到 limit - 原结果条数', () => {
    expect(withGloss([item('x'), item('y')], gloss, db, '发', 10, 3).length).toBe(3)
    expect(withGloss([item('x'), item('y'), item('z')], gloss, db, '发', 10, 3).length).toBe(3)
  })
})
