import type { AppConfig } from '@shared/config'
import { searchTags } from '@shared/tagdb/search'
import { browseCategory, buildBrowseHint } from '../tagdb/browse'
import { characterFeatureText } from '../tagdb/charfeat'
import { escapeNaiTag } from '../tagdb/escape'
import { displayMapFromConfig, formatSearchResults, visibleMatches } from '../tagdb/format'
import { toCharacterList, toQueryList } from './args'
import type { TagData } from './data'
import type { RunLog } from './log'
import { manualFileName } from './resources'
import type { JsonObject } from './types'

/**
 * 三个检索工具的本地执行。插件 index.ts 第 2272–2418 行（去掉了搜索日志落库与 LoRA）。
 * 工具只在数据可用时注册（tools.ts），这里对数据为 null 的兜底只防模型调用了没提供的工具。
 */

/** 每条角色查询最多给前几个候选附官方外貌/服装（再多是把上下文喂给模型用不上的同名角色） */
const FEATURE_MATCHES = 3

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
  // 同一份显示配置：格式化与下面的角色特征富化都按它截断，两边列出的候选才对得上
  const display = displayMapFromConfig(config)
  const formatted = formatSearchResults(sr, data.categories.series.entries, display, data.gloss ?? undefined)
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
  // 自动富化：角色搜索结果附带外貌/服装标签。
  //
  // 覆盖前 FEATURE_MATCHES 个候选而不只是第一名：同名角色分属不同作品是常事，
  // 模型未必选第一条，只给第一条的特征它就只能凭印象编另一条（原来那个
  // search_character_features 工具就是拿来补这一手的，2026-09-18 移除，改由这里覆盖）。
  // 候选取「模型实际看得见的那几条」，附上它看不到的候选只会让它引用不存在的行。
  if (data.characters !== null) {
    const flags = {
      series: config.tagQueryCharacterSeries,
      appearance: config.tagQueryCharacterAppearance,
      clothing: config.tagQueryCharacterClothing,
    }
    const seen = new Set<string>()
    const blocks: string[] = []
    for (const r of sr) {
      if (r.type !== '角色') continue
      for (const m of visibleMatches(r, display).slice(0, FEATURE_MATCHES)) {
        const key = m.tag.toLowerCase()
        // 几条查询命中同一个角色时只附一次
        if (seen.has(key)) continue
        const feat = data.characters.get(key)
        if (!feat) continue
        const ft = characterFeatureText(feat, flags)
        if (!ft) continue
        seen.add(key)
        blocks.push(`[角色特征] ${escapeNaiTag(m.tag)}:\n${ft}`)
      }
    }
    if (blocks.length > 0) {
      text += `\n\n${blocks.join('\n\n')}`
      text += '\n  → 外貌和服装标签放入 appearance 字段，不要凭印象臆造，如果用户提示词有其他要求则覆盖角色特征'
      if (blocks.length > 1) text += '\n  → 列出了多个候选时，只取你实际采用的那个角色的特征'
    }
  }
  return { text, allHigh, queryCount }
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
