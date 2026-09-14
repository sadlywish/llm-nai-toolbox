import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dateDirName, nextSequence, saveImage } from '../../../src/main/nai/save'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ast-save-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('dateDirName', () => {
  it('按本地时间产出 YYYY-MM-DD', () => {
    expect(dateDirName(new Date(2026, 8, 9, 13, 45))).toBe('2026-09-09')
  })

  it('月和日都补零', () => {
    expect(dateDirName(new Date(2026, 0, 5, 0, 0))).toBe('2026-01-05')
  })
})

describe('nextSequence', () => {
  it('目录不存在时从 1 开始', () => {
    expect(nextSequence(join(root, 'nope'))).toBe(1)
  })

  it('空目录从 1 开始', () => {
    expect(nextSequence(root)).toBe(1)
  })

  it('取已有文件名里的最大序号 +1', () => {
    writeFileSync(join(root, '00001-111.png'), '')
    writeFileSync(join(root, '00007-222.png'), '')
    writeFileSync(join(root, '00003-333.png'), '')
    expect(nextSequence(root)).toBe(8)
  })

  it('忽略不符合命名规则的文件', () => {
    writeFileSync(join(root, '_index.json'), '{}')
    writeFileSync(join(root, 'notes.txt'), '')
    expect(nextSequence(root)).toBe(1)
  })

  it('目录不可读时抛出，而不是当成空目录', () => {
    // 路径存在但不是目录 → readdirSync 抛 ENOTDIR。
    // 当成空目录会返回 1，随后 saveImage 就用 00001 覆盖掉已有的图
    const notDir = join(root, 'not-a-dir')
    writeFileSync(notDir, '')
    expect(() => nextSequence(notDir)).toThrow()
  })
})

describe('saveImage', () => {
  const now = new Date(2026, 8, 9, 10, 0)

  it('写到 <根目录>/YYYY-MM-DD/00001-<seed>.png', () => {
    const r = saveImage(root, Buffer.from('IMG'), 'image/png', 4242, now)
    expect(r.fileName).toBe('00001-4242.png')
    expect(r.filePath).toBe(join(root, '2026-09-09', '00001-4242.png'))
    expect(readFileSync(r.filePath, 'utf-8')).toBe('IMG')
  })

  it('目录不存在时自动创建', () => {
    saveImage(root, Buffer.from('IMG'), 'image/png', 1, now)
    expect(existsSync(join(root, '2026-09-09'))).toBe(true)
  })

  it('序号在同一天内递增', () => {
    saveImage(root, Buffer.from('A'), 'image/png', 1, now)
    const second = saveImage(root, Buffer.from('B'), 'image/png', 2, now)
    expect(second.fileName).toBe('00002-2.png')
  })

  it('webp 用对应扩展名', () => {
    const r = saveImage(root, Buffer.from('W'), 'image/webp', 9, now)
    expect(r.fileName).toBe('00001-9.webp')
  })

  it('seed 为 null 时文件名用 noseed', () => {
    const r = saveImage(root, Buffer.from('N'), 'image/png', null, now)
    expect(r.fileName).toBe('00001-noseed.png')
  })

  it('回报当天目录的路径，供 _index.json 落在同一处', () => {
    const r = saveImage(root, Buffer.from('X'), 'image/png', 1, now)
    expect(r.dateDir).toBe(join(root, '2026-09-09'))
  })

  it('已有 00009 时新图接在 00010', () => {
    mkdirSync(join(root, '2026-09-09'), { recursive: true })
    writeFileSync(join(root, '2026-09-09', '00009-1.png'), '')
    const r = saveImage(root, Buffer.from('Z'), 'image/png', 5, now)
    expect(r.fileName).toBe('00010-5.png')
  })

  it('seed 为 0 时文件名就是 0，不会被当成缺失', () => {
    const r = saveImage(root, Buffer.from('Z'), 'image/png', 0, now)
    expect(r.fileName).toBe('00001-0.png')
  })
})
