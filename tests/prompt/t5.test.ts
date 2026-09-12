import { describe, expect, it } from 'vitest'
import { estimateT5Tokens, isV5Model, tokenLimitFor } from '@renderer/prompt/t5'

describe('estimateT5Tokens', () => {
  it('空串为 0', () => {
    expect(estimateT5Tokens('')).toBe(0)
  })

  it('英文按每 4 字符 1 token 向上取整，每词至少 1', () => {
    // "1girl"(5→2) + "sky"(3→1) + 1 个逗号
    expect(estimateT5Tokens('1girl, sky')).toBe(4)
  })

  it('中文按每字 1.5 token 估', () => {
    // 4 个汉字 → ceil(6) = 6
    expect(estimateT5Tokens('一二三四')).toBe(6)
  })

  it('标点单独计数', () => {
    expect(estimateT5Tokens(',,,')).toBe(3)
  })

})

describe('isV5Model', () => {
  it('识别 V5 模型', () => {
    expect(isV5Model('nai-diffusion-5-full')).toBe(true)
    expect(isV5Model('nai-diffusion-5-curated')).toBe(true)
  })

  it('不把 V4.5 当成 V5', () => {
    // 关键用例：'nai-diffusion-4-5-full' 里含 '-5-'，
    // 用宽松正则（如 /(^|-)5([-.]|$)/）会误判成 V5
    expect(isV5Model('nai-diffusion-4-5-full')).toBe(false)
    expect(isV5Model('nai-diffusion-4-5-curated')).toBe(false)
  })

  it('不把更早的模型当成 V5', () => {
    expect(isV5Model('nai-diffusion-4-full')).toBe(false)
    expect(isV5Model('nai-diffusion-3')).toBe(false)
  })
})

describe('tokenLimitFor', () => {
  it('V5 的上限是 1471', () => {
    expect(tokenLimitFor('nai-diffusion-5-full')).toBe(1471)
  })

  it('V4 / V4.5 的上限是 512', () => {
    expect(tokenLimitFor('nai-diffusion-4-5-full')).toBe(512)
    expect(tokenLimitFor('nai-diffusion-4-full')).toBe(512)
  })

  it('未知或自定义模型按更保守的 512 处理', () => {
    // 早报警无害，漏报才是真问题
    expect(tokenLimitFor('')).toBe(512)
    expect(tokenLimitFor('custom-endpoint-model')).toBe(512)
  })
})
