// 手机端图片与缩略图接口（计划 Task 6）。
//
// 不 import electron：真实缩图实现要 electron 的 nativeImage，只在 index.ts 里通过
// ServerDeps.makeThumbnail 注入，这里只管参数校验、读文件、按 size 分流，测试能在
// node 下直接喂假的 makeThumbnail 跑。
import type { IncomingMessage, ServerResponse } from 'http'
import { extname } from 'path'
import { readRoundImage } from '../nai/index-store'
import { sendError, type ServerDeps } from './http'

/** 落盘只有这两种扩展名（见 save.ts 的 ext 选择），其余一律当 PNG 处理 */
const FULL_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.webp': 'image/webp',
}

/** 同一轮里同一个文件名的内容不会再变（出图落盘之后没有任何路径会覆写它），放心让浏览器缓存一天 */
const IMAGE_CACHE_CONTROL = 'private, max-age=86400'

function sendImage(res: ServerResponse, buf: Buffer, contentType: string): void {
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': IMAGE_CACHE_CONTROL })
  res.end(buf)
}

/**
 * `GET /api/image?round=<ISO 时间>&file=<文件名>&size=thumb|full`
 *
 * 路径越界的校验全部交给 readRoundImage——它已经挡住了路径分隔符、`..`、绝对路径，
 * 这里不重新实现一遍防护，两处各写一遍迟早会走样（见它自己的注释）。
 */
export async function handleImage(req: IncomingMessage, res: ServerResponse, ctx: ServerDeps): Promise<void> {
  const { searchParams } = new URL(req.url ?? '/', 'http://localhost')
  const round = searchParams.get('round')
  const file = searchParams.get('file')
  // 缺省当 full；给了别的值（不是 thumb/full）当外部输入错误，400 而不是当 full 兜底
  const size = searchParams.get('size') ?? 'full'
  if (size !== 'full' && size !== 'thumb') {
    sendError(res, 400, 'bad-request', 'size 只能是 thumb 或 full')
    return
  }
  if (round === null || file === null) {
    sendError(res, 400, 'bad-request', '缺少 round 或 file 参数')
    return
  }

  const config = ctx.services.configStore.read()
  const bytes = readRoundImage(config.saveDir, { roundStartedAt: round, file })
  if (bytes === null) {
    sendError(res, 404, 'not-found', '这张图片不存在')
    return
  }
  const buf = Buffer.from(bytes)

  if (size === 'thumb') {
    sendImage(res, ctx.makeThumbnail(buf, 512), 'image/jpeg')
    return
  }
  sendImage(res, buf, FULL_CONTENT_TYPES[extname(file).toLowerCase()] ?? 'image/png')
}
