import { DANBOORU_BASE_URL, normalizeTag } from './danbooru'

/**
 * Danbooru wiki 的 DText 子集解析（规格 2026-09-14-wiki-rail-design.md §4.1）。
 * 输出节点树，由渲染层生成 React 元素——不拼 HTML 字符串，没有注入面。
 * 不认识的标记一律原样当文本：吞掉等于静默丢信息。
 */

export type DInline =
  | { type: 'text'; text: string }
  | { type: 'wikiLink'; tag: string; label: string }
  | { type: 'extLink'; url: string; label: string }
  | { type: 'style'; style: 'b' | 'i' | 'u' | 's'; children: DInline[] }
  | { type: 'postImage'; postId: number }
  | { type: 'br' }

export type DBlock =
  | { type: 'heading'; level: number; children: DInline[] }
  | { type: 'paragraph'; children: DInline[] }
  | { type: 'list'; items: { depth: number; children: DInline[] }[] }
  | { type: 'quote'; blocks: DBlock[] }
  | { type: 'code'; text: string }

export interface DTextDoc {
  blocks: DBlock[]
  /** See also 一节里的内链 tag（已归一、去重、保持先后） */
  seeAlso: string[]
}

/** 外链只放行 http(s)；站内相对地址补成绝对地址；其余（javascript:、file: 等）一律不当链接 */
export function absolutizeUrl(url: string): string | null {
  if (/^https?:\/\//i.test(url)) return url
  if (url.startsWith('/')) return DANBOORU_BASE_URL + url
  return null
}

/** 从 from（开标签起点）起找配对的闭标签起点；同名标签可嵌套；找不到返回 -1。lower 须为已小写的原文 */
function findClose(lower: string, from: number, tag: string): number {
  const open = `[${tag}]`
  const close = `[/${tag}]`
  let depth = 0
  let j = from
  while (j < lower.length) {
    const nextOpen = lower.indexOf(open, j)
    const nextClose = lower.indexOf(close, j)
    if (nextClose < 0) return -1
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth++
      j = nextOpen + open.length
      continue
    }
    depth--
    if (depth === 0) return nextClose
    j = nextClose + close.length
  }
  return -1
}

// 带 y 标志的正则从 lastIndex 处原地匹配，避免逐字符 slice（wiki 正文可能几十 KB）
const RE_STYLE = /\[(b|i|u|s)\]/iy
const RE_QUOTED_LINK = /"([^"\n]+)":(?:\[([^\]\s]+)\]|((?:https?:\/\/|\/)[^\s<>"]*[^\s<>".,;:!?)\]]))/y
const RE_BARE_URL = /https?:\/\/[^\s<>"]*[^\s<>".,;:!?)\]]/iy
const RE_POST = /!post #(\d+)/y

function matchAt(re: RegExp, src: string, i: number): RegExpExecArray | null {
  re.lastIndex = i
  return re.exec(src)
}

export function parseInline(src: string): DInline[] {
  const out: DInline[] = []
  const lower = src.toLowerCase()
  let buf = ''
  const flush = (): void => {
    if (buf !== '') {
      out.push({ type: 'text', text: buf })
      buf = ''
    }
  }
  let i = 0
  while (i < src.length) {
    const ch = src[i]

    if (ch === '[' && src.startsWith('[[', i)) {
      const end = src.indexOf(']]', i + 2)
      const inner = end > i + 2 ? src.slice(i + 2, end) : ''
      if (inner !== '' && !inner.includes('\n')) {
        const bar = inner.indexOf('|')
        const rawTag = (bar >= 0 ? inner.slice(0, bar) : inner).trim()
        const rawLabel = bar >= 0 ? inner.slice(bar + 1).trim() : rawTag
        if (rawTag !== '') {
          flush()
          out.push({ type: 'wikiLink', tag: normalizeTag(rawTag).toLowerCase(), label: (rawLabel || rawTag).replace(/_/g, ' ') })
          i = end + 2
          continue
        }
      }
    }

    if (ch === '[') {
      const m = matchAt(RE_STYLE, src, i)
      if (m) {
        const style = m[1].toLowerCase() as 'b' | 'i' | 'u' | 's'
        const close = findClose(lower, i, style)
        if (close > 0) {
          flush()
          out.push({ type: 'style', style, children: parseInline(src.slice(i + 3, close)) })
          i = close + 4
          continue
        }
      }
    }

    if (ch === '"') {
      const m = matchAt(RE_QUOTED_LINK, src, i)
      const url = m ? absolutizeUrl(m[2] ?? m[3]) : null
      if (m && url) {
        flush()
        out.push({ type: 'extLink', url, label: m[1] })
        i += m[0].length
        continue
      }
    }

    if ((ch === 'h' || ch === 'H') && (i === 0 || /[\s(>]/.test(src[i - 1]))) {
      const m = matchAt(RE_BARE_URL, src, i)
      if (m) {
        flush()
        out.push({ type: 'extLink', url: m[0], label: m[0] })
        i += m[0].length
        continue
      }
    }

    if (ch === '!') {
      const m = matchAt(RE_POST, src, i)
      if (m) {
        flush()
        out.push({ type: 'postImage', postId: Number(m[1]) })
        i += m[0].length
        continue
      }
    }

    if (ch === '\n') {
      flush()
      out.push({ type: 'br' })
      i++
      continue
    }

    buf += ch
    i++
  }
  flush()
  return out
}

export function inlinePlainText(nodes: DInline[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text':
          return n.text
        case 'wikiLink':
        case 'extLink':
          return n.label
        case 'style':
          return inlinePlainText(n.children)
        case 'br':
          return '\n'
        default:
          return ''
      }
    })
    .join('')
}

type Segment = { kind: 'text' | 'code' | 'quote'; content: string }

/** 先把 [code]、[quote] 从正文里切出来，剩下的文本再按行解析 */
function splitSegments(src: string): Segment[] {
  const lower = src.toLowerCase()
  const out: Segment[] = []
  let textStart = 0
  let i = 0
  const pushText = (end: number): void => {
    if (end > textStart) out.push({ kind: 'text', content: src.slice(textStart, end) })
  }
  while (i < src.length) {
    if (src[i] === '[') {
      if (lower.startsWith('[code]', i)) {
        const close = lower.indexOf('[/code]', i + 6)
        if (close >= 0) {
          pushText(i)
          out.push({ kind: 'code', content: src.slice(i + 6, close) })
          i = close + 7
          textStart = i
          continue
        }
      }
      if (lower.startsWith('[quote]', i)) {
        const close = findClose(lower, i, 'quote')
        if (close >= 0) {
          pushText(i)
          out.push({ kind: 'quote', content: src.slice(i + 7, close) })
          i = close + 8
          textStart = i
          continue
        }
      }
    }
    i++
  }
  pushText(src.length)
  return out
}

function parseLines(text: string, blocks: DBlock[]): void {
  let para: string[] = []
  let list: { depth: number; children: DInline[] }[] | null = null
  const flushPara = (): void => {
    if (para.length > 0) {
      blocks.push({ type: 'paragraph', children: parseInline(para.join('\n')) })
      para = []
    }
  }
  const flushList = (): void => {
    if (list !== null) {
      blocks.push({ type: 'list', items: list })
      list = null
    }
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    const h = /^h([1-6])(?:#[\w-]+)?\.\s+(.*)$/i.exec(trimmed)
    if (h) {
      flushPara()
      flushList()
      blocks.push({ type: 'heading', level: Number(h[1]), children: parseInline(h[2]) })
      continue
    }
    const li = /^(\*+)\s+(.*)$/.exec(trimmed)
    if (li) {
      flushPara()
      ;(list ??= []).push({ depth: li[1].length, children: parseInline(li[2]) })
      continue
    }
    if (trimmed === '') {
      flushPara()
      flushList()
      continue
    }
    flushList()
    para.push(trimmed)
  }
  flushPara()
  flushList()
}

function parseBlocks(src: string): DBlock[] {
  const blocks: DBlock[] = []
  for (const seg of splitSegments(src)) {
    if (seg.kind === 'code') blocks.push({ type: 'code', text: seg.content.replace(/^\n|\n$/g, '') })
    else if (seg.kind === 'quote') blocks.push({ type: 'quote', blocks: parseBlocks(seg.content) })
    else parseLines(seg.content, blocks)
  }
  return blocks
}

function collectLinks(blocks: DBlock[], into: string[]): void {
  const fromInline = (nodes: DInline[]): void => {
    for (const n of nodes) {
      if (n.type === 'wikiLink') into.push(n.tag)
      else if (n.type === 'style') fromInline(n.children)
    }
  }
  for (const b of blocks) {
    if (b.type === 'paragraph' || b.type === 'heading') fromInline(b.children)
    else if (b.type === 'list') b.items.forEach((it) => fromInline(it.children))
    else if (b.type === 'quote') collectLinks(b.blocks, into)
  }
}

export function parseDText(body: string): DTextDoc {
  const blocks = parseBlocks(body.replace(/\r\n?/g, '\n'))
  const idx = blocks.findIndex((b) => b.type === 'heading' && /^see also$/i.test(inlinePlainText(b.children).trim()))
  if (idx < 0) return { blocks, seeAlso: [] }
  const head = blocks[idx] as Extract<DBlock, { type: 'heading' }>
  let end = idx + 1
  while (end < blocks.length) {
    const b = blocks[end]
    if (b.type === 'heading' && b.level <= head.level) break
    end++
  }
  const links: string[] = []
  collectLinks(blocks.slice(idx + 1, end), links)
  if (links.length === 0) return { blocks, seeAlso: [] }
  return { blocks: [...blocks.slice(0, idx), ...blocks.slice(end)], seeAlso: [...new Set(links)] }
}
