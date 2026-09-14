import { describe, expect, it } from 'vitest'
import { normalizeWeights } from '../../src/renderer/src/prompt/normalizeWeights'

describe('normalizeWeights：老 NAI 花括号 / 方括号', () => {
  it('{x} → 1.05::x::', () => {
    expect(normalizeWeights('{artist:wlop}').text).toBe('1.05::artist:wlop::')
  })

  it('[x] → 0.95::x::（基数 1.05，不是 webui 的 1.1）', () => {
    expect(normalizeWeights('[artist:wlop]').text).toBe('0.95::artist:wlop::')
  })

  // 用户选的是简单转换：每层按**写出来的那个数**再乘一次，而不是先算精确
  // 幂再取整。所以 [[x]] 是 0.95÷1.05 → 0.9，不是 (1/1.05)² → 0.91。
  it('嵌套折叠成一次乘法，逐层按已四舍五入的数再乘', () => {
    expect(normalizeWeights('{{x}}').text).toBe('1.1::x::')
    expect(normalizeWeights('{{{x}}}').text).toBe('1.16::x::')
    expect(normalizeWeights('[[x]]').text).toBe('0.9::x::')
  })

  it('内容不是单一权重段时照常套外层', () => {
    expect(normalizeWeights('{a, 1.2::b::}').text).toBe('1.05::a, 1.2::b::::')
  })

  it('不闭合的括号原样留着，交给编辑器诊断，不顺手修', () => {
    expect(normalizeWeights('{artist:a, 1girl').text).toBe('{artist:a, 1girl')
  })
})

describe('normalizeWeights：webui 圆括号', () => {
  it('(x:1.3) → 1.3::x::', () => {
    expect(normalizeWeights('(masterpiece:1.3)').text).toBe('1.3::masterpiece::')
  })

  // 用户拍板：裸括号一律不动。Danbooru 角色 tag 大量长成
  // `daiwa scarlet (umamusume)`，当权重转掉会静默毁掉 tag，
  // 而两种形态在文本上无法可靠区分。
  it('裸 (x) 一律不动——角色名里的括号不能被毁掉', () => {
    const r = normalizeWeights('1girl, daiwa scarlet (umamusume), smile')
    expect(r.text).toBe('1girl, daiwa scarlet (umamusume), smile')
    expect(r.weights).toBe(0)
  })

  it('裸括号本身不动，但内部的 {} 与 @ 照转', () => {
    expect(normalizeWeights('scarlet ({umamusume})').text).toBe('scarlet (1.05::umamusume::)')
    expect(normalizeWeights('a (@wlop)').text).toBe('a (artist:wlop)')
  })

  it('显式权重里嵌花括号：两者都转', () => {
    expect(normalizeWeights('({x}:1.2)').text).toBe('1.26::x::')
  })
})

describe('normalizeWeights：@ 标记', () => {
  it('@wlop → artist:wlop', () => {
    const r = normalizeWeights('1girl, @wlop, sky')
    expect(r.text).toBe('1girl, artist:wlop, sky')
    expect(r.artists).toBe(1)
  })

  it('多个 @ 全部替换，已经是 artist: 的不重复计数', () => {
    const r = normalizeWeights('@a, artist:b, @c')
    expect(r.text).toBe('artist:a, artist:b, artist:c')
    expect(r.artists).toBe(2)
  })

  it('@ 在权重里也替换', () => {
    expect(normalizeWeights('{@wlop}').text).toBe('1.05::artist:wlop::')
  })
})

describe('normalizeWeights：计数', () => {
  it('没有可转的东西时计数为 0、文本不变', () => {
    const r = normalizeWeights('1girl, artist:wlop, 0.8::sky::')
    expect(r.text).toBe('1girl, artist:wlop, 0.8::sky::')
    expect(r).toEqual({ text: '1girl, artist:wlop, 0.8::sky::', weights: 0, artists: 0 })
  })

  it('已有的 :: 权重不受影响', () => {
    expect(normalizeWeights('0.6::artist:a::, {b}').text).toBe('0.6::artist:a::, 1.05::b::')
  })

  it('嵌套计数按实际包裹层数算', () => {
    expect(normalizeWeights('{{x}}').weights).toBe(2)
  })
})
