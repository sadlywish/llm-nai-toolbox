import { describe, expect, it } from 'vitest'
import { fieldWarnings } from '../../src/mobile/src/fieldWarnings'

/**
 * 手机端弹层里那份「问题清单」的口径测试。
 *
 * 两条规则必须分开验：数字紧贴 `::` 所有文字字段都查，全角逗号只查 tags —— 这与桌面端
 * `FieldSpec.flagFullWidthComma` 的口径一致（见 fullWidthComma.ts）。两条混在一起写，
 * 「text 字段误报全角逗号」和「text 字段漏报数字」这两种反向的错都会被同一条用例放过去。
 */
describe('fieldWarnings', () => {
  it('标签末尾数字紧贴 :: 会被列出来', () => {
    expect(fieldWarnings('1.2::artist:as109::', 'tags').map((w) => w.message)).toContain(
      '「109::」会被识别为新加权段的起始。若这是标签末尾的数字，请在数字与 :: 之间加一个空格。',
    )
  })

  it('数字紧贴 :: 在 text 字段同样要报', () => {
    // 这个写法在自然语言里一样会被 NAI 误读，不像全角逗号只对标签串有意义
    expect(fieldWarnings('a girl born in year 2024::', 'text')).toHaveLength(1)
  })

  it('tags 字段的全角逗号会被列出来', () => {
    const hits = fieldWarnings('artist:a，artist:b、c', 'tags')
    expect(hits.map((w) => w.message)).toEqual([
      '「，」不是分隔符，NAI 会把它当普通文字，前后两个 TAG 会被粘成一个。改成半角逗号 ,',
      '「、」不是分隔符，NAI 会把它当普通文字，前后两个 TAG 会被粘成一个。改成半角逗号 ,',
    ])
    expect(hits.map((w) => [w.from, w.to])).toEqual([
      [8, 9],
      [17, 18],
    ])
  })

  it('text 字段的全角逗号不列', () => {
    expect(fieldWarnings('少女，夕阳、逆光', 'text')).toEqual([])
  })

  it('enum 字段的全角逗号也不列', () => {
    // enum 是固定选项（角色的 count），既不是标签串也轮不到用户手打逗号
    expect(fieldWarnings('girl，boy', 'enum')).toEqual([])
  })

  it('两类问题混在一起时按位置从前往后排', () => {
    // 弹层里的红字是按行列出来的，顺序与输入框里从左到右对不上就得让人自己找。
    // 故意把全角逗号放在数字前面：两类命中是分开收集的（数字那批先进数组），
    // 不排序时这里会得到 [7, 1]
    const hits = fieldWarnings('x，y, as109::', 'tags')
    expect(hits.map((w) => w.from)).toEqual([1, 7])
  })

  it('没问题时是空数组', () => {
    expect(fieldWarnings('1girl, solo, 1.2::smile::', 'tags')).toEqual([])
  })
})
