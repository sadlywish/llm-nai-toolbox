import { describe, expect, it } from 'vitest'
import {
  buildInjectionBlock,
  lookupGloss,
  normalizeTagKey,
  parseDeprecatedDb,
  parseGlossDb,
} from '../../src/main/tagdb/gloss'

const gloss = parseGlossDb({
  deep_skin: { g: '深色皮肤', trap: '不是皮肤很深' },
  belly: { g: '腹部', trap: '只是露出肚子' },
  cowboy_shot: { g: '七分身构图', trap: '不是牛仔' },
  blue_hair: { g: '蓝发' },
  bad: { g: '' },
  vs_tag: { g: '示例', vs: [['other_tag', '区别'], [3, 'x'], ['only_tag']] },
})
const dep = parseDeprecatedDb({ areolae: '已废弃，请改用 X', weird: 3 })

describe('normalizeTagKey', () => {
  it('小写、空白换下划线、去首尾空白', () => {
    expect(normalizeTagKey('  Deep  Skin ')).toBe('deep_skin')
  })
})

describe('parseGlossDb', () => {
  it('g 为空的条目丢掉；键按 normalizeTagKey 归一', () => {
    expect(gloss.has('bad')).toBe(false)
    expect(lookupGloss(gloss, 'Deep Skin')?.g).toBe('深色皮肤')
  })

  it('vs 只收首项是字符串的对，缺第二项补空串', () => {
    expect(gloss.get('vs_tag')?.vs).toEqual([['other_tag', '区别'], ['only_tag', '']])
  })

  it('不是对象时给空表', () => {
    expect(parseGlossDb('x').size).toBe(0)
  })
})

describe('parseDeprecatedDb', () => {
  it('只收字符串理由', () => {
    expect([...dep.entries()]).toEqual([['areolae', '已废弃，请改用 X']])
  })
})

describe('buildInjectionBlock', () => {
  it('纯中文自由文本不扫描', () => {
    expect(buildInjectionBlock('画一个女孩在海边散步', gloss, dep)).toBeNull()
  })

  it('嵌在中文句子里的多词标签会被捞出来', () => {
    const block = buildInjectionBlock('要有 deep skin 的效果', gloss, dep)
    expect(block).toContain('- deep_skin = 深色皮肤（不是皮肤很深）')
  })

  it('嵌在中文句子里的单词不捞——防误报', () => {
    expect(buildInjectionBlock('画一个 belly 露出的女孩', gloss, dep)).toBeNull()
  })

  it('逗号分隔的 TAG 串：只注入带 trap 的，普通标签不注入', () => {
    const block = buildInjectionBlock('1girl, belly, cowboy shot, blue hair', gloss, dep)
    expect(block).toBe(
      [
        '<标签释义>',
        '以下标签的含义与字面不同，处理时以此为准：',
        '- belly = 腹部（只是露出肚子）',
        '- cowboy_shot = 七分身构图（不是牛仔）',
        '</标签释义>',
      ].join('\n'),
    )
  })

  it('<现有参数> 的「字段名: 」前缀会被剥掉；废弃标签单独标出', () => {
    const block = buildInjectionBlock('appearance: white hair, deep skin\ntags: areolae', gloss, dep)
    expect(block).toContain('- deep_skin = 深色皮肤（不是皮肤很深）')
    expect(block).toContain('- areolae = 【已废弃】已废弃，请改用 X')
  })

  it('同一个标签只出现一次；超过上限时注明省略条数', () => {
    expect(buildInjectionBlock('deep skin, deep_skin', gloss, dep)?.match(/deep_skin/g)).toHaveLength(1)
    const block = buildInjectionBlock('deep skin, belly, cowboy shot', gloss, dep, 2)
    expect(block?.match(/^- /gm)).toHaveLength(2)
    expect(block).toContain('（另有 1 条未列出）')
  })
})
