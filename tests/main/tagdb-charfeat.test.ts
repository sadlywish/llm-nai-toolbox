import { describe, expect, it } from 'vitest'
import {
  characterFeatureText,
  characterSearchBlock,
  findCharacterFeature,
  parseCharacterCsv,
} from '../../src/main/tagdb/charfeat'
import { escapeNaiTag, escapeNaiTagList } from '../../src/main/tagdb/escape'

const CSV = [
  '\uFEFFcharacter,copyright,appearance,clothing',
  'hatsune_miku,vocaloid,"long_hair, twintails, aqua_hair","necktie, detached_sleeves"',
  '',
  'saber_(fate),fate_(series),"blonde_hair, green_eyes",armor',
  'broken_line,only_two',
  'miku_append,vocaloid,"aqua_hair",',
].join('\r\n')

describe('escapeNaiTag', () => {
  it('下划线换空格，括号原样保留（NovelAI 不需要转义括号）', () => {
    expect(escapeNaiTag('saber_(fate)')).toBe('saber (fate)')
  })

  it('逗号列表逐个转写、去空项', () => {
    expect(escapeNaiTagList('long_hair, , twintails')).toBe('long hair, twintails')
    expect(escapeNaiTagList('')).toBe('')
  })
})

describe('parseCharacterCsv', () => {
  const db = parseCharacterCsv(CSV)

  it('跳过表头与空行；引号里的逗号不切；少于 4 列的行丢掉', () => {
    expect([...db.keys()]).toEqual(['hatsune_miku', 'saber_(fate)', 'miku_append'])
    expect(db.get('hatsune_miku')).toEqual({
      character: 'hatsune_miku',
      copyright: 'vocaloid',
      appearance: 'long_hair, twintails, aqua_hair',
      clothing: 'necktie, detached_sleeves',
    })
  })

  it('CRLF 行尾不会把 \\r 带进最后一列', () => {
    expect(db.get('saber_(fate)')?.clothing).toBe('armor')
  })
})

describe('findCharacterFeature', () => {
  const db = parseCharacterCsv(CSV)

  it('大小写不敏感、空格当下划线，精确命中优先于排在前面的包含匹配', () => {
    expect(findCharacterFeature(db, 'Hatsune Miku')?.character).toBe('hatsune_miku')
    // saber_(fate) 排在前面且包含 saber：去掉精确分支的话会返回它
    const shadowed = parseCharacterCsv('character,copyright,appearance,clothing\nsaber_(fate),fate,a,b\nsaber,other,c,d\n')
    expect(findCharacterFeature(shadowed, 'Saber')?.character).toBe('saber')
  })

  it('精确没有时取第一个包含查询词的键', () => {
    expect(findCharacterFeature(db, 'miku')?.character).toBe('hatsune_miku')
    expect(findCharacterFeature(db, 'append')?.character).toBe('miku_append')
  })

  it('查不到或查询词为空时给 undefined', () => {
    expect(findCharacterFeature(db, 'nobody')).toBeUndefined()
    expect(findCharacterFeature(db, '   ')).toBeUndefined()
  })
})

describe('角色特征文本', () => {
  const feat = parseCharacterCsv(CSV).get('hatsune_miku')!

  it('search_tags 富化：按三个开关逐行拼，全关时为空串', () => {
    expect(characterFeatureText(feat, { series: true, appearance: true, clothing: false })).toBe(
      '  作品: vocaloid\n  外貌: long hair, twintails, aqua hair',
    )
    expect(characterFeatureText(feat, { series: false, appearance: false, clothing: true })).toBe(
      '  服装: necktie, detached sleeves',
    )
    expect(characterFeatureText(feat, { series: false, appearance: false, clothing: false })).toBe('')
  })

  it('search_character_features 的返回块', () => {
    expect(characterSearchBlock(feat)).toBe(
      [
        '角色: hatsune miku',
        '作品: vocaloid',
        '外貌标签: long hair, twintails, aqua hair → 放入 appearance 字段',
        '服装标签: necktie, detached sleeves → 放入 appearance 字段',
      ].join('\n'),
    )
  })
})
