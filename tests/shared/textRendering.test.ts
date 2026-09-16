import { describe, expect, it } from 'vitest'
import { applyTextRendering } from '../../src/shared/textRendering'

describe('applyTextRendering', () => {
  it('没有画面文字：补 no text', () => {
    const r = applyTextRendering('1girl , solo ,', '')
    expect(r.prompt).toBe('1girl , solo, no text')
    expect(r.notes).toEqual(['未指定渲染文字，已补 no text 抑制画面乱码文字'])
  })

  it('已经有 no text 时不重复补', () => {
    expect(applyTextRendering('1girl , no text ,', '')).toEqual({ prompt: '1girl , no text ,', notes: [] })
  })

  it('正文中途的 text: 改写成 text=，内容保留', () => {
    const r = applyTextRendering('1girl , sign with text: hello ,', '')
    expect(r.prompt).toBe('1girl , sign with text= hello, no text')
    expect(r.notes[0]).toBe('提示词中已有 1 处 text: 标记，已改写为 text= 以免触发文本渲染（内容保留）')
  })

  it('中文画面文字：去掉 no text，补 text 与 chinese text，正文加引号，末尾接 text:', () => {
    const r = applyTextRendering('1girl , no text ,', '天使')
    expect(r.prompt).toBe('1girl, text, chinese text, "天使", text: 天使')
    expect(r.notes).toContain('已移除 no text（与文本渲染冲突）')
  })

  it('英文画面文字用 english text', () => {
    expect(applyTextRendering('sign ,', 'Hello').prompt).toBe('sign, text, english text, "Hello", text: Hello')
  })

  it('多段引号只取最长的一段', () => {
    const r = applyTextRendering('a ,', '"天使" 和 "降临了"')
    expect(r.prompt).toBe('a, text, chinese text, "降临了", text: 降临了')
    expect(r.notes[0]).toBe('text 字段含 2 段文字，只能强化一段，已取最长的一段："降临了"')
  })

  it('去掉包在外面的中文引号', () => {
    expect(applyTextRendering('a ,', '“天使”').prompt).toBe('a, text, chinese text, "天使", text: 天使')
  })
})
