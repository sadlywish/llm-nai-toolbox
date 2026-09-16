import { parseSubscription, type NaiSubscriptionError, type NaiSubscriptionResult } from '@shared/naiUser'
import { raceAbort } from '../llm/http'

/**
 * 查 NovelAI 账号额度：`GET {baseUrl}/user/subscription`（移植自插件 src/backend/nai-usage.ts）。
 *
 * 与出图共用 naiBaseUrl：账号端点和生图端点都在 image.novelai.net。
 * 失败一律返回 { ok: false }，从不 reject——额度查不到不该影响出图（插件那边是静默跳过）。
 */
export interface NaiUserOptions {
  baseUrl: string
  token: string
  timeoutMs: number
  /** 生产传 appFetch（net.fetch，走应用代理）；测试传假 fetch */
  fetchImpl: typeof fetch
}

const fail = (kind: NaiSubscriptionError['kind'], message: string): NaiSubscriptionResult => ({
  ok: false,
  error: { kind, message },
})

export async function fetchSubscription(opts: NaiUserOptions): Promise<NaiSubscriptionResult> {
  if (!opts.token) return fail('no-token', '未配置 NovelAI Token，无法查询额度。')

  const url = `${opts.baseUrl.replace(/\/+$/, '')}/user/subscription`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  // 两条中止路径都要认，理由同 client.ts 的 isAbort
  const isAbort = (e: unknown): boolean => controller.signal.aborted || (e instanceof Error && e.name === 'AbortError')

  try {
    let response: Response
    try {
      // net.fetch 不一定认 signal：raceAbort 保证超时一到就放手
      response = await raceAbort(
        opts.fetchImpl(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${opts.token}`, Accept: 'application/json' },
          signal: controller.signal,
        }),
        controller.signal,
      )
    } catch (e) {
      if (isAbort(e)) return fail('timeout', `额度查询超时（${Math.round(opts.timeoutMs / 1000)} 秒）。`)
      return fail('network', `额度查询失败：${e instanceof Error ? e.message : String(e)}`)
    }

    let text: string
    try {
      text = await raceAbort(response.text(), controller.signal)
    } catch (e) {
      if (isAbort(e)) return fail('timeout', `额度查询超时（${Math.round(opts.timeoutMs / 1000)} 秒）。`)
      return fail('network', `读取额度响应失败：${e instanceof Error ? e.message : String(e)}`)
    }

    if (!response.ok) {
      if (response.status === 401) return fail('unauthorized', 'NovelAI Token 无效或已过期，请到设置里重新填写。')
      // 400 常见于把接口地址写成了 api.novelai.net：那边的账号端点已停用，正文会说明原因
      return fail('http', `NovelAI 返回 ${response.status}：${text.slice(0, 200)}`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return fail('invalid', `额度接口返回了无法解析的响应：${text.slice(0, 120)}`)
    }
    const subscription = parseSubscription(parsed)
    if (subscription === null) return fail('invalid', '额度接口返回的结构不认识（接口地址可能不对）。')
    return { ok: true, subscription }
  } finally {
    clearTimeout(timer)
  }
}
