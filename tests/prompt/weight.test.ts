import { describe, expect, it } from 'vitest'
import { WEIGHT_STEP, adjustWeight, formatWeight, unitRangeAt } from '@renderer/prompt/weight'

const up = (text: string, pos: number) => adjustWeight(text, pos, pos, WEIGHT_STEP)
const down = (text: string, pos: number) => adjustWeight(text, pos, pos, -WEIGHT_STEP)

describe('formatWeight', () => {
  it('去掉多余的零', () => {
    expect(formatWeight(1.05)).toBe('1.05')
    expect(formatWeight(1.1)).toBe('1.1')
    expect(formatWeight(0.95)).toBe('0.95')
  })

  it('消掉浮点累加的尾巴', () => {
    expect(formatWeight(1.05 + 0.05)).toBe('1.1')
  })
})

describe('unitRangeAt', () => {
  it('取光标所在的逗号分隔单元并去掉两端空白', () => {
    const text = '1girl, artist:wlop, sky'
    expect(unitRangeAt(text, 10)).toEqual({ start: 7, end: 18 })
  })

  it('首个单元从 0 开始', () => {
    expect(unitRangeAt('1girl, sky', 2)).toEqual({ start: 0, end: 5 })
  })

  it('末个单元到文本末尾', () => {
    const text = '1girl, sky'
    expect(unitRangeAt(text, 9)).toEqual({ start: 7, end: 10 })
  })
})

describe('adjustWeight — 包裹', () => {
  it('未加权的标签向上调时包一层 1.05', () => {
    const r = up('1girl, artist:wlop, blue sky', 10)
    expect(r.text).toBe('1girl, 1.05::artist:wlop::, blue sky')
    expect(r.changed).toBe(true)
  })

  it('未加权的标签向下调时包一层 0.95', () => {
    expect(down('1girl, artist:wlop, blue sky', 10).text).toBe(
      '1girl, 0.95::artist:wlop::, blue sky',
    )
  })

  it('标签以数字结尾时，在数字与 :: 之间补空格', () => {
    expect(up('1girl, as109, sky', 8).text).toBe('1girl, 1.05::as109 ::, sky')
  })

  it('有选区时包裹整个选区', () => {
    const r = adjustWeight('a, b c d, e', 3, 8, WEIGHT_STEP)
    expect(r.text).toBe('a, 1.05::b c d::, e')
  })
})

describe('adjustWeight — 改数字', () => {
  it('已加权时只改数字，不再嵌套', () => {
    expect(up('1girl, 1.05::artist:wlop::, blue sky', 16).text).toBe(
      '1girl, 1.1::artist:wlop::, blue sky',
    )
  })

  it('连续上调正确累加', () => {
    let text = '1girl, artist:wlop, sky'
    text = up(text, 10).text
    text = up(text, 16).text
    text = up(text, 16).text
    expect(text).toBe('1girl, 1.15::artist:wlop::, sky')
  })

  it('下调到下限后不再变化', () => {
    const r = down('0.05::x::', 6)
    expect(r.changed).toBe(false)
    expect(r.text).toBe('0.05::x::')
  })
})

describe('adjustWeight — 脱去包裹', () => {
  it('回到 1 时脱去包裹', () => {
    expect(down('1girl, 1.05::artist:wlop::, blue sky', 16).text).toBe(
      '1girl, artist:wlop, blue sky',
    )
  })

  it('从 0.95 上调回 1 也脱去包裹', () => {
    expect(up('1girl, 0.95::artist:wlop::, sky', 16).text).toBe('1girl, artist:wlop, sky')
  })

  it('脱去包裹时一并去掉当初补的尾随空格', () => {
    expect(down('1girl, 1.05::as109 ::, sky', 15).text).toBe('1girl, as109, sky')
  })

  it('包裹与脱包裹是可逆的', () => {
    const original = '1girl, as109, sky'
    expect(down(up(original, 8).text, 15).text).toBe(original)
  })
})

describe('adjustWeight — 边界', () => {
  it('空单元不做任何事', () => {
    const r = up('1girl, , sky', 7)
    expect(r.changed).toBe(false)
    expect(r.text).toBe('1girl, , sky')
  })
})

describe('adjustWeight — 选区位置', () => {
  it('包裹后选中整个新加权段', () => {
    const r = up('1girl, artist:wlop, blue sky', 10)
    expect(r.text).toBe('1girl, 1.05::artist:wlop::, blue sky')
    expect(r.text.slice(r.selectionStart, r.selectionEnd)).toBe('1.05::artist:wlop::')
  })

  it('改数字后选区随数字长度变化而收缩', () => {
    const r = up('1girl, 1.05::artist:wlop::, blue sky', 16)
    expect(r.text).toBe('1girl, 1.1::artist:wlop::, blue sky')
    expect(r.text.slice(r.selectionStart, r.selectionEnd)).toBe('1.1::artist:wlop::')
  })

  it('脱包裹后选中裸标签', () => {
    const r = down('1girl, 1.05::artist:wlop::, blue sky', 16)
    expect(r.text).toBe('1girl, artist:wlop, blue sky')
    expect(r.text.slice(r.selectionStart, r.selectionEnd)).toBe('artist:wlop')
  })
})

describe('adjustWeight — 单元边界', () => {
  it('光标落在多标签加权组内任一标签上都是改外层数字，不会退化成新建嵌套', () => {
    const r = up('1girl, 1.3::artist:a, artist:b::, sky', 15)
    expect(r.text).toBe('1girl, 1.35::artist:a, artist:b::, sky')
  })

  it('全角逗号同样是单元边界', () => {
    const r = up('1girl，artist:wlop，sky', 10)
    expect(r.text).toBe('1girl，1.05::artist:wlop::，sky')
  })

  it('负权重上按 Ctrl+↓ 不生效，不会跳到正数', () => {
    const r = down('-1.5::x::', 6)
    expect(r.changed).toBe(false)
    expect(r.text).toBe('-1.5::x::')
  })
})

describe('adjustWeight — 按编辑器的选区回灌方式连续调整', () => {
  /** 复刻 naiExtensions 里 applyAdjust 的行为：把上一次的选区回灌给下一次 */
  const step = (text: string, sel: { start: number; end: number }, delta: number) => {
    const r = adjustWeight(text, sel.start, sel.end, delta)
    return { text: r.text, sel: { start: r.selectionStart, end: r.selectionEnd } }
  }

  it('连按 Ctrl+↑ 是累加数字，不是层层嵌套', () => {
    let s = step('1girl, artist:wlop, sky', { start: 10, end: 10 }, WEIGHT_STEP)
    expect(s.text).toBe('1girl, 1.05::artist:wlop::, sky')
    s = step(s.text, s.sel, WEIGHT_STEP)
    expect(s.text).toBe('1girl, 1.1::artist:wlop::, sky')
    s = step(s.text, s.sel, WEIGHT_STEP)
    expect(s.text).toBe('1girl, 1.15::artist:wlop::, sky')
  })

  it('Ctrl+↑ 后紧接 Ctrl+↓ 回到原文', () => {
    const original = '1girl, artist:wlop, sky'
    const a = step(original, { start: 10, end: 10 }, WEIGHT_STEP)
    const b = step(a.text, a.sel, -WEIGHT_STEP)
    expect(b.text).toBe(original)
  })

  it('光标落在权重数字上时改数字，不是把数字包起来', () => {
    // 下标：1(0)g(1)i(2)r(3)l(4),(5) (6)1(7).(8)0(9)5(10):(11):(12)
    // 光标 9 落在 1.05 内部，单元 = [7,11) 正是权重数字本身
    const r = up('1girl, 1.05::artist:wlop::, sky', 9)
    expect(r.text).toBe('1girl, 1.1::artist:wlop::, sky')
  })
})

describe('adjustWeight — 光标卡在 :: 中间', () => {
  // `::` 是两字符分隔符，光标停在它正中间在语义上仍属于这个加权段，
  // 应当改数字而不是重新包一层
  it('光标在开启 :: 的两个冒号之间时改数字', () => {
    // 下标：1(0)g(1)i(2)r(3)l(4),(5) (6)1(7).(8)0(9)5(10):(11):(12)
    const r = up('1girl, 1.05::artist:wlop::, sky', 12)
    expect(r.text).toBe('1girl, 1.1::artist:wlop::, sky')
  })

  it('光标在闭合 :: 的两个冒号之间时改数字', () => {
    // 闭合 :: 位于 24、25
    const r = up('1girl, 1.05::artist:wlop::, sky', 25)
    expect(r.text).toBe('1girl, 1.1::artist:wlop::, sky')
  })

  it('嵌套串里光标卡在内层 :: 中间时改内层数字', () => {
    // 0(0).(1)9(2):(3):(4)1(5).(6)2(7):(8):(9)d(10)...
    const r = up('0.9::1.2::deep::, x::', 4)
    expect(r.text).toBe('0.95::1.2::deep::, x::')
  })
})

describe('adjustWeight — 多标签加权组：按整段边界而非逗号子单元判定', () => {
  // 用户的真实场景：一个权重包里含多个 tag。
  // 下标：0(0).(1)8(2):(3):(4)a(5)r(6)t(7)i(8)s(9)t(10):(11)h(12)o(13)u(14)
  //       k(15)i(16)s(17)e(18)i(19),(20) (21)a(22)r(23)t(24)i(25)s(26)t(27)
  //       :(28)m(29)o(30)d(31)a(32)r(33)e(34) (35):(36):(37)
  const base = '0.8::artist:houkisei, artist:modare ::'

  it('光标在第二个 tag（artist:modare）中间：改外层数字，不新建嵌套', () => {
    const r = up(base, 31)
    expect(r.text).toBe('0.85::artist:houkisei, artist:modare ::')
  })

  it('光标在第一个 tag（artist:houkisei）中间：同样改外层数字', () => {
    const r = up(base, 15)
    expect(r.text).toBe('0.85::artist:houkisei, artist:modare ::')
  })

  it('光标在权重数字 0.8 上：保持原本就正确的行为', () => {
    const r = up(base, 1)
    expect(r.text).toBe('0.85::artist:houkisei, artist:modare ::')
  })

  it('光标卡在开头 :: 中间：同样改外层数字', () => {
    const r = up(base, 4)
    expect(r.text).toBe('0.85::artist:houkisei, artist:modare ::')
  })

  it('光标卡在结尾 :: 中间：同样改外层数字', () => {
    const r = up(base, 37)
    expect(r.text).toBe('0.85::artist:houkisei, artist:modare ::')
  })

  it('选中 artist:modare 后 Ctrl+↑：新建一层嵌套，不是改外层', () => {
    // [22, 35) 恰好是 "artist:modare"（含前导 "artist:"，不含尾随空格）
    const r = adjustWeight(base, 22, 35, WEIGHT_STEP)
    expect(r.text).toBe('0.8::artist:houkisei, 1.05::artist:modare:: ::')
  })

  it('嵌套场景：光标落在内层权重范围内时改内层数字，不影响外层', () => {
    // 0(0).(1)9(2):(3):(4)1(5).(6)2(7):(8):(9)d(10)e(11)e(12)p(13):(14):(15)
    const r = up('0.9::1.2::deep::, x::', 11)
    expect(r.text).toBe('0.9::1.25::deep::, x::')
  })

  it('光标在权重之外的普通 tag 上：仍是新建权重', () => {
    const withPlainTag = `${base}, 1girl`
    const r = up(withPlainTag, withPlainTag.length - 3)
    expect(r.text).toBe(`${base}, 1.05::1girl::`)
  })

  it('多标签权重组内连按两次 Ctrl+↑ 是累加数字，不是层层嵌套', () => {
    const step = (text: string, sel: { start: number; end: number }, delta: number) => {
      const r = adjustWeight(text, sel.start, sel.end, delta)
      return { text: r.text, sel: { start: r.selectionStart, end: r.selectionEnd } }
    }
    let s = step(base, { start: 15, end: 15 }, WEIGHT_STEP)
    expect(s.text).toBe('0.85::artist:houkisei, artist:modare ::')
    s = step(s.text, s.sel, WEIGHT_STEP)
    expect(s.text).toBe('0.9::artist:houkisei, artist:modare ::')
    s = step(s.text, s.sel, WEIGHT_STEP)
    expect(s.text).toBe('0.95::artist:houkisei, artist:modare ::')
  })
})
