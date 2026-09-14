import type { ImageFormat } from '@shared/config'
import type { GenerateResult, NaiError, NaiImage } from '@shared/gen'
import { raceAbort } from '../llm/http'
import { extractImagesFromZip } from './zip'

export interface NaiClientOptions {
  baseUrl: string
  token: string
  timeoutMs: number
  /** 请求时用的图片格式；决定响应图片的 mimeType（spec §15） */
  imageFormat: ImageFormat
  /** 生产传 appFetch（net.fetch，走应用代理）；测试传假 fetch */
  fetchImpl: typeof fetch
}

function fail(kind: NaiError['kind'], message: string): GenerateResult {
  return { ok: false, error: { kind, message } }
}

/**
 * 调 NovelAI 的 `/ai/generate-image`。
 *
 * 请求头带 `Accept: application/json`：官方文档说明此时直接返回 base64 数组，
 * 不必解 zip。但**中转端点常忽略这个头**仍然返回 zip，所以两条路径都要处理——
 * 首字节是 `{` 就走 JSON，否则按 zip 解。
 */
export async function generateImage(
  opts: NaiClientOptions,
  body: unknown,
): Promise<GenerateResult> {
  if (!opts.token) {
    return fail('no-token', '未配置 NovelAI Token，无法生成。请到设置里填写。')
  }

  const url = `${opts.baseUrl.replace(/\/+$/, '')}/ai/generate-image`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  const timeout = (): GenerateResult => fail('timeout', `请求超时（${Math.round(opts.timeoutMs / 1000)} 秒）。`)
  // controller.signal.aborted 覆盖「fetch 不理会 signal，raceAbort 强制放手」的情形；
  // e.name === 'AbortError' 再兜一层「fetch 确实认了 signal，自己抛出中止异常」的情形——
  // 两条路径都该算超时，不能只信任其中一条
  const isAbort = (e: unknown): boolean => controller.signal.aborted || (e instanceof Error && e.name === 'AbortError')

  try {
    let response: Response
    try {
      // net.fetch 不一定认 signal：raceAbort 保证超时一到就放手，不干等（同 LLM 请求）
      response = await raceAbort(
        opts.fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${opts.token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        controller.signal,
      )
    } catch (e) {
      if (isAbort(e)) return timeout()
      return fail('network', `网络错误：${e instanceof Error ? e.message : String(e)}`)
    }

    let buf: Buffer
    try {
      // 读 body 同样要受超时约束：响应头到了、body 卡住，也不能无限等
      buf = Buffer.from(await raceAbort(response.arrayBuffer(), controller.signal))
    } catch (e) {
      if (isAbort(e)) return timeout()
      // 响应头已到，但 body 流中途断开。必须兜住，否则打破「永远返回 GenerateResult、永不 reject」的承诺
      return fail('network', `读取响应失败：${e instanceof Error ? e.message : String(e)}`)
    }

    if (!response.ok) return classifyHttpError(response.status, buf)

    const mimeType = opts.imageFormat === 'webp' ? 'image/webp' : 'image/png'

    // 首字节 '{' → JSON
    if (buf.length > 0 && buf[0] === 0x7b) {
      return parseJsonResponse(buf, mimeType)
    }

    // 中转端点忽略了 Accept 头，仍然返回 zip。
    // zip 路径拿不到接口回报的 seed，置 null 交给上层读 PNG 元数据
    const images: NaiImage[] = extractImagesFromZip(buf).map((data) => ({
      data: data.toString('base64'),
      mimeType,
      seed: null,
    }))
    if (images.length === 0) return fail('empty', 'NovelAI 未返回图片。')
    return { ok: true, images }
  } finally {
    clearTimeout(timer)
  }
}

function classifyHttpError(status: number, buf: Buffer): GenerateResult {
  const detail = buf.toString('utf-8').slice(0, 500)
  switch (status) {
    case 401:
      return fail('unauthorized', 'NovelAI Token 无效或已过期，请到设置里重新填写。')
    case 402:
      return fail('payment', '点数不足，或当前订阅不支持该操作。')
    case 429:
      // NovelAI 只支持单并发。429 的含义是「已有另一个生成任务在跑」，
      // 通常是网页端、手机端或同账号的其他客户端，而不是本工具发得太快
      return fail(
        'concurrent',
        '检测到并发冲突：NovelAI 只支持单并发，可能有其他客户端正在生成。',
      )
    default:
      return fail('http', `NovelAI 返回 ${status}：${detail}`)
  }
}

function parseJsonResponse(buf: Buffer, mimeType: string): GenerateResult {
  const text = buf.toString('utf-8')
  let parsed: { images?: unknown[] }
  try {
    parsed = JSON.parse(text)
  } catch {
    return fail('http', `NovelAI 返回了无法解析的响应：${text.slice(0, 300)}`)
  }

  if (!Array.isArray(parsed.images)) {
    return fail('http', `NovelAI 返回错误：${text.slice(0, 500)}`)
  }

  const images: NaiImage[] = parsed.images
    // 中转端点可能返回 [null] 这类元素。不过滤的话 it.image 会抛 TypeError
    // 逃出函数，破坏「永远返回 GenerateResult、永不 reject」的承诺
    .filter(
      (it): it is { image?: unknown; seed?: unknown } => typeof it === 'object' && it !== null,
    )
    .map((it) => {
      const seed = it.seed == null ? null : Number(it.seed)
      return {
        data: String(it.image ?? ''),
        mimeType,
        // 非数字的 seed 一律当作「没回报」，让上层回退去读 PNG 元数据，
        // 而不是把 NaN 写进文件名和索引
        seed: seed !== null && Number.isFinite(seed) ? seed : null,
      }
    })
    .filter((it) => it.data !== '')

  if (images.length === 0) return fail('empty', 'NovelAI 未返回图片。')
  return { ok: true, images }
}
