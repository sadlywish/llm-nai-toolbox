import { net, session } from 'electron'
import { parseProxyRules } from '@shared/proxy'

/**
 * 主进程统一的 fetch。
 *
 * 用 Electron 的 `net.fetch` 而不是 Node 内置的全局 fetch（undici），
 * 理由是代理：`net.fetch` 走 Chromium 网络栈，因而认 `session.setProxy()`，
 * 也认系统代理；undici 两个都不认。LLM 接口 / NovelAI 接口 / Danbooru 接口
 * 三条路在同一个网络栈上，一处代理设置全覆盖。
 *
 * 附带的好处：TLS 握手交给 Chromium。Danbooru 前面的 Cloudflare 会按 TLS
 * 指纹区分客户端（实测 curl 全 403 而应用正常），Chromium 的指纹是最不容易
 * 被拦的那个。
 *
 * 写成箭头函数而不是直接导出 `net.fetch`：`net` 在 app ready 之前不可用，
 * 延迟到调用时再取属性。
 */
export const appFetch: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  net.fetch(input as never, init as never)) as typeof fetch

export interface ApplyProxyResult {
  ok: boolean
  /** 给日志与设置界面看的一句话；不含任何凭据（本版本就不支持带凭据的代理） */
  message: string
}

/**
 * 把配置里的一行代理地址应用到默认 session。
 *
 * 解析失败时**退回系统代理并把原因报出去**，不是静默忽略：Chromium 对写错
 * 的 proxyRules 本身就是静默忽略的，那会变成「设置里填了代理、实际一直直连」
 * 这种查都没法查的状态。
 */
export async function applyProxy(raw: string): Promise<ApplyProxyResult> {
  const parsed = parseProxyRules(raw)
  if (!parsed.ok) {
    await session.defaultSession.setProxy({ mode: 'system' })
    return { ok: false, message: `代理配置无效（已退回系统代理）：${parsed.message}` }
  }
  if (parsed.rules === '') {
    await session.defaultSession.setProxy({ mode: 'system' })
    return { ok: true, message: '跟随系统代理' }
  }
  await session.defaultSession.setProxy({
    proxyRules: parsed.rules,
    // 本机地址不走代理，否则 devtools、localhost 之类会被绕一圈
    proxyBypassRules: '<local>',
  })
  return { ok: true, message: `已启用代理 ${parsed.rules}` }
}
