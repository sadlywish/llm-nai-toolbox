import { describe, expect, it } from 'vitest'
import {
  CHARACTER_FIELDS,
  DEFAULT_CHAR_PROMPT_ORDER,
  DEFAULT_PROMPT_ORDER,
  MAIN_FIELDS,
  fieldByName,
} from '@shared/fields'

const namesOf = (specs: readonly { name: string }[]): string[] => specs.map((s) => s.name)
const splitOrder = (order: string): string[] => order.split(',').map((s) => s.trim())

describe('字段集', () => {
  it('整图 10 项，角色 5 项', () => {
    expect(MAIN_FIELDS).toHaveLength(10)
    expect(CHARACTER_FIELDS).toHaveLength(5)
  })

  it('整图顺序与 promptOrder 默认值逐项相等', () => {
    expect(namesOf(MAIN_FIELDS)).toEqual(splitOrder(DEFAULT_PROMPT_ORDER))
  })

  it('角色顺序与 naiCharPromptOrder 默认值逐项相等', () => {
    expect(namesOf(CHARACTER_FIELDS)).toEqual(splitOrder(DEFAULT_CHAR_PROMPT_ORDER))
  })
})

describe('两套字段集不可混用', () => {
  it('整图专属字段不出现在角色集里', () => {
    for (const name of ['artist', 'style', 'environment', 'series', 'quality']) {
      expect(fieldByName(CHARACTER_FIELDS, name)).toBeUndefined()
    }
  })

  it('position 与 negative_prompt 是参数不是字段，两套集合里都没有', () => {
    for (const specs of [MAIN_FIELDS, CHARACTER_FIELDS]) {
      expect(fieldByName(specs, 'position')).toBeUndefined()
      expect(fieldByName(specs, 'negative_prompt')).toBeUndefined()
    }
  })

  it('count 在整图是自由标签，在角色是三选一枚举', () => {
    expect(fieldByName(MAIN_FIELDS, 'count')?.input).toBe('tags')
    const charCount = fieldByName(CHARACTER_FIELDS, 'count')
    expect(charCount?.input).toBe('enum')
    expect(charCount?.options).toEqual(['girl', 'boy', 'other'])
  })
})

describe('字段属性', () => {
  it('同名字段两套集合里色相相同', () => {
    for (const name of ['count', 'character', 'appearance', 'tags', 'nltags']) {
      const a = fieldByName(MAIN_FIELDS, name)
      const b = fieldByName(CHARACTER_FIELDS, name)
      expect(a?.hue).toBe(b?.hue)
    }
  })

  it('只有 tags 形态标全角逗号', () => {
    for (const specs of [MAIN_FIELDS, CHARACTER_FIELDS]) {
      for (const spec of specs) {
        expect(spec.flagFullWidthComma).toBe(spec.input === 'tags')
      }
    }
  })

  it('nltags 是自然语言，不标全角逗号也不补全', () => {
    for (const specs of [MAIN_FIELDS, CHARACTER_FIELDS]) {
      const nl = fieldByName(specs, 'nltags')
      expect(nl?.input).toBe('text')
      expect(nl?.flagFullWidthComma).toBe(false)
      expect(nl?.completion).toBeNull()
    }
  })

  it('色相避开 340~360 与 0~10 的红色区间，红留给错误标记', () => {
    for (const spec of MAIN_FIELDS) {
      expect(spec.hue >= 10 && spec.hue <= 340).toBe(true)
    }
  })
})
