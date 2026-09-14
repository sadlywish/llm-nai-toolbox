import type { ImageMeta } from '@shared/gen'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47]

/**
 * 读出 PNG 里所有 tEXt / iTXt 文本块。
 *
 * PNG 结构：8 字节签名 + 若干 chunk（4 字节长度 BE + 4 字节类型 + data + 4 字节 CRC）。
 * 扫到 IDAT 或 IEND 就停——文本块都在图像数据之前，继续扫只是白读几 MB 像素。
 *
 * 压缩的 iTXt（compFlag 非 0）跳过：NAI 不用它，为它引入 zlib 解压路径
 * 只会多一条没人走的分支。
 */
export function readPngTextChunks(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  if (buf.length < 8 || PNG_SIGNATURE.some((b, i) => buf[i] !== b)) return out

  let offset = 8
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + len
    if (dataEnd > buf.length) break
    if (type === 'IDAT' || type === 'IEND') break

    if (type === 'tEXt' || type === 'iTXt') {
      const data = buf.subarray(dataStart, dataEnd)
      const sep = data.indexOf(0)
      if (sep > 0) {
        const keyword = data.toString('latin1', 0, sep)
        const text = type === 'tEXt' ? data.toString('utf-8', sep + 1) : readITXtText(data, sep)
        if (text !== null) out[keyword] = text
      }
    }

    offset = dataEnd + 4 // 跳过 CRC
  }

  return out
}

/** iTXt 布局：keyword\0 compFlag compMethod langTag\0 translatedKeyword\0 text */
function readITXtText(data: Buffer, sep: number): string | null {
  if (data[sep + 1] !== 0) return null // 压缩的不处理
  const langEnd = data.indexOf(0, sep + 3)
  if (langEnd < 0) return null
  const transEnd = data.indexOf(0, langEnd + 1)
  if (transEnd < 0) return null
  return data.toString('utf-8', transEnd + 1)
}

/**
 * 只有这些 keyword 承载生成参数。
 *
 * 必须限定：NovelAI 把正向提示词写在 `Description` 块里，
 * 提示词中出现「Seed: 123」字样就会被误当成真 seed。
 */
const PARAM_KEYWORDS = new Set(['Comment', 'parameters', 'Parameters'])

/**
 * 从 PNG 元数据里读出 seed。
 *
 * NAI 把生成参数以 JSON 写进 `Comment`。这是**图片自带的、这一张实际用的** seed，
 * 在走 zip 路径（接口不回报 seed）时是唯一来源。
 * 顺带认 A1111 风格的 `Seed: 12345` 文本，方便读别的工具产出的图。
 */
export function extractPngSeed(buf: Buffer): number | undefined {
  const chunks = readPngTextChunks(buf)

  for (const [keyword, text] of Object.entries(chunks)) {
    if (!text) continue

    const isParamKeyword = PARAM_KEYWORDS.has(keyword)

    // JSON 分支放宽一档：别的工具可能把参数 JSON 写在未知 keyword 下，
    // 而以 `{` 开头足以说明它是结构化参数而不是提示词
    if (isParamKeyword || text.trimStart().startsWith('{')) {
      try {
        const meta = JSON.parse(text) as { seed?: unknown }
        const v = Number(meta?.seed)
        if (Number.isFinite(v)) return v
      } catch {
        // 不是 JSON 就往下走
      }
    }

    // 正则分支只认已知参数块，**不能**用 `{` 开头做逃生口：
    // NovelAI 的提示词常以 {tag} 强调语法开头，放行等于把
    // 「提示词里的 Seed: N 被误读成真 seed」这个洞重新打开
    if (!isParamKeyword) continue

    const m = /(?:^|[,\s])[Ss]eed:\s*(\d+)/.exec(text)
    if (m) return Number(m[1])
  }

  return undefined
}

/**
 * 「图片元信息」页签用：直接从图片文件里读到的全部文本块（原样），外加参数块里的 seed。
 * 不是 PNG（例如 webp）时两者都为空——NovelAI 的 webp 不带这些块。
 */
export function readImageMeta(buf: Buffer): ImageMeta {
  return { chunks: readPngTextChunks(buf), seed: extractPngSeed(buf) ?? null }
}
