import type { AppConfig } from '@shared/config'
import type { TagdbStatus } from '@shared/ipc'
import type { BrowseDb } from '../tagdb/browse'
import type { CharacterFeatureDb } from '../tagdb/charfeat'
import type { ExtraLoad } from '../tagdb/extras'
import type { DeprecatedDb, GlossDb } from '../tagdb/gloss'
import type { TagdbCategories } from '../tagdb/loader'
import type { RunLog } from './log'

/** 一轮 LLM 交互用到的标签数据。null = 该数据不可用，对应工具或功能关闭 */
export interface TagData {
  categories: TagdbCategories | null
  wikiMap: Map<string, string> | null
  browse: BrowseDb | null
  gloss: GlossDb | null
  deprecated: DeprecatedDb | null
  characters: CharacterFeatureDb | null
}

/** TagdbLoader 结构上满足它 */
export interface IndexSource {
  load(): Promise<void>
  readonly status: TagdbStatus
  readonly categories: TagdbCategories | null
}

/** TagExtrasLoader 结构上满足它 */
export interface ExtrasSource {
  browse(): Promise<ExtraLoad<BrowseDb>>
  gloss(): Promise<ExtraLoad<GlossDb>>
  deprecated(): Promise<ExtraLoad<DeprecatedDb>>
  characterFeatures(): Promise<ExtraLoad<CharacterFeatureDb>>
  wiki(): Promise<ExtraLoad<Map<string, string>>>
}

/** 四类「返回 wiki」开关任一打开，才需要 41MB 的 tags_detail_v2.json */
export function needsWiki(config: AppConfig): boolean {
  return config.tagQueryCharacterWiki || config.tagQueryArtistWiki || config.tagQueryGeneralWiki || config.tagQuerySeriesWiki
}

/**
 * 一轮开始前备齐标签数据。缺什么就在日志里写明哪个功能关掉了、因为哪个文件（规格 §10.2、§15）。
 * 「已加载 N 条」只在数据第一次读进内存时写，文案照插件启动日志。
 */
export async function prepareTagData(index: IndexSource, extras: ExtrasSource, config: AppConfig, log: RunLog): Promise<TagData> {
  if (index.status.state === 'idle' || index.status.state === 'loading') log.info('等待标签索引载入…')
  await index.load()
  const categories = index.categories
  if (categories === null) log.warn(`search_tags 已从工具集摘掉：${index.status.detail}`)

  const [browse, gloss, deprecated, characters, wiki] = await Promise.all([
    extras.browse(),
    extras.gloss(),
    extras.deprecated(),
    extras.characterFeatures(),
    needsWiki(config) ? extras.wiki() : Promise.resolve(null),
  ])

  const take = <T>(r: ExtraLoad<T>, loaded: (value: T) => string, unavailable: string): T | null => {
    if (r.ok) {
      if (r.fresh) log.info(loaded(r.value))
      return r.value
    }
    log.warn(`${unavailable}：${r.detail}`)
    return null
  }

  return {
    categories,
    browse: take(
      browse,
      (v) => `标签分类索引已加载: ${v.cats.size} 类 ${[...v.cats.values()].reduce((n, items) => n + items.length, 0)} 条`,
      'browse_tags 已从工具集摘掉',
    ),
    gloss: take(gloss, (v) => `标签语义字典已加载: ${v.size} 条`, '标签释义不可用（输入扫描注入与搜索结果释义）'),
    deprecated: take(deprecated, (v) => `废弃标签表已加载: ${v.size} 条`, '废弃标签提醒不可用'),
    characters: take(characters, (v) => `角色特征数据库已加载: ${v.size} 条`, 'search_character_features 已从工具集摘掉'),
    wikiMap: wiki === null ? null : take(wiki, (v) => `标签 wiki 已加载: ${v.size} 条`, '搜索结果不带 wiki 摘要'),
  }
}
