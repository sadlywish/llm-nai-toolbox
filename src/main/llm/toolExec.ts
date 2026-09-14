import type { AppConfig } from '@shared/config'
import { searchTags } from '@shared/tagdb/search'
import { browseCategory, buildBrowseHint } from '../tagdb/browse'
import { characterFeatureText, characterSearchBlock, findCharacterFeature } from '../tagdb/charfeat'
import { escapeNaiTag } from '../tagdb/escape'
import { displayMapFromConfig, formatSearchResults } from '../tagdb/format'
import { toCharacterList, toQueryList } from './args'
import type { TagData } from './data'
import type { RunLog } from './log'
import { manualFileName } from './resources'
import type { JsonObject } from './types'

/**
 * 四个检索工具的本地执行。插件 index.ts 第 2272–2418 行（去掉了搜索日志落库与 LoRA）。
 * 工具只在数据可用时注册（tools.ts），这里对数据为 null 的兜底只防模型调用了没提供的工具。
 */

export interface SearchOutcome {
  text: string
  /** 本次每条查询的最高分都 ≥0.85（没有查询时为 true）。循环据此决定下一轮是否撤掉 search_tags */
  allHigh: boolean
  queryCount: number
}

export function executeSearchTags(args: JsonObject, data: TagData, config: AppConfig, log: RunLog): SearchOutcome {
  // 入参形状一律由 toQueryList 兜（字符串/数组/对象/嵌套/数字都能进来）
  const artistList = toQueryList(args.artists)
  const charList = toCharacterList(args.characters)
  const conceptList = toQueryList(args.concepts)
  const seriesList = toQueryList(args.series)
  log.info(
    `search_tags 入参: artists=${JSON.stringify(artistList)}, characters=${JSON.stringify(charList)}` +
      `, concepts=${JSON.stringify(conceptList)}, series=${JSON.stringify(seriesList)}`,
  )
  const queryCount = artistList.length + charList.length + conceptList.length + seriesList.length
  if (data.categories === null) return { text: '标签索引不可用，无法查询。', allHigh: false, queryCount }

  const sr = searchTags(data.categories, data.wikiMap ?? undefined, artistList, charList, conceptList, seriesList)
  const formatted = formatSearchResults(sr, data.categories.series.entries, displayMapFromConfig(config), data.gloss ?? undefined)
  // 返回体积一直没打，正是「单次查询把上下文顶爆」当初看不见的原因
  log.info(`search_tags 返回 ${formatted.length} 字符 (${sr.map((r) => `${r.query}:${r.matches.length}条`).join(', ')})`)

  let allHigh = true
  for (const r of sr) {
    const top = r.matches[0]
    if (top) {
      log.info(`search_tags 结果: [${r.type}] "${r.query}" → ${top.tag} (score=${top.score.toFixed(2)}, count=${top.count})`)
      if (top.score < 0.85) allHigh = false
    } else {
      log.info(`search_tags 结果: [${r.type}] "${r.query}" → 无匹配`)
      allHigh = false
    }
  }

  let text = formatted
  // 概念类用了字面搜索：直接在返回值里提示改用 browse_tags——不依赖 LLM 自己判断该不该换路子
  if (data.browse !== null && data.browse.cats.size > 0) {
    text += buildBrowseHint(
      data.browse,
      sr.map((r) => ({ q: r.query, score: r.matches[0]?.score ?? 0, type: r.type })),
    )
  }
  // 自动富化：角色搜索结果附带外貌/服装标签
  if (data.characters !== null) {
    for (const r of sr) {
      if (r.type !== '角色' || r.matches.length === 0) continue
      const topTag = r.matches[0].tag
      const feat = data.characters.get(topTag.toLowerCase())
      if (!feat) continue
      const ft = characterFeatureText(feat, {
        series: config.tagQueryCharacterSeries,
        appearance: config.tagQueryCharacterAppearance,
        clothing: config.tagQueryCharacterClothing,
      })
      if (ft) {
        text += `\n\n[角色特征] ${escapeNaiTag(topTag)}:\n${ft}\n  → 外貌和服装标签放入 appearance 字段，不要凭印象臆造，如果用户提示词有其他要求则覆盖角色特征`
      }
    }
  }
  return { text, allHigh, queryCount }
}

export function executeCharacterFeatures(args: JsonObject, data: TagData): string {
  const names = toQueryList(args.names)
  if (names.length === 0) return '请提供角色名称。'
  const db = data.characters
  if (db === null) return '角色特征数据库不可用。'
  return names
    .map((name) => {
      const feat = findCharacterFeature(db, name)
      return feat ? characterSearchBlock(feat) : `未找到角色 "${name}"`
    })
    .join('\n\n')
}

export function executeBrowse(args: JsonObject, data: TagData, config: AppConfig, log: RunLog): string {
  if (data.browse === null) return '标签分类索引不可用。'
  const category = String(args.category || '')
  const keyword = args.keyword ? String(args.keyword) : undefined
  const text = browseCategory(data.browse, category, keyword, Number(args.page) || 1, config.tagBrowsePageChars)
  log.info(
    `browse_tags: ${category}${keyword ? ` kw=${keyword}` : ''}${args.page ? ` p${String(args.page)}` : ''} (${text.length} 字符)`,
  )
  return text
}

export function executeLoadManual(args: JsonObject, manuals: ReadonlyMap<string, string>, enabled: boolean, log: RunLog): string {
  const topic = String(args.topic || '').trim().toLowerCase()
  if (!topic) return '请提供 topic 参数。'
  if (!enabled) return '主题手册未启用。'
  // manualFileName 只留 a-z0-9-，topic 里塞的路径穿越字符被剥掉；`_toc` 也因此取不到目录文件
  const text = manuals.get(manualFileName(topic))
  if (text === undefined) {
    log.warn(`load_tag_manual: 未找到主题 "${String(args.topic)}"`)
    return `未找到主题 "${String(args.topic)}"。请使用系统提示词手册目录中列出的主题名。`
  }
  log.info(`load_tag_manual: ${topic} (${text.length} 字符)`)
  return text
}
