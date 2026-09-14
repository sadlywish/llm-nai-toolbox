import { describe, expect, it } from 'vitest'
import { extractPngSeed, readImageMeta, readPngTextChunks } from '../../../src/main/nai/png'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 拼一个 PNG chunk：4 字节长度 BE + 4 字节类型 + 数据 + 4 字节 CRC（留 0，读取端不校验） */
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)])
}

function tEXt(keyword: string, text: string): Buffer {
  return chunk(
    'tEXt',
    Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'utf-8')]),
  )
}

/** iTXt：keyword\0 compFlag compMethod langTag\0 translatedKeyword\0 text */
function iTXt(keyword: string, text: string): Buffer {
  return chunk(
    'iTXt',
    Buffer.concat([
      Buffer.from(keyword, 'latin1'),
      Buffer.from([0, 0, 0]),
      Buffer.from([0]), // 空 langTag
      Buffer.from([0]), // 空 translatedKeyword
      Buffer.from(text, 'utf-8'),
    ]),
  )
}

function png(...chunks: Buffer[]): Buffer {
  return Buffer.concat([PNG_MAGIC, ...chunks, chunk('IEND', Buffer.alloc(0))])
}

describe('readPngTextChunks', () => {
  it('不是 PNG 时返回空对象', () => {
    expect(readPngTextChunks(Buffer.from('not a png'))).toEqual({})
  })

  it('读出 tEXt 文本块', () => {
    const buf = png(tEXt('Software', 'NovelAI'))
    expect(readPngTextChunks(buf)).toEqual({ Software: 'NovelAI' })
  })

  it('读出 iTXt 文本块', () => {
    const buf = png(iTXt('Description', '1girl, sky'))
    expect(readPngTextChunks(buf)).toEqual({ Description: '1girl, sky' })
  })

  it('读出多个文本块', () => {
    const buf = png(tEXt('Software', 'NovelAI'), tEXt('Comment', '{"seed":42}'))
    expect(readPngTextChunks(buf)).toEqual({ Software: 'NovelAI', Comment: '{"seed":42}' })
  })

  it('遇到 IDAT 就停止扫描——文本块都在图像数据之前', () => {
    const buf = png(tEXt('Software', 'NovelAI'), chunk('IDAT', Buffer.alloc(4)), tEXt('X', 'Y'))
    expect(readPngTextChunks(buf)).toEqual({ Software: 'NovelAI' })
  })
})

describe('readPngTextChunks — 畸形输入', () => {
  it('声称的长度超出 buffer 时停止扫描，不从截断数据里解析出假条目', () => {
    // 载荷里**含 \0 分隔符**是关键：没有它，后面的 sep > 0 会独立挡住，
    // 这条用例就测不到长度守卫本身。
    // 现实对应场景：下载中断或中转端点截流导致的半截 PNG
    const len = Buffer.alloc(4)
    len.writeUInt32BE(0xffffff, 0)
    const truncated = Buffer.concat([
      PNG_MAGIC,
      len,
      Buffer.from('tEXt', 'ascii'),
      Buffer.from('Comment', 'latin1'),
      Buffer.from([0]),
      Buffer.from('{"seed":777}', 'utf-8'),
    ])

    expect(() => readPngTextChunks(truncated)).not.toThrow()
    expect(readPngTextChunks(truncated)).toEqual({})
    // 没有守卫的话这里会读出 777——一个来自半截文件的假 seed
    expect(extractPngSeed(truncated)).toBeUndefined()
  })

  it('零长度 buffer 返回空对象', () => {
    expect(readPngTextChunks(Buffer.alloc(0))).toEqual({})
  })

  it('只有签名、没有任何 chunk 时返回空对象', () => {
    expect(readPngTextChunks(PNG_MAGIC)).toEqual({})
  })

  it('tEXt 缺分隔符时跳过该块，继续扫描后面的块', () => {
    const noSep = chunk('tEXt', Buffer.from('nonull', 'ascii'))
    const buf = Buffer.concat([
      PNG_MAGIC,
      noSep,
      tEXt('Software', 'NovelAI'),
      chunk('IEND', Buffer.alloc(0)),
    ])
    expect(readPngTextChunks(buf)).toEqual({ Software: 'NovelAI' })
  })

  it('压缩的 iTXt 被跳过，而不是产出乱码', () => {
    const compressed = chunk(
      'iTXt',
      Buffer.concat([
        Buffer.from('Comment', 'latin1'),
        Buffer.from([0, 1, 0]), // compFlag = 1，表示内容被压缩
        Buffer.from([0]),
        Buffer.from([0]),
        Buffer.from('压缩数据', 'utf-8'),
      ]),
    )
    const buf = Buffer.concat([PNG_MAGIC, compressed, chunk('IEND', Buffer.alloc(0))])
    expect(readPngTextChunks(buf)).toEqual({})
  })

  it('既无 IDAT 也无 IEND 时扫描仍会终止', () => {
    const buf = Buffer.concat([PNG_MAGIC, tEXt('A', '1'), tEXt('B', '2')])
    expect(readPngTextChunks(buf)).toEqual({ A: '1', B: '2' })
  })
})

describe('extractPngSeed', () => {
  it('从 Comment 的 JSON 里读出 seed', () => {
    const buf = png(tEXt('Comment', JSON.stringify({ steps: 28, seed: 1234567 })))
    expect(extractPngSeed(buf)).toBe(1234567)
  })

  it('从 A1111 风格的 "Seed: N" 文本里读出 seed', () => {
    const buf = png(tEXt('parameters', '1girl\nSteps: 28, Seed: 987, Sampler: Euler'))
    expect(extractPngSeed(buf)).toBe(987)
  })

  it('没有 seed 时返回 undefined', () => {
    expect(extractPngSeed(png(tEXt('Software', 'NovelAI')))).toBeUndefined()
  })

  it('Comment 不是合法 JSON 时不抛异常', () => {
    expect(extractPngSeed(png(tEXt('Comment', '{ 坏掉的 json')))).toBeUndefined()
  })

  it('不是 PNG 时返回 undefined', () => {
    expect(extractPngSeed(Buffer.from('hello'))).toBeUndefined()
  })

  it('提示词块里的 "Seed: N" 字样不会被当成真 seed', () => {
    // NovelAI 把正向提示词写在 Description 块里
    const buf = png(
      tEXt('Description', '1girl, holding a sign that says Seed: 999'),
      tEXt('Comment', JSON.stringify({ seed: 4242 })),
    )
    expect(extractPngSeed(buf)).toBe(4242)
  })

  it('以 { 开头的提示词块不会通过正则路径泄漏假 seed', () => {
    // NovelAI 的提示词常以 {tag} 强调语法开头。这类块能通过 JSON 分支的
    // 逃生口（然后解析失败），但绝不该走到正则分支
    const buf = png(
      tEXt('Description', '{masterpiece}, 1girl, a sign reading Seed: 999'),
      tEXt('Comment', JSON.stringify({ seed: 4242 })),
    )
    expect(extractPngSeed(buf)).toBe(4242)
  })
})

describe('readImageMeta', () => {
  function pngWith(chunks: Array<[string, string]>): Buffer {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const parts: Buffer[] = [signature]
    for (const [keyword, text] of chunks) {
      const data = Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'utf-8')])
      const len = Buffer.alloc(4)
      len.writeUInt32BE(data.length, 0)
      parts.push(len, Buffer.from('tEXt', 'ascii'), data, Buffer.alloc(4))
    }
    return Buffer.concat(parts)
  }

  it('全部文本块原样列出，并读出 Comment 里的 seed', () => {
    const meta = readImageMeta(pngWith([['Software', 'NovelAI'], ['Comment', JSON.stringify({ seed: 2961054388, steps: 28 })]]))
    expect(meta.chunks.Software).toBe('NovelAI')
    expect(JSON.parse(meta.chunks.Comment).steps).toBe(28)
    expect(meta.seed).toBe(2961054388)
  })

  it('不是 PNG 或没有参数块时：chunks 为空、seed 为 null', () => {
    expect(readImageMeta(Buffer.from('RIFF0000WEBP'))).toEqual({ chunks: {}, seed: null })
    expect(readImageMeta(pngWith([['Software', 'NovelAI']])).seed).toBeNull()
  })
})
