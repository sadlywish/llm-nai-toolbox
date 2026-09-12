import { describe, expect, it } from 'vitest'
import {
  completionKeys,
  foldForCompletion,
  matchStarts,
  matchesAt,
} from '@shared/tagdb/completionMatch'

describe('foldForCompletion', () => {
  it('小写 + 下划线折成空格', () => {
    expect(foldForCompletion('Blue_Hair')).toBe('blue hair')
  })

  it('保留括号等符号 —— 词首匹配靠它们定位词边界', () => {
    expect(foldForCompletion('wlop_(fanart)')).toBe('wlop (fanart)')
  })

  it('日文新字体折叠成简体', () => {
    // CJK_VARIANT_PAIRS 里有 絵→绘、桜→樱
    expect(foldForCompletion('絵')).toBe('绘')
    expect(foldForCompletion('桜Miku_(vocaloid)')).toBe('樱miku (vocaloid)')
  })

  it('不改变长度 —— 折叠后下标还对得上', () => {
    const s = '桜Miku_(vocaloid)'
    expect(foldForCompletion(s).length).toBe(s.length)
  })
})

describe('matchStarts：可匹配位置', () => {
  it('下标 0 总是可匹配位置', () => {
    expect(matchStarts('blue')).toContain(0)
  })

  it('纯字母串只有下标 0', () => {
    expect(matchStarts('blue')).toEqual([0])
  })

  it('空格之后是词首，空格本身不是 —— 它前面是字母 e', () => {
    expect(matchStarts('blue hair')).toEqual([0, 5])
  })

  it('括号前后都算边界', () => {
    // "wlop (fanart)"：0=w；4 是空白，跳过；5=( 前面是空格；6=f 前面是 (；
    // 12=) 前面是字母 t 而它自己不是字母，边界成立
    expect(matchStarts('wlop (fanart)')).toEqual([0, 5, 6, 12])
  })

  it('CJK 紧跟拉丁字母也是边界 —— 这是和 tagcomplete 判据的唯一差别', () => {
    // "cos初音"：0=c；3=初 前面是字母 s 而它自己不是字母；4=音 前面是 初
    expect(matchStarts('cos初音')).toEqual([0, 3, 4])
  })

  it('空白本身不是可匹配位置 —— 查询词已 trim，不可能以空白开头', () => {
    expect(matchStarts('blue hair')).not.toContain(4)
  })

  it('CJK 每个位置都是词首 —— CJK 字符不是 a-z，规则退化成任意位置子串', () => {
    expect(matchStarts('蓝发')).toEqual([0, 1])
  })

  it('数字之后也算词首 —— 只有 a-z 会挡住后面的位置', () => {
    expect(matchStarts('2girls')).toEqual([0, 1])
  })

  it('空串没有可匹配位置', () => {
    expect(matchStarts('')).toEqual([])
  })
})

describe('matchesAt：词首命中判定', () => {
  it('整名开头命中', () => {
    expect(matchesAt('blue hair', 'bl')).toBe(true)
  })

  it('第二个词的开头也命中 —— 这是和「整名前缀」的关键区别', () => {
    expect(matchesAt('sky blue', 'bl')).toBe(true)
    expect(matchesAt('blue hair', 'hair')).toBe(true)
  })

  it('词中间不命中', () => {
    expect(matchesAt('blue hair', 'ue')).toBe(false)
    expect(matchesAt('table', 'able')).toBe(false)
  })

  it('跨词的连续查询能命中 —— 下划线已折成空格', () => {
    expect(matchesAt('blue hair', 'blue h')).toBe(true)
  })

  it('括号后的词也算词首', () => {
    expect(matchesAt('wlop (fanart)', 'fan')).toBe(true)
  })

  it('CJK 查询在任意位置命中', () => {
    expect(matchesAt('初音未来', '未来')).toBe(true)
    expect(matchesAt('初音未来', '音')).toBe(true)
  })

  it('CJK 紧跟拉丁字母之后也命中', () => {
    expect(matchesAt('cos初音', '初音')).toBe(true)
  })

  it('查询比名字长时不命中', () => {
    expect(matchesAt('bl', 'blue')).toBe(false)
  })

  it('空查询不命中 —— 调用方负责拦掉，这里不当成「全都命中」', () => {
    expect(matchesAt('blue hair', '')).toBe(false)
  })
})

describe('completionKeys：索引键', () => {
  it('每个词首取两个字符', () => {
    expect(completionKeys('blue hair')).toEqual(['bl', 'ha'])
  })

  it('同一个键只出现一次', () => {
    // "blue blue" 的两个词首都产 bl
    expect(completionKeys('blue blue')).toEqual(['bl'])
  })

  it('末尾不足两个字符时取剩下的 —— 这样单字符的名字也有键', () => {
    expect(completionKeys('a')).toEqual(['a'])
  })

  it('空串不产键', () => {
    expect(completionKeys('')).toEqual([])
  })

  it('CJK 每个位置都产键，末位产单字符键', () => {
    expect(completionKeys('初音未来')).toEqual(['初音', '音未', '未来', '来'])
  })

  it('括号后的词与收尾括号都产键', () => {
    expect(completionKeys(foldForCompletion('wlop_(fanart)'))).toEqual(['wl', '(f', 'fa', ')'])
  })

  it('键覆盖所有可匹配位置 —— 任何 matchesAt 命中的查询，其前两字符必在键里', () => {
    const folded = foldForCompletion('wlop_(fanart)')
    for (const q of ['wl', 'fa', '(f']) {
      expect(matchesAt(folded, q)).toBe(true)
      expect(completionKeys(folded)).toContain(q)
    }
  })
})
