import { unitRangeAt } from './weight'

/** WIKI 栏「加入」的文本：画师 artist: + 名字；所有下划线换空格（规格 R7） */
export function formatWikiTag(tag: string, isArtist: boolean): string {
  let name = tag.trim()
  if (isArtist) name = name.replace(/^artist:/i, '').replace(/^@/, '').trim()
  name = name.replace(/_/g, ' ')
  return isArtist ? `artist:${name}` : name
}

/**
 * 把 insert 插进一个字段的文本（规格 §4.3）：
 * 光标所在单元非空 → 插到单元末尾；否则插在光标处。左侧有内容且不以逗号结尾补「, 」，
 * 左侧以逗号结尾但没空格补一个空格；右侧有内容且不以逗号开头补「, 」。
 */
export function insertTagAt(text: string, pos: number, insert: string): { text: string; cursor: number } {
  const p = Math.max(0, Math.min(pos, text.length))
  const unit = unitRangeAt(text, p)
  const at = text.slice(unit.start, unit.end).trim() !== '' ? unit.end : p
  const left = text.slice(0, at)
  const right = text.slice(at)
  let before = ''
  if (left.trim() !== '') {
    if (!/[,，]\s*$/.test(left)) before = ', '
    else if (!/\s$/.test(left)) before = ' '
  }
  const after = right.trim() !== '' && !/^\s*[,，]/.test(right) ? ', ' : ''
  const next = left + before + insert + after + right
  return { text: next, cursor: left.length + before.length + insert.length }
}

/** 光标处的词 → 查询词：去掉 {} [] 强调与首尾空白；纯数字（权重值）视为没有词 */
export function cleanCursorWord(word: string): string {
  const s = word.trim().replace(/^[{[]+/, '').replace(/[}\]]+$/, '').trim()
  return /^-?\d+(?:\.\d+)?$/.test(s) ? '' : s
}
