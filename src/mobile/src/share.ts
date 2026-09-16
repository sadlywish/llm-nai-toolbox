// 手机端「分享这张图」。
//
// 三档，从上往下降级：
//   1. APK 壳注入的 `window.NaiShell`——WebView 里根本没有 Web Share API，只能过原生那座桥；
//   2. 浏览器的 `navigator.share`，且 `canShare({ files })` 认这个文件（安卓 Chrome 要 https 才给）；
//   3. 两样都没有（局域网明文 HTTP 页面最常见）：明说一句「长按图片可以保存或分享」，不许静默失败。
//
// 图片字节一律由页面自己 fetch 好再往下传：自签证书那声「仍要继续」和配对令牌都在页面这边，
// 让原生自己去下载等于把这两关重走一遍（壳那边也是照这个约定写的，只收 dataURL）。
import { NETWORK_FAILURE_MESSAGE } from './api'

/** 壳注入的对象，字段与 android 那边的 ShellBridge 一一对应 */
export interface NaiShell {
  available(): boolean
  shareImage(dataUrl: string, filename: string): void
}

declare global {
  interface Window {
    NaiShell?: NaiShell
  }
}

export type ShareChannel = 'shell' | 'web-share' | 'none'

/** 挑档需要知道的全部外界情况，凑成一个纯数据结构好单测 */
export interface ShareEnv {
  /** `window.NaiShell`；浏览器里是 undefined */
  shell: NaiShell | null | undefined
  /** 有没有 `navigator.share` */
  canWebShare: boolean
  /** `navigator.canShare({ files: [这张图] })`——有 share 不等于收文件，两件事要分开问 */
  canWebShareFiles: boolean
}

export const LONG_PRESS_HINT = '长按图片可以保存或分享'

export function pickShareChannel(env: ShareEnv): ShareChannel {
  const shell = env.shell
  // 壳版本对不上时注入的对象可能缺方法，调用会当场抛；抛了就当没有壳，继续往下降级
  if (shell != null && typeof shell.shareImage === 'function' && typeof shell.available === 'function') {
    try {
      if (shell.available()) return 'shell'
    } catch {
      /* 桥坏了，往下走 */
    }
  }
  if (env.canWebShare && env.canWebShareFiles) return 'web-share'
  return 'none'
}

/**
 * 用户在系统分享面板上点了返回，`navigator.share` 抛的是 AbortError——那是取消，不是失败，
 * 再弹一句「分享失败」只会让人以为出了毛病。
 */
export function classifyShareError(err: unknown): 'cancelled' | 'failed' {
  const name =
    err instanceof Error
      ? err.name
      : typeof err === 'object' && err !== null && typeof (err as { name?: unknown }).name === 'string'
        ? (err as { name: string }).name
        : ''
  return name === 'AbortError' ? 'cancelled' : 'failed'
}

export type ShareResult =
  | { status: 'ok' }
  | { status: 'cancelled' }
  | { status: 'unsupported' }
  | { status: 'failed'; message: string }

/** 界面上要显示的那一句；null 表示什么都不用说（交出去了、或者是用户自己取消的） */
export function shareMessage(result: ShareResult): string | null {
  if (result.status === 'unsupported') return LONG_PRESS_HINT
  if (result.status === 'failed') return `分享失败：${result.message}`
  return null
}

async function fetchBlob(url: string): Promise<Blob> {
  let res: Response
  try {
    res = await fetch(url)
  } catch {
    // 同 api.ts：网络层失败没有服务端可问，只能由客户端补一句能直接显示的中文
    throw new Error(NETWORK_FAILURE_MESSAGE)
  }
  if (!res.ok) throw new Error(`取图片失败，电脑那头返回了 ${res.status}`)
  return await res.blob()
}

/** 壳那座桥只收字符串，图片得先变成 `data:image/png;base64,...` */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('图片读不出来'))
    reader.onload = () => resolve(String(reader.result))
    reader.readAsDataURL(blob)
  })
}

function toFile(blob: Blob, filename: string): File | null {
  // 老 WebView 上没有 File 构造函数；那时 web-share 这档自然用不了，走壳或者提示长按
  if (typeof File !== 'function') return null
  try {
    return new File([blob], filename, { type: blob.type !== '' ? blob.type : 'image/png' })
  } catch {
    return null
  }
}

function readEnv(file: File | null): ShareEnv {
  const nav = typeof navigator === 'undefined' ? null : navigator
  const canWebShare = nav !== null && typeof nav.share === 'function'
  let canWebShareFiles = false
  if (nav !== null && canWebShare && file !== null && typeof nav.canShare === 'function') {
    try {
      canWebShareFiles = nav.canShare({ files: [file] })
    } catch {
      canWebShareFiles = false
    }
  }
  return { shell: typeof window === 'undefined' ? null : window.NaiShell, canWebShare, canWebShareFiles }
}

function failureOf(err: unknown): ShareResult {
  if (classifyShareError(err) === 'cancelled') return { status: 'cancelled' }
  const message = err instanceof Error && err.message !== '' ? err.message : '分享没成功，稍后再试'
  return { status: 'failed', message }
}

/**
 * 分享一张图。永远不 reject——调用方只看 status，不用自己 catch。
 *
 * @param url      这张图的完整地址（`client.imageUrl(..., 'full')`，令牌已经在查询串里）
 * @param filename 那一轮落盘的文件名，例如 `00001-3163646731.png`
 */
export async function shareImage(url: string, filename: string): Promise<ShareResult> {
  let blob: Blob
  try {
    blob = await fetchBlob(url)
  } catch (err) {
    return { status: 'failed', message: err instanceof Error ? err.message : NETWORK_FAILURE_MESSAGE }
  }

  const file = toFile(blob, filename)
  const env = readEnv(file)
  const channel = pickShareChannel(env)

  if (channel === 'shell') {
    const shell = env.shell
    if (shell != null) {
      try {
        shell.shareImage(await blobToDataUrl(blob), filename)
        // 面板是原生那边弹的，弹出来之后的事页面看不见，调用没抛就算交出去了
        return { status: 'ok' }
      } catch (err) {
        return failureOf(err)
      }
    }
  }

  if (channel === 'web-share' && file !== null) {
    try {
      await navigator.share({ files: [file] })
      return { status: 'ok' }
    } catch (err) {
      return failureOf(err)
    }
  }

  return { status: 'unsupported' }
}
