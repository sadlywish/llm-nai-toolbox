/**
 * 给 Danbooru CDN 的图片请求补 Referer（移植自画师串工具箱 main/index.ts 的 allowDanbooruCdnImages）。
 *
 * 例图是渲染进程 <img src> 直连 CDN，页面来自 file://，Chromium 不发 Referer 且带 Sec-Fetch-Site: cross-site，
 * Cloudflare 判为可疑返回 403。实测：只带 UA → 200；加 cross-site → 403；再补 Referer → 200。
 * 过滤器只匹配 cdn.donmai.us，不会把 Referer 泄漏给别的主机。
 */
export const DANBOORU_CDN_URLS = ['https://cdn.donmai.us/*']

export function withDanbooruReferer(headers: Record<string, string>): Record<string, string> {
  return { ...headers, Referer: 'https://danbooru.donmai.us/' }
}
