import { describe, expect, it } from 'vitest'
import { absolutizeUrl, inlinePlainText, parseDText, parseInline } from '@shared/dtext'

describe('parseInline', () => {
  it('[[tag]] 内链：tag 归一为下划线小写，显示名把下划线换空格', () => {
    expect(parseInline('see [[Long Hair]] now')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'wikiLink', tag: 'long_hair', label: 'Long Hair' },
      { type: 'text', text: ' now' },
    ])
    expect(parseInline('[[two_side_up]]')).toEqual([{ type: 'wikiLink', tag: 'two_side_up', label: 'two side up' }])
  })

  it('[[tag|显示名]] 用显示名', () => {
    expect(parseInline('[[ponytail|ponytails]]')).toEqual([{ type: 'wikiLink', tag: 'ponytail', label: 'ponytails' }])
  })

  it('"文字":url、"文字":[url]、站内相对地址', () => {
    expect(parseInline('"guide":https://example.com/a.')).toEqual([
      { type: 'extLink', url: 'https://example.com/a', label: 'guide' },
      { type: 'text', text: '.' },
    ])
    expect(parseInline('"x":[https://e.com/p?q=1]')).toEqual([{ type: 'extLink', url: 'https://e.com/p?q=1', label: 'x' }])
    expect(parseInline('"posts":/posts?tags=long_hair')).toEqual([
      { type: 'extLink', url: 'https://danbooru.donmai.us/posts?tags=long_hair', label: 'posts' },
    ])
  })

  it('裸 URL 去掉句末标点', () => {
    expect(parseInline('at https://e.com/x, ok')).toEqual([
      { type: 'text', text: 'at ' },
      { type: 'extLink', url: 'https://e.com/x', label: 'https://e.com/x' },
      { type: 'text', text: ', ok' },
    ])
  })

  it('[b][i][u][s] 行内样式可嵌套；缺闭合时原样当文本', () => {
    expect(parseInline('[b]bold [i]both[/i][/b]')).toEqual([
      { type: 'style', style: 'b', children: [{ type: 'text', text: 'bold ' }, { type: 'style', style: 'i', children: [{ type: 'text', text: 'both' }] }] },
    ])
    expect(parseInline('[b]open only')).toEqual([{ type: 'text', text: '[b]open only' }])
  })

  it('!post #123 内嵌图', () => {
    expect(parseInline('!post #4567')).toEqual([{ type: 'postImage', postId: 4567 }])
  })

  it('不认识的标记原样保留', () => {
    expect(parseInline('{{long_hair}} [expand]x[/expand]')).toEqual([{ type: 'text', text: '{{long_hair}} [expand]x[/expand]' }])
  })

  it('段内换行变成 br', () => {
    expect(parseInline('a\nb')).toEqual([{ type: 'text', text: 'a' }, { type: 'br' }, { type: 'text', text: 'b' }])
  })
})

describe('parseDText 块结构', () => {
  it('标题（含 #anchor）、段落、列表层级', () => {
    const doc = parseDText('h4#types. Types\n\nA [[b]] c.\n* one\n** two')
    expect(doc.blocks).toEqual([
      { type: 'heading', level: 4, children: [{ type: 'text', text: 'Types' }] },
      { type: 'paragraph', children: [{ type: 'text', text: 'A ' }, { type: 'wikiLink', tag: 'b', label: 'b' }, { type: 'text', text: ' c.' }] },
      { type: 'list', items: [
        { depth: 1, children: [{ type: 'text', text: 'one' }] },
        { depth: 2, children: [{ type: 'text', text: 'two' }] },
      ] },
    ])
  })

  it('[code] 内容原样，不解析内链', () => {
    expect(parseDText('[code][[x]][/code]').blocks).toEqual([{ type: 'code', text: '[[x]]' }])
  })

  it('[quote] 递归解析，可跨行', () => {
    expect(parseDText('[quote]\nh5. T\nbody\n[/quote]').blocks).toEqual([
      { type: 'quote', blocks: [
        { type: 'heading', level: 5, children: [{ type: 'text', text: 'T' }] },
        { type: 'paragraph', children: [{ type: 'text', text: 'body' }] },
      ] },
    ])
  })

  it('CRLF 与 CR 统一成 LF', () => {
    expect(parseDText('a\r\n\r\nb').blocks).toHaveLength(2)
  })
})

describe('See also 提取', () => {
  it('有内链时提成芯片，整节（到下一个同级或更高级标题前）从正文去掉，去重', () => {
    const doc = parseDText('Intro.\n\nh4. See also\n\n* [[two side up]]\n* [[twin braids]]\n* [[two side up]]\n\nh4. External links\n\nx')
    expect(doc.seeAlso).toEqual(['two_side_up', 'twin_braids'])
    expect(doc.blocks.map((b) => b.type)).toEqual(['paragraph', 'heading', 'paragraph'])
    expect(doc.blocks[1]).toEqual({ type: 'heading', level: 4, children: [{ type: 'text', text: 'External links' }] })
  })

  it('没有内链时整节原样保留', () => {
    const doc = parseDText('h4. See also\n\nnothing here')
    expect(doc.seeAlso).toEqual([])
    expect(doc.blocks).toHaveLength(2)
  })
})

describe('辅助函数', () => {
  it('absolutizeUrl 只认 http(s) 与站内 /', () => {
    expect(absolutizeUrl('https://a.b')).toBe('https://a.b')
    expect(absolutizeUrl('/wiki_pages/x')).toBe('https://danbooru.donmai.us/wiki_pages/x')
    expect(absolutizeUrl('javascript:alert(1)')).toBeNull()
    expect(absolutizeUrl('file:///c:/x')).toBeNull()
  })

  it('inlinePlainText 拼出文字与链接显示名', () => {
    expect(inlinePlainText(parseInline('[b]See[/b] [[also]]'))).toBe('See also')
  })
})
