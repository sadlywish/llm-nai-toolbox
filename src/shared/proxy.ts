/**
 * 代理地址的解析与归一化（纯函数，主/渲染两侧共用）。
 *
 * 放在 shared 而不是 main：设置界面要在保存之前就把「这串写得不对」告诉
 * 用户，不能等到保存完、发请求失败了才发现。Chromium 的 `setProxy` 对
 * 写错的 proxyRules 是**静默忽略**的——那正是这个项目最忌讳的那种失败，
 * 表面上「配了代理」，实际上一直在直连。
 */

/** Chromium proxyRules 支持的协议前缀；不写协议时按 http 代理处理 */
const SCHEMES = ['http', 'https', 'socks4', 'socks5', 'socks'] as const

export type ParseProxyResult =
  | { ok: true; rules: string }
  | { ok: false; message: string }

/**
 * 把用户填的一行代理地址归一化成 Chromium 的 proxyRules。
 *
 * 空串是合法输入，表示「跟随系统代理」，返回 `rules: ''`。
 */
export function parseProxyRules(raw: string): ParseProxyResult {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return { ok: true, rules: '' }

  if (/\s/.test(text)) {
    return { ok: false, message: '代理地址中不能有空格' }
  }

  const m = /^(?:([A-Za-z0-9]+):\/\/)?(.+)$/.exec(text)
  // 上面的正则对任何非空无空格字符串都能匹配，这里只是给类型收窄用
  if (!m) return { ok: false, message: '无法识别的代理地址' }

  const scheme = (m[1] ?? 'http').toLowerCase()
  const rest = m[2]

  if (!(SCHEMES as readonly string[]).includes(scheme)) {
    return {
      ok: false,
      message: `不支持的代理协议「${scheme}」，可用：${SCHEMES.join('、')}`,
    }
  }

  // 带凭据的形式必须明确拒绝而不是放过去：Chromium 的 proxyRules 会把
  // user:pass@ 一并当成主机名解析失败、静默退回直连，用户看到的是
  // 「填了代理但没生效」而不是任何报错
  if (rest.includes('@')) {
    return { ok: false, message: '本版不支持需要用户名密码认证的代理' }
  }
  if (rest.includes('/')) {
    return { ok: false, message: '代理地址只写 主机:端口，不要带路径' }
  }

  const at = rest.lastIndexOf(':')
  if (at <= 0 || at === rest.length - 1) {
    return { ok: false, message: '代理地址要写成 主机:端口，例如 127.0.0.1:7890' }
  }
  const host = rest.slice(0, at)
  const portText = rest.slice(at + 1)

  if (!/^\d+$/.test(portText)) {
    return { ok: false, message: `端口「${portText}」不是数字` }
  }
  const port = Number(portText)
  if (port < 1 || port > 65535) {
    return { ok: false, message: `端口 ${port} 超出 1-65535` }
  }

  return { ok: true, rules: `${scheme}://${host}:${port}` }
}
