import { describe, expect, it } from 'vitest'
import { defaultAppConfig } from '../../../src/shared/config'
import { createCharacter, emptyWorkspace } from '../../../src/shared/workspace'
import { assemble, takeSnapshot } from '../../../src/main/gen/snapshot'

function workspace() {
  const ws = emptyWorkspace()
  ws.main.count = '1girl'
  ws.main.artist = 'artist:wlop'
  ws.negative = ' lowres '
  const a = createCharacter()
  a.fields.count = 'girl'
  a.fields.character = 'miku'
  a.negative = ' bad hands '
  a.position = '0.3,0.5'
  const off = createCharacter()
  off.enabled = false
  off.fields.character = 'rin'
  const b = createCharacter()
  b.fields.character = 'len'
  ws.characters = [a, off, b]
  ws.useCoords = true
  ws.params.seed = 7
  return ws
}

describe('takeSnapshot', () => {
  it('只收参与本轮的角色；是副本，之后改工作区不影响快照', () => {
    const ws = workspace()
    const s = takeSnapshot(ws, null)
    expect(s.characters.map((c) => c.fields.character)).toEqual(['miku', 'len'])
    expect(s.characters[0]).toEqual({ fields: ws.characters[0].fields, negative: ' bad hands ', position: '0.3,0.5' })
    ws.main.count = 'changed'
    ws.characters[0].fields.character = 'changed'
    ws.params.steps = 99
    expect([s.main.count, s.characters[0].fields.character, s.params.steps]).toEqual(['1girl', 'miku', 28])
    expect([s.text, s.negative, s.useCoords, s.params.seed]).toEqual(['', ' lowres ', true, 7])
  })

  it('固定 seed 解析出的值写进快照的 params.seed', () => {
    expect(takeSnapshot(workspace(), 123).params.seed).toBe(123)
  })
})

describe('assemble', () => {
  it('按字段顺序拼接，再经画面文字处理；角色按角色字段顺序拼接', () => {
    const a = assemble(takeSnapshot(workspace(), null), defaultAppConfig())
    expect(a.positive).toBe('1girl , artist:wlop, no text')
    expect(a.negative).toBe('lowres')
    expect(a.characters).toEqual([
      { prompt: 'girl , miku ,', negative: 'bad hands', center: { x: 0.3, y: 0.5 } },
      { prompt: 'len ,', negative: '', center: { x: 0.5, y: 0.5 } },
    ])
  })

  it('字段顺序取设置里的 promptOrder', () => {
    const cfg = { ...defaultAppConfig(), promptOrder: 'artist, count, style, character, appearance, tags, environment, series, nltags, quality' }
    expect(assemble(takeSnapshot(workspace(), null), cfg).positive).toBe('artist:wlop , 1girl, no text')
  })

  it('有画面文字时按插件规则接到末尾', () => {
    // 注：applyTextRendering 在「有渲染文字」分支里用 afterNoText.join(', ') 整体重连
    // （逐字照抄 koishi 源码 nai-api.ts:382-387），这一步会把 buildPrompt 拼出来的
    // ' , ' 分隔符统一收成 ', '——即使没有 no text 需要摘除也一样。已用独立脚本复现
    // koishi 源算法验证过这不是移植偏差；brief 手算的期望值漏看了这一步。
    const ws = workspace()
    ws.text = 'Hello'
    expect(assemble(takeSnapshot(ws, null), defaultAppConfig()).positive).toBe('1girl, artist:wlop, text, english text, "Hello", text: Hello')
  })

  it('角色负面词独立：角色没写就是空，不拿整图负面词补', () => {
    const a = assemble(takeSnapshot(workspace(), null), defaultAppConfig())
    expect(a.characters[1].negative).toBe('')
  })
})
