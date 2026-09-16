import { describe, expect, it } from 'vitest'
import { MAIN_FIELDS, fieldByName } from '@shared/fields'
import { emptyValues } from '@shared/blockDoc'
import { buildPositivePrompt, buildPrompt, hasPromptContent, joinsPrompt } from '@shared/prompt'
import { applyTextRendering } from '@shared/textRendering'
import { defaultAppConfig } from '@shared/config'
import { defaultGenParams } from '@shared/workspace'
import { assemble } from '../../src/main/gen/snapshot'

const values = (v: Record<string, string>) => ({ ...emptyValues(MAIN_FIELDS), ...v })

describe('buildPrompt：与插件 buildPrompt 逐条一致', () => {
  it('各段用 " , " 连接，末尾补 " ,"', () => {
    expect(buildPrompt(values({ count: '1girl', character: 'skadi', artist: 'wlop' }), MAIN_FIELDS)).toBe(
      '1girl , skadi , wlop ,',
    )
  })

  it('空段与只含空白的段被跳过，不留空位', () => {
    expect(buildPrompt(values({ count: '1girl', style: '   ', artist: 'wlop' }), MAIN_FIELDS)).toBe(
      '1girl , wlop ,',
    )
  })

  it('每段首尾空白被 trim，段内空白不动', () => {
    expect(buildPrompt(values({ count: '  1girl,  solo  ' }), MAIN_FIELDS)).toBe('1girl,  solo ,')
  })

  it('字段值自带的尾逗号原样保留', () => {
    expect(buildPrompt(values({ count: '1girl, solo,', character: 'skadi' }), MAIN_FIELDS)).toBe(
      '1girl, solo, , skadi ,',
    )
  })

  it('全空时返回空串，不是孤零零一个逗号', () => {
    expect(buildPrompt(emptyValues(MAIN_FIELDS), MAIN_FIELDS)).toBe('')
  })

  it('顺序取自字段集顺序 —— 调用方按 promptOrder 排好字段集', () => {
    const reordered = ['artist', 'count'].map((n) => fieldByName(MAIN_FIELDS, n)!)
    expect(buildPrompt(values({ count: '1girl', artist: 'wlop' }), reordered)).toBe('wlop , 1girl ,')
  })

  it('字段集里没有的字段不拼进去', () => {
    const onlyCount = [fieldByName(MAIN_FIELDS, 'count')!]
    expect(buildPrompt(values({ count: '1girl', artist: 'wlop' }), onlyCount)).toBe('1girl ,')
  })
})

describe('joinsPrompt', () => {
  it('trim 后非空才进拼接结果', () => {
    expect(joinsPrompt('a')).toBe(true)
    expect(joinsPrompt('  a ')).toBe(true)
    expect(joinsPrompt('')).toBe(false)
    expect(joinsPrompt('   ')).toBe(false)
    expect(joinsPrompt('　')).toBe(false)
  })
})

describe('buildPositivePrompt：复制正面与出图发出去的一致', () => {
  const values = { ...emptyValues(MAIN_FIELDS), count: '1girl', artist: 'artist:wlop', quality: 'masterpiece' }

  it('先按字段拼接，再按画面文字规则处理', () => {
    expect(buildPositivePrompt(values, 'Summer', MAIN_FIELDS)).toBe(applyTextRendering(buildPrompt(values, MAIN_FIELDS), 'Summer').prompt)
    expect(buildPositivePrompt(values, 'Summer', MAIN_FIELDS).endsWith('text: Summer')).toBe(true)
    expect(buildPositivePrompt(values, '', MAIN_FIELDS).endsWith('no text')).toBe(true)
  })

  it('与出图 assemble 的正面逐字相同', () => {
    const snapshot = { main: values, text: '天使', negative: ' lowres ', characters: [], useCoords: false, params: defaultGenParams() }
    expect(assemble(snapshot, defaultAppConfig()).positive).toBe(buildPositivePrompt(values, '天使', MAIN_FIELDS))
  })
})

describe('hasPromptContent', () => {
  it('全空或只有空白 → false；任一字段有字 → true', () => {
    expect(hasPromptContent(emptyValues(MAIN_FIELDS), MAIN_FIELDS)).toBe(false)
    expect(hasPromptContent({ ...emptyValues(MAIN_FIELDS), tags: '   ' }, MAIN_FIELDS)).toBe(false)
    expect(hasPromptContent({ ...emptyValues(MAIN_FIELDS), tags: 'smile' }, MAIN_FIELDS)).toBe(true)
  })

  it('只看传进来的字段集', () => {
    const tags = MAIN_FIELDS.filter((f) => f.name === 'tags')
    expect(hasPromptContent({ ...emptyValues(MAIN_FIELDS), count: '1girl' }, tags)).toBe(false)
  })
})
