import { describe, expect, it } from 'vitest'
import {
  TAG_MANUALS,
  TAG_MANUAL_TOC,
  TAG_SKILL_CORE,
  manualFileName,
  manualTopicCount,
} from '../../src/main/llm/resources'

describe('随包资源', () => {
  it('tag-skill-core 已打进包且非空', () => {
    expect(TAG_SKILL_CORE).toContain('标签检索规则')
    expect(TAG_SKILL_CORE).toBe(TAG_SKILL_CORE.trim())
  })

  it('手册是 20 个主题加一个目录，按文件名取', () => {
    expect(manualTopicCount(TAG_MANUALS)).toBe(20)
    expect(TAG_MANUAL_TOC).toContain('load_tag_manual')
    expect(TAG_MANUALS.get('hair-styles.md')).toBeTruthy()
  })

  it('目录里列出的每个主题名都能换算到一个存在的文件', () => {
    const topics = [...TAG_MANUAL_TOC.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1])
    expect(topics).toHaveLength(20)
    for (const t of topics) expect(TAG_MANUALS.has(manualFileName(t))).toBe(true)
  })
})

describe('manualFileName', () => {
  it('空白换连字符、转小写', () => {
    expect(manualFileName(' Image Composition ')).toBe('image-composition.md')
  })

  it('路径穿越字符被剥掉', () => {
    expect(manualFileName('../../etc/passwd')).toBe('etcpasswd.md')
  })
})

describe('manualTopicCount', () => {
  it('不把 _toc.md 算作主题', () => {
    expect(manualTopicCount(new Map([['_toc.md', 'x'], ['a.md', 'y']]))).toBe(1)
  })
})
