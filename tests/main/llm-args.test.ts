import { describe, expect, it } from 'vitest'
import {
  decodeHtmlEntities,
  formatArgsForEdit,
  parseJsonLoose,
  repairJsonTextFields,
  repairLeakedParams,
  repairLlmArgs,
  sanitizeLlmArgs,
  toCharacterList,
  toQueryList,
} from '../../src/main/llm/args'

describe('decodeHtmlEntities / sanitizeLlmArgs', () => {
  it('&amp; 最后解，避免 &amp;lt; 被解两次', () => {
    expect(decodeHtmlEntities('&lt;lora:x:0.8&gt; &amp;lt;')).toBe('<lora:x:0.8> &lt;')
  })

  it('递归解码对象与数组；数组里的数组仍是数组', () => {
    expect(
      sanitizeLlmArgs({ a: '&lt;', b: ['&gt;', { c: '&quot;' }], d: 3, e: [['&amp;']], f: null }),
    ).toEqual({ a: '<', b: ['>', { c: '"' }], d: 3, e: [['&']], f: null })
  })
})

describe('repairLeakedParams', () => {
  it('后续参数漏进字符串尾部：还原成真参数，正文截断', () => {
    const r = repairLeakedParams({
      nltags: '纯白色的背景。</nltags>\n<parameter name="quality">very aesthetic, masterpiece',
    })
    expect(r.args).toEqual({ nltags: '纯白色的背景。', quality: 'very aesthetic, masterpiece' })
    expect(r.notes).toHaveLength(1)
    expect(r.notes[0]).toContain('已还原为 1/1 个参数')
  })

  it('还原出的 JSON 数组被解析；空数组视为缺失', () => {
    const r = repairLeakedParams({
      nltags: '皮肤苍白。</nltags>\n<parameter name="characters">[{"count":"girl","character":"robin"}]',
      characters: [],
    })
    expect(r.args.characters).toEqual([{ count: 'girl', character: 'robin' }])
  })

  it('已经作为真参数收到的值不覆盖', () => {
    const r = repairLeakedParams({ nltags: 'x</nltags><parameter name="quality">leaked', quality: 'real' })
    expect(r.args.quality).toBe('real')
    expect(r.notes[0]).toContain('已还原为 0/1 个参数')
  })

  it('角色对象里漏出来的参数留在该角色里，不提到顶层', () => {
    const r = repairLeakedParams({ characters: [{ tags: 'smile</tags><parameter name="nltags">一句话' }] })
    expect(r.args.characters).toEqual([{ tags: 'smile', nltags: '一句话' }])
    expect(r.args.nltags).toBeUndefined()
  })

  it('没有标记的值原样', () => {
    const args = { tags: 'smile, [blue hair]' }
    expect(repairLeakedParams(args)).toEqual({ args, notes: [] })
  })
})

describe('parseJsonLoose', () => {
  it('\\uXXXX 中间插了空格：补一刀再解析', () => {
    expect(parseJsonLoose('[{"a":"\\u7 effe"}]')).toEqual([{ a: '绿e' }])
  })

  it('数组里坏一个对象不连累其余', () => {
    expect(parseJsonLoose('[{"a":1},{"b":2,,},{"c":3}]')).toEqual([{ a: 1 }, { c: 3 }])
  })

  it('末尾没写完的对象补上收尾再试', () => {
    expect(parseJsonLoose('[{"a":1},{"b":"x')).toEqual([{ a: 1 }, { b: 'x' }])
    expect(parseJsonLoose('{"a":"x')).toEqual({ a: 'x' })
  })

  it('救不回来返回 undefined', () => {
    expect(parseJsonLoose('not json')).toBeUndefined()
    expect(parseJsonLoose('[blue hair], smile')).toBeUndefined()
  })
})

describe('repairJsonTextFields', () => {
  it('本该是数组的字段收到 JSON 文本：解析成数组并记一条', () => {
    const r = repairJsonTextFields({ characters: '[{"count":"girl"},{"count":"boy"}]' })
    expect(r.args.characters).toEqual([{ count: 'girl' }, { count: 'boy' }])
    expect(r.notes[0]).toContain('已解析为 2 项数组')
  })

  it('NovelAI 的 [tag] 降权写法不误伤', () => {
    const args = { tags: '[blue hair], smile' }
    expect(repairJsonTextFields(args)).toEqual({ args, notes: [] })
  })
})

describe('repairLlmArgs', () => {
  it('先还原泄漏的参数，再解析其中的 JSON 文本——顺序反了就救不回这一组角色', () => {
    const r = repairLlmArgs({
      nltags: 'x</nltags><parameter name="characters">[{"count":"girl",,},{"count":"boy"}]',
    })
    expect(r.args.characters).toEqual([{ count: 'boy' }])
    expect(r.notes).toHaveLength(2)
  })
})

describe('toQueryList', () => {
  it('字符串按逗号拆；嵌套数组拍平；数字转字符串；空值丢掉', () => {
    expect(toQueryList('a, b')).toEqual(['a', 'b'])
    expect(toQueryList([['x', ['y']], null, 42])).toEqual(['x', 'y', '42'])
    expect(toQueryList(undefined)).toEqual([])
  })

  it('类数组对象按数字键顺序全部还原', () => {
    expect(toQueryList([{ 1: '全家', 0: '罗森' }])).toEqual(['罗森', '全家'])
  })

  it('包装形态取 name/tag/query/text/value；认不出的取第一个非空字符串字段', () => {
    expect(toQueryList([{ query: '猫耳' }])).toEqual(['猫耳'])
    expect(toQueryList({ foo: 3, bar: ' ', baz: '俯视' })).toEqual(['俯视'])
  })
})

describe('toCharacterList', () => {
  it('带作品名的对象；一个名字字段里写了多个名字时各自带上作品名', () => {
    expect(toCharacterList([{ name: 'saber', series: 'fate' }])).toEqual([{ name: 'saber', series: 'fate' }])
    expect(toCharacterList([{ name: 'a, b', series: ' x ' }])).toEqual([
      { name: 'a', series: 'x' },
      { name: 'b', series: 'x' },
    ])
  })

  it('字符串与类数组对象', () => {
    expect(toCharacterList('miku, saber')).toEqual([{ name: 'miku' }, { name: 'saber' }])
    expect(toCharacterList({ 0: { name: 'a' } })).toEqual([{ name: 'a' }])
  })
})

describe('formatArgsForEdit', () => {
  it('先按顺序串排已知字段，其余追加；空值跳过；对象写成 JSON', () => {
    const text = formatArgsForEdit(
      { tags: 'smile', count: '1girl', negative_prompt: 'lowres', seed: -1, empty: '', characters: [{ count: 'girl' }] },
      'count, tags',
    )
    expect(text).toBe(
      'count: 1girl\ntags: smile\nnegative_prompt: lowres\nseed: -1\ncharacters: [\n  {\n    "count": "girl"\n  }\n]',
    )
  })
})
