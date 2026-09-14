import { deflateRawSync } from 'zlib'
import { describe, expect, it } from 'vitest'
import { extractImagesFromZip } from '../../../src/main/nai/zip'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 造一个假 PNG：只要开头是 PNG 魔数、长度大于 8 就满足解包器的判定 */
function fakePng(marker: string): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.from(marker, 'ascii')])
}

/** 手工拼一个 zip 条目（local file header + 数据），CRC 留 0——解包器不校验 */
function zipEntry(name: string, content: Buffer, stored = false): Buffer {
  const data = stored ? content : deflateRawSync(content)
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(0, 6)
  header.writeUInt16LE(stored ? 0 : 8, 8)
  header.writeUInt16LE(0, 10)
  header.writeUInt16LE(0, 12)
  header.writeUInt32LE(0, 14)
  header.writeUInt32LE(data.length, 18)
  header.writeUInt32LE(content.length, 22)
  header.writeUInt16LE(name.length, 26)
  header.writeUInt16LE(0, 28)
  return Buffer.concat([header, Buffer.from(name, 'ascii'), data])
}

/**
 * 造一个 bit-3（data descriptor）条目：头里的 compSize 为 0，
 * 真实大小写在数据之后的 16 字节描述符里。
 * NAI 的返回包在某些路径上就是这个形状。
 */
function zipEntryWithDescriptor(name: string, content: Buffer): Buffer {
  const data = deflateRawSync(content)
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(0x08, 6) // bit 3：大小写在 data descriptor 里
  header.writeUInt16LE(8, 8) // deflate
  header.writeUInt16LE(0, 10)
  header.writeUInt16LE(0, 12)
  header.writeUInt32LE(0, 14) // crc 占位
  header.writeUInt32LE(0, 18) // compSize = 0，这正是要触发的条件
  header.writeUInt32LE(0, 22)
  header.writeUInt16LE(name.length, 26)
  header.writeUInt16LE(0, 28)

  // data descriptor：PK\x07\x08 + crc32 + compSize + uncompSize，共 16 字节
  const descriptor = Buffer.alloc(16)
  descriptor.writeUInt32LE(0x08074b50, 0)
  descriptor.writeUInt32LE(0, 4)
  descriptor.writeUInt32LE(data.length, 8)
  descriptor.writeUInt32LE(content.length, 12)

  return Buffer.concat([header, Buffer.from(name, 'ascii'), data, descriptor])
}

describe('extractImagesFromZip', () => {
  it('空 buffer 返回空数组', () => {
    expect(extractImagesFromZip(Buffer.alloc(0))).toEqual([])
  })

  it('取出单个 deflate 压缩的 PNG', () => {
    const zip = zipEntry('image_0.png', fakePng('AAA'))
    const out = extractImagesFromZip(zip)
    expect(out).toHaveLength(1)
    expect(out[0].subarray(8).toString('ascii')).toBe('AAA')
  })

  it('取出多个 PNG，顺序与包内一致', () => {
    const zip = Buffer.concat([
      zipEntry('image_0.png', fakePng('AAA')),
      zipEntry('image_1.png', fakePng('BBB')),
    ])
    const out = extractImagesFromZip(zip)
    expect(out.map((b) => b.subarray(8).toString('ascii'))).toEqual(['AAA', 'BBB'])
  })

  it('支持不压缩（stored）的条目', () => {
    const zip = zipEntry('image_0.png', fakePng('CCC'), true)
    expect(extractImagesFromZip(zip)[0].subarray(8).toString('ascii')).toBe('CCC')
  })

  it('跳过不是 PNG 的条目', () => {
    const zip = Buffer.concat([
      zipEntry('readme.txt', Buffer.from('hello world', 'ascii')),
      zipEntry('image_0.png', fakePng('DDD')),
    ])
    const out = extractImagesFromZip(zip)
    expect(out).toHaveLength(1)
    expect(out[0].subarray(8).toString('ascii')).toBe('DDD')
  })

  it('不是 zip 的数据返回空数组而不是抛异常', () => {
    expect(extractImagesFromZip(Buffer.from('{"images":[]}', 'utf-8'))).toEqual([])
  })
})

describe('extractImagesFromZip — data descriptor（bit 3）', () => {
  it('头里 compSize 为 0 时，靠后续内容反推长度', () => {
    const zip = zipEntryWithDescriptor('image_0.png', fakePng('EEE'))
    const out = extractImagesFromZip(zip)
    expect(out).toHaveLength(1)
    expect(out[0].subarray(8).toString('ascii')).toBe('EEE')
  })

  it('bit-3 条目后面还有普通条目时，两者都能取出', () => {
    const zip = Buffer.concat([
      zipEntryWithDescriptor('image_0.png', fakePng('FFF')),
      zipEntry('image_1.png', fakePng('GGG')),
    ])
    expect(extractImagesFromZip(zip).map((b) => b.subarray(8).toString('ascii'))).toEqual([
      'FFF',
      'GGG',
    ])
  })
})

describe('extractImagesFromZip — 损坏条目', () => {
  it('压缩数据损坏的条目被跳过，不影响同包内的其他图片', () => {
    // 0x06 的低三位是 BFINAL=0、BTYPE=11 —— deflate 保留的非法块类型，
    // inflateRawSync 必定抛异常
    const junk = Buffer.from([0x06, 0x00, 0x00, 0x00])
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0, 6)
    header.writeUInt16LE(8, 8) // 声称是 deflate，但载荷不是
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(0, 12)
    header.writeUInt32LE(0, 14)
    header.writeUInt32LE(junk.length, 18)
    header.writeUInt32LE(junk.length, 22)
    header.writeUInt16LE('bad.png'.length, 26)
    header.writeUInt16LE(0, 28)
    const broken = Buffer.concat([header, Buffer.from('bad.png', 'ascii'), junk])

    const out = extractImagesFromZip(Buffer.concat([broken, zipEntry('ok.png', fakePng('HHH'))]))
    expect(out).toHaveLength(1)
    expect(out[0].subarray(8).toString('ascii')).toBe('HHH')
  })
})
