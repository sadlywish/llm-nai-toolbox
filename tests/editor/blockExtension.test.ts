import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { blockExtensions } from '@renderer/editor/blockExtension'
import { BLOCK_SEP, isWellFormed, serializeFields } from '@shared/blockDoc'
import { MAIN_FIELDS } from '@shared/fields'

/** 三字段小样，跟其余分块测试用同一个惯例（见 tests/shared/blockDoc.test.ts） */
const TRIO = MAIN_FIELDS.slice(0, 3)

function makeState(values: Record<string, string>): EditorState {
  return EditorState.create({
    doc: serializeFields(values, TRIO),
    extensions: blockExtensions(TRIO),
  })
}

/**
 * guardFilter 的换行防护。
 *
 * 块文档必须是单行——每段内容里混进 `\n` 之后，一切按字符位置换算段内坐标
 * 的逻辑都会跟着错位。这里不需要真实的 EditorView/DOM：guardFilter 是纯粹
 * 建在 EditorState.transactionFilter 上的扩展，直接对 EditorState 派发事务
 * 就能触发它，不必起 CodeMirror 的可视化层。
 */
describe('guardFilter：换行防护', () => {
  it('段尾插入换行（对应 Enter 键）——换行被剥掉，文档保持单行且合法', () => {
    const state = makeState({ count: 'solo', style: '', character: '' })
    const doc = state.doc.toString()
    const pos = doc.indexOf('solo') + 'solo'.length // count 段内容末尾，紧挨下一个分隔符
    const tr = state.update({ changes: { from: pos, to: pos, insert: '\n' } })
    const next = tr.state.doc.toString()

    expect(next).not.toMatch(/[\r\n]/)
    expect(next).toBe(serializeFields({ count: 'solo', style: '', character: '' }, TRIO))
    expect(isWellFormed(next, TRIO)).toBe(true)
  })

  it('段内粘贴多行文本——换行被剥掉、其余字符原样保留，不是整笔拒绝', () => {
    const state = makeState({ count: 'a', style: '', character: '' })
    const doc = state.doc.toString()
    const pos = doc.indexOf('a') + 1
    const tr = state.update({ changes: { from: pos, to: pos, insert: 'b\nc\r\nd' } })
    const next = tr.state.doc.toString()

    expect(next).not.toMatch(/[\r\n]/)
    expect(next).toBe(serializeFields({ count: 'abcd', style: '', character: '' }, TRIO))
  })

  it('插入文本里分隔符与换行同时出现——两者都要被剥掉，不能只剥分隔符', () => {
    const state = makeState({ count: 'a', style: '', character: '' })
    const doc = state.doc.toString()
    const pos = doc.indexOf('a') + 1
    const tr = state.update({
      changes: { from: pos, to: pos, insert: `x${BLOCK_SEP}y\nz` },
    })
    const next = tr.state.doc.toString()

    expect(next).not.toMatch(/[\r\n]/)
    expect(next.split(BLOCK_SEP)).toHaveLength(TRIO.length + 1)
    expect(next).toBe(serializeFields({ count: 'axyz', style: '', character: '' }, TRIO))
  })
})
