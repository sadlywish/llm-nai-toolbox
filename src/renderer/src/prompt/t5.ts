/** V5 起的提示词长度上限（base 与全部角色提示词合计） */
export const T5_TOKEN_LIMIT_V5 = 1471
/** V4 / V4.5 的提示词长度上限 */
export const T5_TOKEN_LIMIT_LEGACY = 512

/**
 * 判断是否为 V5 及以上的模型。
 *
 * 必须锚定在 `diffusion-5` 上，不能用「出现 -5- 就算 V5」这类宽松写法：
 * V4.5 的模型名是 `nai-diffusion-4-5-full`，本身就含 `-5-`，会被误判成 V5。
 * 误判的代价是拿 V5 的宽松上限去量 V4.5 的提示词，该报的警不报，
 * 超出部分被官方静默截断——正是最难排查的那类问题。
 */
export function isV5Model(model: string): boolean {
  return /diffusion-5(?:[-.]|$)/.test(String(model || ''))
}

/**
 * 按模型取提示词 token 上限。
 *
 * 认不出的模型名（自定义端点、手填）一律按更保守的 512 处理：
 * 早报警无害，漏报才是真问题。
 */
export function tokenLimitFor(model: string): number {
  return isV5Model(model) ? T5_TOKEN_LIMIT_V5 : T5_TOKEN_LIMIT_LEGACY
}

const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/g

/**
 * 估算提示词占用的 T5 token 数。移植自 koishi 插件的同名实现。
 *
 * CJK 单独按每字 1.5 token 计：T5 的 sentencepiece 对中日文覆盖差，
 * 常常一个字切成多个 token，按拉丁文的「4 字符 1 token」估会严重低估。
 * 宁可高估——漏报超限才是真问题。
 */
export function estimateT5Tokens(text: string): number {
  if (!text) return 0

  let n = (text.match(/[,:#()[\]{}.]/g) || []).length

  const cjk = text.match(CJK_RE) || []
  n += Math.ceil(cjk.length * 1.5)

  const latin = text.replace(CJK_RE, ' ')
  for (const word of latin.split(/[\s,:#()[\]{}]+/).filter(Boolean)) {
    n += Math.max(1, Math.ceil(word.length / 4))
  }

  return n
}
