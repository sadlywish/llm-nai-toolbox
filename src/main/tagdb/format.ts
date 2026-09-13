import type { AppConfig } from '@shared/config'
import type { SearchResult, SearchType, TagEntry } from '@shared/tagdb/search'
import { escapeNaiTag } from './escape'
import { lookupGloss, type GlossDb } from './gloss'

/**
 * search_tags 的返回文本（给 LLM 读）。从插件 tag-db.ts 第 823–947 行搬运，
 * 去掉了 SD 转义风格参数（本工程只有 NovelAI 写法，见 escape.ts）。
 */

/** 各类别的返回控制 */
export interface TagQueryDisplay {
  /** 最多返回几条；0 或负数表示不限制（仍受 HARD_MAX_MATCHES 约束） */
  max: number
  aliases: boolean
  wiki: boolean
  /** 仅角色类别使用 */
  series?: boolean
  /** wiki / 释义摘要截断长度 */
  wikiLength: number
}

export type TagQueryDisplayMap = Record<SearchType, TagQueryDisplay>

/** 把扁平的「标签查询返回」配置整理成按类别索引的形式（插件 index.ts 第 90–116 行） */
export function displayMapFromConfig(config: AppConfig): TagQueryDisplayMap {
  return {
    角色: {
      max: config.tagQueryCharacterMax,
      aliases: config.tagQueryCharacterAliases,
      wiki: config.tagQueryCharacterWiki,
      series: config.tagQueryCharacterSeries,
      wikiLength: config.tagQueryWikiLength,
    },
    画师: {
      max: config.tagQueryArtistMax,
      aliases: config.tagQueryArtistAliases,
      wiki: config.tagQueryArtistWiki,
      wikiLength: config.tagQueryWikiLength,
    },
    概念: {
      max: config.tagQueryGeneralMax,
      aliases: config.tagQueryGeneralAliases,
      wiki: config.tagQueryGeneralWiki,
      wikiLength: config.tagQueryWikiLength,
    },
    作品: {
      max: config.tagQuerySeriesMax,
      aliases: config.tagQuerySeriesAliases,
      wiki: config.tagQuerySeriesWiki,
      wikiLength: config.tagQueryWikiLength,
    },
  }
}

const DEFAULT_DISPLAY: TagQueryDisplay = { max: 0, aliases: true, wiki: false, series: true, wikiLength: 300 }

/**
 * 单个查询最多列出多少条（硬上限，不受配置影响）。
 *
 * 配置里的 max 允许填 0 表示"不限制"，那是给正常查询用的便利，
 * 不该同时意味着"打分崩了也照单全收"。60 条已远超 LLM 实际能用到的量，
 * 而 6819 条那种情况是纯粹的故障。
 */
const HARD_MAX_MATCHES = 60

/**
 * 整个 search_tags 返回的字符上限（硬上限）。
 * 一次查多个词时，每个都合规也可能加起来过大；这道闸按总量再兜一层。
 */
const HARD_MAX_CHARS = 60000

/** 按字符数截断，超出时补省略号，避免半句话结尾看不出被截 */
function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : t.slice(0, max).trimEnd() + '…'
}

export function formatSearchResults(
  results: SearchResult[],
  seriesDb: TagEntry[],
  display?: TagQueryDisplayMap,
  glossDb?: GlossDb,
): string {
  const blocks = results.map(r => {
    const conf = display?.[r.type] || DEFAULT_DISPLAY
    const header = `[${r.type}] 查询: "${r.query}"`
    if (r.matches.length === 0) {
      return `${header}\n  无匹配结果`
    }

    // 结果已按分数排序，截断即取最相关的前 N 条。
    //
    // HARD_MAX 是**兜底而非配置**：conf.max 允许填 0（不限制），一旦打分出问题
    // 就没有任何东西挡着。实测查单个字母 "W" 匹配到 6819 条角色、格式化出
    // 168 万字符，一次调用把 100 万 token 的上下文顶爆，请求直接 400。
    // 单次工具返回本就不该有能力做到这件事，所以这道闸不受配置控制。
    const limit = conf.max > 0 ? Math.min(conf.max, HARD_MAX_MATCHES) : HARD_MAX_MATCHES
    const shown = r.matches.slice(0, limit)
    const omitted = r.matches.length - shown.length

    const lines = shown.map((m, i) => {
      const parts: string[] = []
      // 基本信息：tag 已转义为对应后端可直接使用的形式
      let line = `  ${i + 1}. ${escapeNaiTag(m.tag)} (匹配度: ${m.score.toFixed(2)}, 图片数: ${m.count}`
      if (m.series.length > 0 && conf.series !== false) {
        // 查找作品中文名（找不到就用转义后的原 tag）
        const seriesNames = m.series.map(s => {
          const se = seriesDb.find(e => e.tag === s || e.en.includes(s))
          return se?.zh?.[0] || escapeNaiTag(s)
        })
        line += `, 作品: ${seriesNames.join(', ')}`
      }
      line += ')'
      parts.push(line)

      if (conf.aliases && m.zh.length > 0) {
        parts.push(`     中文名: ${m.zh.join(', ')}`)
      }

      if (conf.wiki) {
        // gloss 优先：密度远高于 DText 原文（中位 130 vs 274，且无链接标记噪音）。
        // 未命中时回退原 wiki 摘要——gloss 只覆盖 count>=1000，长尾仍需 wiki。
        const ge = glossDb ? lookupGloss(glossDb, m.tag) : undefined
        const glossLen = conf.wikiLength > 0 ? conf.wikiLength : 300
        if (ge) {
          // gloss 同样受 wikiLength 约束：P0 阶段的英文核心定义仍可能很长，
          // 不截断的话「换成 gloss」反而比原 wiki 更占 token。
          parts.push(`     释义: ${truncate(ge.g, glossLen)}`)
          if (ge.vs && ge.vs.length > 0) {
            const vsText = ge.vs
              .filter(([t]) => t)
              .map(([t, d]) => d ? `${t}=${truncate(d, glossLen)}` : truncate(t, glossLen))
              .join('; ')
            if (vsText) parts.push(`     区别: ${vsText}`)
          }
        } else if (m.wiki) {
          const summary = m.wiki.substring(0, glossLen).replace(/\s+/g, ' ').trim()
          if (summary) parts.push(`     wiki: ${summary}`)
        }
      }

      return parts.join('\n')
    })

    // 明确告知被截断的条数，避免「只有这几个」的错觉
    const tail = omitted > 0 ? `\n  （另有 ${omitted} 条同等匹配结果未列出）` : ''
    return `${header}\n${lines.join('\n')}${tail}`
  })

  // 总量兜底：每条查询都合规，加起来仍可能过大（一次传十几个查询词时）。
  // 超了就整块丢掉靠后的，并明说丢了几条——静默截断会让 LLM 以为查询无结果。
  const out: string[] = []
  let used = 0
  for (let i = 0; i < blocks.length; i++) {
    if (used + blocks[i].length > HARD_MAX_CHARS && out.length > 0) {
      out.push(`[已达返回上限] 还有 ${blocks.length - i} 条查询的结果未列出，`
        + '请减少单次查询词数量后重试，或改用 browse_tags 浏览分类。')
      break
    }
    out.push(blocks[i])
    used += blocks[i].length
  }
  return out.join('\n\n')
}
