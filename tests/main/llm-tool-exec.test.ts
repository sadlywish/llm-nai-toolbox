import { describe, expect, it } from 'vitest'
import { defaultAppConfig } from '../../src/shared/config'
import type { LlmLogLine } from '../../src/shared/llm'
import { buildIndex, type TagEntry } from '../../src/shared/tagdb/search'
import { parseBrowseDb } from '../../src/main/tagdb/browse'
import { parseCharacterCsv } from '../../src/main/tagdb/charfeat'
import { parseGlossDb } from '../../src/main/tagdb/gloss'
import type { TagdbCategories } from '../../src/main/tagdb/loader'
import type { TagData } from '../../src/main/llm/data'
import { RunLog } from '../../src/main/llm/log'
import { executeBrowse, executeLoadManual, executeSearchTags } from '../../src/main/llm/toolExec'

const e = (tag: string, count: number, extra: Partial<TagEntry> = {}): TagEntry => ({
  tag, count, zh: [], zhFull: [], zhShort: [], zhNick: [], ja: [], en: [], other: [], series: [], ...extra,
})
const cat = (entries: TagEntry[]) => ({ entries, index: buildIndex(entries), completionIndex: new Map<string, number[]>() })

const categories: TagdbCategories = {
  artists: cat([e('wlop', 9000)]),
  characters: cat([e('hatsune_miku', 5000, { zh: ['初音未来'] })]),
  series: cat([e('vocaloid', 100, { zh: ['VOCALOID'] })]),
  general: cat([e('from_above', 300, { zh: ['俯视'] })]),
}

function data(over: Partial<TagData> = {}): TagData {
  return {
    categories,
    wikiMap: null,
    browse: parseBrowseDb({ _toc: [{ cat: '画面构成/image composition', n: 2, top: 'from above' }], '画面构成/image composition': [{ t: 'from_above', g: '俯视', c: 1 }, { t: 'from_below', g: '仰视', c: 1 }] }),
    gloss: parseGlossDb({ from_above: { g: '从上往下看的视角' } }),
    deprecated: null,
    characters: parseCharacterCsv('character,copyright,appearance,clothing\nhatsune_miku,vocaloid,"aqua_hair, twintails",necktie\n'),
    ...over,
  }
}

/** 同名角色一堆的库：查 saber 会命中四个，用来验「前几名都附特征」与上限 */
function sabers(): TagData {
  const names = ['saber', 'saber_alter', 'saber_lily', 'saber_bride']
  return data({
    categories: {
      ...categories,
      characters: cat(names.map((n, i) => e(n, 9000 - i * 1000, { en: [n.replace(/_/g, ' ')] }))),
    },
    characters: parseCharacterCsv(
      ['character,copyright,appearance,clothing', ...names.map((n) => `${n},fate,"blonde_hair, green_eyes",armor`)].join('\n'),
    ),
  })
}

function logger() {
  const lines: LlmLogLine[] = []
  return { texts: () => lines.map((l) => l.text), log: new RunLog((l) => lines.push(l)) }
}

describe('executeSearchTags', () => {
  it('入参、每条结果写日志；全部 ≥0.85 时 allHigh；返回格式化文本并附角色特征', () => {
    const { log, texts } = logger()
    const o = executeSearchTags(
      { characters: [{ name: '初音未来' }] },
      data(),
      { ...defaultAppConfig(), tagQueryCharacterClothing: true },
      log,
    )
    expect(o.allHigh).toBe(true)
    expect(o.queryCount).toBe(1)
    expect(texts()[0]).toBe('search_tags 入参: artists=[], characters=[{"name":"初音未来"}], concepts=[], series=[]')
    expect(texts()).toContain('search_tags 结果: [角色] "初音未来" → hatsune_miku (score=1.00, count=5000)')
    expect(o.text).toContain('1. hatsune miku (匹配度: 1.00')
    expect(o.text).toContain('[角色特征] hatsune miku:\n  作品: vocaloid\n  外貌: aqua hair, twintails\n  服装: necktie')
  })

  it('有一条无匹配就不是 allHigh；概念查询附上改用 browse_tags 的提示与 gloss 释义', () => {
    const { log, texts } = logger()
    const o = executeSearchTags({ concepts: '俯视, 完全不存在的东西' }, data(), defaultAppConfig(), log)
    expect(o.allHigh).toBe(false)
    expect(o.queryCount).toBe(2)
    expect(texts()).toContain('search_tags 结果: [概念] "完全不存在的东西" → 无匹配')
    expect(o.text).toContain('[工具选择提示]')
    expect(o.text).toContain('     释义: 从上往下看的视角')
  })

  it('一个查询命中多个同名角色时，前几个候选都附特征，收尾提示只写一次', () => {
    const o = executeSearchTags({ characters: 'saber' }, sabers(), defaultAppConfig(), logger().log)
    // 顺序跟着搜索结果的排序走，这里只认「是哪三个」
    const tags = [...o.text.matchAll(/\[角色特征\] (.+?):/g)].map((m) => m[1]).sort()
    expect(tags).toEqual(['saber', 'saber alter', 'saber lily'])
    // 上限 3：第四个候选（saber bride）不附，免得把上下文喂给用不上的同名角色
    expect(o.text).not.toContain('saber bride:')
    expect(o.text.match(/→ 外貌和服装标签放入 appearance 字段/g)).toHaveLength(1)
    expect(o.text).toContain('→ 列出了多个候选时，只取你实际采用的那个角色的特征')
  })

  it('只给模型看得见的候选附特征：返回条数设成 1 时就只附第一个', () => {
    const config = { ...defaultAppConfig(), tagQueryCharacterMax: 1 }
    const o = executeSearchTags({ characters: 'saber' }, sabers(), config, logger().log)
    expect([...o.text.matchAll(/\[角色特征\] (.+?):/g)].map((m) => m[1])).toEqual(['saber'])
    // 单个候选时不写那句「多个候选」
    expect(o.text).not.toContain('只取你实际采用的那个角色的特征')
  })

  it('两条查询命中同一个角色时只附一次', () => {
    const o = executeSearchTags({ characters: ['saber', 'saber'] }, sabers(), defaultAppConfig(), logger().log)
    expect(o.text.match(/\[角色特征\] saber:/g)).toHaveLength(1)
  })

  it('分类库不可用时不附工具选择提示；角色特征三个开关全关时不附特征', () => {
    const config = { ...defaultAppConfig(), tagQueryCharacterSeries: false, tagQueryCharacterAppearance: false, tagQueryCharacterClothing: false }
    const o = executeSearchTags({ characters: '初音未来', concepts: ['俯视'] }, data({ browse: null }), config, logger().log)
    expect(o.text).not.toContain('[工具选择提示]')
    expect(o.text).not.toContain('[角色特征]')
  })
})

describe('executeBrowse', () => {
  it('浏览分类并写一行日志', () => {
    const { log, texts } = logger()
    const text = executeBrowse({ category: 'image composition', keyword: '仰', page: 1 }, data(), defaultAppConfig(), log)
    expect(text).toContain('[分类] 画面构成/image composition')
    expect(texts()[0]).toMatch(/^browse_tags: image composition kw=仰 p1 \(\d+ 字符\)$/)
  })
})

describe('executeLoadManual', () => {
  const manuals = new Map([['hair-styles.md', '# 发型'], ['_toc.md', 'TOC']])

  it('按主题名取；取到写 I，取不到写 W 并提示看目录', () => {
    const { log, texts } = logger()
    expect(executeLoadManual({ topic: 'Hair Styles' }, manuals, true, log)).toBe('# 发型')
    expect(texts()[0]).toBe('load_tag_manual: hair styles (4 字符)')
    expect(executeLoadManual({ topic: 'nope' }, manuals, true, log)).toBe('未找到主题 "nope"。请使用系统提示词手册目录中列出的主题名。')
    expect(texts()[1]).toBe('load_tag_manual: 未找到主题 "nope"')
  })

  it('没给主题、手册未启用', () => {
    expect(executeLoadManual({}, manuals, true, logger().log)).toBe('请提供 topic 参数。')
    expect(executeLoadManual({ topic: 'hair styles' }, manuals, false, logger().log)).toBe('主题手册未启用。')
  })
})
