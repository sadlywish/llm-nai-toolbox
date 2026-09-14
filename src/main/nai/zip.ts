import { inflateRawSync } from 'zlib'

/**
 * 条目字节是否为已知的图片格式。
 *
 * 同时认 PNG 与 WebP 魔数：端点返回的实际格式未必是请求时要求的那个
 * （尤其中转端点），只认一种格式会让整包被判定为空，进而把整轮任务
 * 打成失败。
 */
function isSupportedImage(raw: Buffer): boolean {
  if (raw.length > 8 && raw[0] === 0x89 && raw[1] === 0x50) return true // PNG 魔数前两字节
  // WebP: 'RIFF'（偏移 0-3）+ 'WEBP'（偏移 8-11）
  if (
    raw.length > 12 &&
    raw[0] === 0x52 &&
    raw[1] === 0x49 &&
    raw[2] === 0x46 &&
    raw[3] === 0x46 &&
    raw[8] === 0x57 &&
    raw[9] === 0x45 &&
    raw[10] === 0x42 &&
    raw[11] === 0x50
  ) {
    return true
  }
  return false
}

/**
 * 从 NAI 返回的 zip 中取出所有图片。
 *
 * 手写而非引第三方库：NAI 的返回包结构极简（几个 local file header + 数据），
 * 用内置 zlib 处理足够。只扫 local file header（`PK\x03\x04`），不读中央目录——
 * 包里文件数很少且顺序写入，这样最省事且不依赖 EOCD 定位。
 */
export function extractImagesFromZip(buf: Buffer): Buffer[] {
  const out: Buffer[] = []
  let offset = 0

  while (offset + 30 <= buf.length) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) break

    const flags = buf.readUInt16LE(offset + 6)
    const method = buf.readUInt16LE(offset + 8)
    let compSize = buf.readUInt32LE(offset + 18)
    const nameLen = buf.readUInt16LE(offset + 26)
    const extraLen = buf.readUInt16LE(offset + 28)
    const dataStart = offset + 30 + nameLen + extraLen

    // bit 3：大小写在数据后面的 data descriptor 里，头部的 compSize 为 0。
    // 向后找下一个 local header 或中央目录，反推数据长度
    if ((flags & 0x08) !== 0 && compSize === 0) {
      let next = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), dataStart)
      const central = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), dataStart)
      if (next < 0 || (central >= 0 && central < next)) next = central
      const end = next < 0 ? buf.length : next
      compSize = Math.max(0, end - dataStart - 16) // 扣掉 data descriptor
    }

    const data = buf.subarray(dataStart, dataStart + compSize)
    try {
      const raw = method === 0 ? data : inflateRawSync(data)
      if (isSupportedImage(raw)) out.push(raw)
    } catch {
      // 解不开的条目跳过：一个坏条目不该让整包的其余图片都拿不到
    }

    offset = dataStart + compSize
    if ((flags & 0x08) !== 0) offset += 16
  }

  return out
}
