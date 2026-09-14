import { describe, expect, it } from 'vitest'
import { BLOCK_SEP } from '@shared/blockDoc'
import { CHARACTER_FIELDS, MAIN_FIELDS } from '@shared/fields'
import { alignTo64 } from '@shared/naiOptions'
import {
  createCharacter,
  defaultGenParams,
  emptyWorkspace,
  normalizeWorkspace,
  type Workspace,
} from '@shared/workspace'

const names = (specs: readonly { name: string }[]): string[] => specs.map((s) => s.name).sort()

describe('默认值', () => {
  it('空工作区：整图字段全空、没有角色、坐标定位关', () => {
    const ws = emptyWorkspace()
    expect(Object.keys(ws.main).sort()).toEqual(names(MAIN_FIELDS))
    expect(Object.values(ws.main).every((v) => v === '')).toBe(true)
    expect(ws.text).toBe('')
    expect(ws.negative).toBe('')
    expect(ws.characters).toEqual([])
    expect(ws.useCoords).toBe(false)
  })

  it('默认参数照插件：28 步、CFG 5、宽高已对齐 64；没有负面预设、质量词、Variety Boost', () => {
    const p = defaultGenParams()
    expect(p.steps).toBe(28)
    expect(p.scale).toBe(5)
    for (const key of ['ucPreset', 'qualityToggle', 'varietyBoost']) expect(key in p).toBe(false)
    expect(p.width).toBe(alignTo64(p.width))
    expect(p.height).toBe(alignTo64(p.height))
    expect(p.transparentBackground).toBe(false)
  })

  it('每次返回新对象', () => {
    const a = defaultGenParams()
    a.steps = 1
    expect(defaultGenParams().steps).toBe(28)
    expect(emptyWorkspace().params).not.toBe(emptyWorkspace().params)
  })

  it('新角色：五个字段全空、参与本轮、id 互不相同', () => {
    const a = createCharacter()
    const b = createCharacter()
    expect(Object.keys(a.fields).sort()).toEqual(names(CHARACTER_FIELDS))
    expect(a.enabled).toBe(true)
    expect(a.negative).toBe('')
    expect(a.position).toBe('')
    expect(a.id).not.toBe(b.id)
  })
})

describe('normalizeWorkspace', () => {
  it('不是对象时给空工作区', () => {
    expect(normalizeWorkspace(null).characters).toEqual([])
    expect(normalizeWorkspace('x').main.count).toBe('')
  })

  it('合法工作区原样通过', () => {
    const ws: Workspace = {
      ...emptyWorkspace(),
      main: { ...emptyWorkspace().main, count: '1girl', artist: 'artist:wlop' },
      text: 'HELLO',
      negative: 'lowres',
      characters: [{ ...createCharacter(), position: '0.3,0.5' }],
      useCoords: true,
    }
    const plain = JSON.parse(JSON.stringify(ws)) as unknown
    expect(normalizeWorkspace(plain)).toEqual(ws)
  })

  it('缺的项补默认值，不认识的键丢弃', () => {
    const ws = normalizeWorkspace({ text: 'T', artistSets: [] })
    expect(ws.text).toBe('T')
    expect(ws.params).toEqual(defaultGenParams())
    expect('artistSets' in ws).toBe(false)
  })

  it('字段值里的换行与分隔符被剥掉 —— 分块文档必须是单行', () => {
    const ws = normalizeWorkspace({ main: { count: `1girl\n${BLOCK_SEP}solo` } })
    expect(ws.main.count).toBe('1girlsolo')
  })

  it('不认识的字段名丢弃，缺的字段补空串', () => {
    const ws = normalizeWorkspace({ main: { lora: 'x', count: 'a' } })
    expect(Object.keys(ws.main).sort()).toEqual(names(MAIN_FIELDS))
    expect(ws.main.count).toBe('a')
  })

  it('角色：不是数组给空数组；不是对象的条目丢弃', () => {
    expect(normalizeWorkspace({ characters: 'x' }).characters).toEqual([])
    expect(normalizeWorkspace({ characters: [1, null, { fields: { character: 'skadi' } }] }).characters).toHaveLength(1)
  })

  it('角色：缺 id 或 id 重复时补新 id —— 重复 id 会让两个编辑器共用一个实例', () => {
    const ws = normalizeWorkspace({ characters: [{ id: 'ch-1' }, { id: 'ch-1' }, {}] })
    const ids = ws.characters.map((c) => c.id)
    expect(new Set(ids).size).toBe(3)
    expect(ids[0]).toBe('ch-1')
  })

  it('角色的字段集是角色的五项，不是整图的十项', () => {
    const ws = normalizeWorkspace({ characters: [{ fields: { artist: 'x', character: 'skadi' } }] })
    expect(Object.keys(ws.characters[0].fields).sort()).toEqual(names(CHARACTER_FIELDS))
    expect(ws.characters[0].fields.character).toBe('skadi')
  })

  it('参数：旧版本存下的负面预设、质量词、Variety Boost 丢弃', () => {
    const ws = normalizeWorkspace({ params: { ucPreset: 0, qualityToggle: true, varietyBoost: true } })
    for (const key of ['ucPreset', 'qualityToggle', 'varietyBoost']) expect(key in ws.params).toBe(false)
  })

  it('参数：类型不对或不是有限数的项回默认值，seedMode 不在范围回每张随机', () => {
    const ws = normalizeWorkspace({ params: { steps: '30', scale: Number.NaN, seedMode: 'always', width: 896 } })
    expect(ws.params.steps).toBe(28)
    expect(ws.params.scale).toBe(5)
    expect(ws.params.seedMode).toBe('perImage')
    expect(ws.params.width).toBe(896)
  })

  it('参数：采样器、噪声调度不在选项表里时回默认值；模型允许自定义名', () => {
    const ws = normalizeWorkspace({
      params: {
        sampler: 'k_bogus',
        noiseSchedule: 'linear',
        model: 'my-custom-model',
      },
    })
    expect(ws.params.sampler).toBe('k_euler_ancestral')
    expect(ws.params.noiseSchedule).toBe('karras')
    // 合法但非默认的采样器要保留，不能被误判成非法
    expect(normalizeWorkspace({ params: { sampler: 'k_dpmpp_2m' } }).params.sampler).toBe('k_dpmpp_2m')
    // 模型名不校验：V5 系列名未公布，允许用户手填自定义名
    expect(ws.params.model).toBe('my-custom-model')
  })
})

describe('指令区选项', () => {
  it('空工作区带默认的指令区选项', () => {
    expect(emptyWorkspace().console).toEqual({
      instruction: '',
      multiCharacter: 'off',
      editExisting: false,
      transparent: false,
      styleMode: 'none',
      presetId: '',
      autoGenerate: false,
    })
  })

  it('读回时逐项校验：枚举不认识回默认，类型不对回默认，合法值保留', () => {
    const ws = normalizeWorkspace({
      console: { instruction: '画初音', multiCharacter: 'on', editExisting: 'yes', transparent: true, styleMode: 'preset', presetId: 7 },
    })
    expect(ws.console).toEqual({
      instruction: '画初音',
      multiCharacter: 'off',
      editExisting: false,
      transparent: true,
      styleMode: 'preset',
      presetId: '',
      autoGenerate: false,
    })
    expect(normalizeWorkspace({ console: { multiCharacter: 'coords', styleMode: 'x' } }).console).toMatchObject({
      multiCharacter: 'coords',
      styleMode: 'none',
    })
  })
})

describe('跑图次数与自动生成', () => {
  it('默认跑 1 张、不自动生成', () => {
    const ws = emptyWorkspace()
    expect([ws.runCount, ws.console.autoGenerate]).toEqual([1, false])
  })

  it('跑图次数只认正整数；自动生成只认布尔', () => {
    expect(normalizeWorkspace({ runCount: 4 }).runCount).toBe(4)
    for (const runCount of [0, -2, 1.5, '3', null]) expect(normalizeWorkspace({ runCount }).runCount).toBe(1)
    expect(normalizeWorkspace({ console: { autoGenerate: true } }).console.autoGenerate).toBe(true)
    expect(normalizeWorkspace({ console: { autoGenerate: 'yes' } }).console.autoGenerate).toBe(false)
  })
})
