import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReadImageInput } from '../../src/shared/gen'
import { isWithinDir, readRoundImage, readRoundImageMeta } from '../../src/main/nai/index-store'
import { dateDirName } from '../../src/main/nai/save'

// 越权用例要断言「守卫生效时压根没碰磁盘」，但 existsSync/readFileSync 是
// Node 内置模块的导出，属性不可配置，直接 vi.spyOn(fs, ...) 会报
// "Cannot redefine property"——只能连整个模块一起 mock 掉再包一层 vi.fn，
// 其余函数原样透传，不影响 mkdtempSync/writeFileSync 这些测试自己要用的
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
  }
})

// 只有「越出 saveDir」那一条用例需要伪造 dateDirName 的返回值来模拟路径穿越，
// 其余用例都要走真实实现（同一天的目录名才对得上磁盘上真实建的目录）。
// 消费完 mockReturnValueOnce 会自动落回 actual，不会漏到别的用例里
vi.mock('../../src/main/nai/save', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/nai/save')>()
  return { ...actual, dateDirName: vi.fn(actual.dateDirName) }
})

let root: string
const startedAt = '2026-09-09T04:00:00.000Z' // 本地时间 2026-09-09（UTC+8 不跨零点）

function input(file: string): ReadImageInput {
  return { roundStartedAt: startedAt, file }
}

beforeEach(() => {
  vi.mocked(existsSync).mockClear()
  vi.mocked(readFileSync).mockClear()
  root = mkdtempSync(join(tmpdir(), 'ast-image-read-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('isWithinDir', () => {
  // readRoundImage 里「file 必须是裸文件名」那道校验一旦失效（bug、或
  // 未来某次改动漏掉），isWithinDir 是唯一还能拦住路径穿越的第二道防线，
  // 而它的价值完全系于「规范化后按前缀比较」这一个实现细节——一旦被
  // 「简化」成裸的 target.startsWith(root)，下面这条陷阱用例是唯一能
  // 测出区别的（下面 readRoundImage 的越权用例全部测不出来：它们的
  // target 要么落在 root 真正的子目录里，要么落在名字完全不同的目录里，
  // 两种情况裸 startsWith 和规范化前缀比较给出的答案碰巧一样）
  it('C:\\a 与 C:\\ab 只是共享字符前缀，不是父子目录，必须判定为不在其内', () => {
    expect(isWithinDir('C:\\a', 'C:\\ab\\x.png')).toBe(false)
  })

  it('真正的子路径判定为在其内', () => {
    expect(isWithinDir('C:\\a', 'C:\\a\\x.png')).toBe(true)
  })

  it('target 就是 root 本身也算在其内（file 非空由上层裸文件名校验保证）', () => {
    expect(isWithinDir('C:\\a', 'C:\\a')).toBe(true)
  })

  it('root 结尾带不带分隔符，判定结果一致', () => {
    expect(isWithinDir('C:\\a\\', 'C:\\a\\x.png')).toBe(true)
    expect(isWithinDir('C:\\a\\', 'C:\\ab\\x.png')).toBe(false)
  })
})

describe('readRoundImage', () => {
  it('正常读回字节', () => {
    const dir = join(root, '2026-09-09')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '00001-42.png'), Buffer.from('IMG'))

    const bytes = readRoundImage(root, input('00001-42.png'))
    expect(bytes).not.toBeNull()
    expect(Buffer.from(bytes as ArrayBuffer).toString()).toBe('IMG')
  })

  it('文件不存在返回 null', () => {
    const dir = join(root, '2026-09-09')
    mkdirSync(dir, { recursive: true })
    expect(readRoundImage(root, input('nope.png'))).toBeNull()
  })

  describe('越权输入一律返回 null，且不触碰磁盘', () => {
    // 每条用例都在同一个位置放一份真实存在的文件——如果对应的守卫被去掉，
    // 校验会失败到「读到了内容」而不是继续返回 null，能明确指向具体是哪道
    // 守卫失效，而不是掩盖在同一个 null 断言背后
    beforeEach(() => {
      const dir = join(root, '2026-09-09')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'evil.png'), Buffer.from('SECRET'))
    })

    it.each([
      ['等于 ..', '..'],
      ['等于 .', '.'],
      ['含 .. 路径段', '../evil.png'],
      ['含正斜杠', 'sub/evil.png'],
      ['含反斜杠', 'sub\\evil.png'],
      ['是绝对路径（POSIX）', '/etc/evil.png'],
      ['是绝对路径（Windows 盘符）', 'C:\\evil.png'],
    ])('file %s 时返回 null 且不读磁盘', (_label, file) => {
      expect(readRoundImage(root, input(file))).toBeNull()
      expect(existsSync).not.toHaveBeenCalled()
      expect(readFileSync).not.toHaveBeenCalled()
    })
  })

  describe('file/roundStartedAt 不是字符串时返回 null，且不触碰磁盘', () => {
    // ReadImageInput 的类型只是编译期的文档，IPC 传输不做运行时校验——
    // 「调用方一定传字符串」也是一种不该有的假设。非字符串能穿过裸文件名
    // 校验的字符串专用判断（正则 .test() 会把参数强转成字符串，未必命中），
    // 最后在 path.join 里抛出未捕获异常而不是返回 null，破坏了这个函数
    // 对调用方「返回 ArrayBuffer | null」的承诺
    beforeEach(() => {
      const dir = join(root, '2026-09-09')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'evil.png'), Buffer.from('SECRET'))
    })

    function malformed(file: unknown): ReadImageInput {
      return { roundStartedAt: startedAt, file } as ReadImageInput
    }

    // 与 malformed 同形：参数标 unknown 才能断言成 ReadImageInput。
    // 内联一个数字字面量去断言会被 tsc 拒绝（TS2352：两个类型没有足够重叠）
    function malformedStartedAt(roundStartedAt: unknown): ReadImageInput {
      return { roundStartedAt, file: 'evil.png' } as ReadImageInput
    }

    it('file 是数组时返回 null 且不读磁盘', () => {
      expect(readRoundImage(root, malformed(['evil.png']))).toBeNull()
      expect(existsSync).not.toHaveBeenCalled()
      expect(readFileSync).not.toHaveBeenCalled()
    })

    it('file 是对象时返回 null 且不读磁盘', () => {
      expect(readRoundImage(root, malformed({ toString: () => 'evil.png' }))).toBeNull()
      expect(existsSync).not.toHaveBeenCalled()
      expect(readFileSync).not.toHaveBeenCalled()
    })

    it('file 是数字时返回 null 且不读磁盘', () => {
      expect(readRoundImage(root, malformed(42))).toBeNull()
      expect(existsSync).not.toHaveBeenCalled()
      expect(readFileSync).not.toHaveBeenCalled()
    })

    it('file 是 null 时返回 null 且不读磁盘', () => {
      expect(readRoundImage(root, malformed(null))).toBeNull()
      expect(existsSync).not.toHaveBeenCalled()
      expect(readFileSync).not.toHaveBeenCalled()
    })

    it('file 是 undefined 时返回 null 且不读磁盘', () => {
      expect(readRoundImage(root, malformed(undefined))).toBeNull()
      expect(existsSync).not.toHaveBeenCalled()
      expect(readFileSync).not.toHaveBeenCalled()
    })

    it('roundStartedAt 不是字符串时返回 null 且不读磁盘', () => {
      // 用数字而不是 null/undefined：数字会被 new Date() 当成合法的 epoch
      // 毫秒数接受，不会撞上「非法时间」那条检查——必须专门靠类型判断挡住，
      // 否则会算出一个错误但存在的日期目录，进而真的调用 existsSync
      expect(readRoundImage(root, malformedStartedAt(1757390400000))).toBeNull()
      expect(existsSync).not.toHaveBeenCalled()
    })
  })

  it('越出 saveDir 的构造输入返回 null（前缀陷阱防护）', () => {
    // 正常情况下 dateDir = join(saveDir, dateDirName(...))，裸文件名不可能
    // 逃出 saveDir；这里伪造 dateDirName 的返回值模拟「万一 dateDir 本身
    // 就带了穿越段」的情形，验证边界检查是独立于「file 必须是裸文件名」
    // 那道守卫的第二道防线。文件真实放在 saveDir 之外，如果边界检查失效，
    // 会读到内容而不是 null
    const outside = join(root, '..', 'outside-secret')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'leak.png'), Buffer.from('LEAKED'))

    vi.mocked(dateDirName).mockReturnValueOnce(join('..', 'outside-secret'))

    expect(readRoundImage(root, input('leak.png'))).toBeNull()

    rmSync(outside, { recursive: true, force: true })
  })

  it('roundStartedAt 不是合法时间时返回 null，不触碰磁盘', () => {
    expect(readRoundImage(root, { roundStartedAt: '不是时间', file: 'x.png' })).toBeNull()
    expect(existsSync).not.toHaveBeenCalled()
  })
})

describe('readRoundImageMeta', () => {
  it('读回的图交给 readImageMeta；读不到文件返回 null', () => {
    const dir = join(root, dateDirName(new Date(startedAt)))
    mkdirSync(dir, { recursive: true })
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const data = Buffer.concat([Buffer.from('Comment', 'latin1'), Buffer.from([0]), Buffer.from('{"seed":77}', 'utf-8')])
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    writeFileSync(join(dir, '00001-77.png'), Buffer.concat([signature, len, Buffer.from('tEXt', 'ascii'), data, Buffer.alloc(4)]))
    expect(readRoundImageMeta(root, input('00001-77.png'))).toEqual({ chunks: { Comment: '{"seed":77}' }, seed: 77 })
    expect(readRoundImageMeta(root, input('nope.png'))).toBeNull()
  })
})
