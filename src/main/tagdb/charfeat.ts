import { escapeNaiTag, escapeNaiTagList } from './escape'

/**
 * 角色官方外貌与服装（character_features_v2.csv）。
 * 从 koishi-plugin-reforge 的 index.ts 搬运：CSV 解析在第 282–318 行，
 * 两段返回文本在第 119–125 行与第 2359–2366 行。本模块不读文件，读盘归 extras.ts。
 */
export interface CharacterFeature {
  character: string
  copyright: string
  appearance: string
  clothing: string
}

export type CharacterFeatureDb = Map<string, CharacterFeature>

/**
 * 解析 CSV：首行是表头；引号内的逗号不切；少于 4 列的行丢掉；键是小写角色标签。
 * 按 `\n` 切行后逐行 trim，所以 CRLF 的 `\r` 与表头的 BOM 都不会进数据。
 */
export function parseCharacterCsv(text: string): CharacterFeatureDb {
  const db: CharacterFeatureDb = new Map()
  const lines = text.split('\n')
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const fields: string[] = []
    let current = ''
    let inQuotes = false
    for (const ch of line) {
      if (ch === '"') {
        inQuotes = !inQuotes
      } else if (ch === ',' && !inQuotes) {
        fields.push(current)
        current = ''
      } else {
        current += ch
      }
    }
    fields.push(current)
    if (fields.length >= 4) {
      db.set(fields[0].toLowerCase(), {
        character: fields[0],
        copyright: fields[1],
        appearance: fields[2],
        clothing: fields[3],
      })
    }
  }
  return db
}

/**
 * 照插件 executeCharacterSearch：查询词小写、空格换下划线；先精确，再取第一个包含它的键。
 * 空查询直接返回 undefined——插件没拦，空串会「包含」于每个键，于是返回表里第一个角色。
 */
export function findCharacterFeature(db: CharacterFeatureDb, name: string): CharacterFeature | undefined {
  const query = name.trim().toLowerCase().replace(/ /g, '_')
  if (!query) return undefined
  const exact = db.get(query)
  if (exact) return exact
  for (const [key, value] of db) {
    if (key.includes(query)) return value
  }
  return undefined
}

export interface FeatureTextFlags {
  series: boolean
  appearance: boolean
  clothing: boolean
}

/** search_tags 结果里给角色附带的特征，按「标签查询返回」三个开关拼；三项都关时返回空串 */
export function characterFeatureText(feat: CharacterFeature, flags: FeatureTextFlags): string {
  const rows: string[] = []
  if (flags.series && feat.copyright) rows.push(`  作品: ${escapeNaiTag(feat.copyright)}`)
  if (flags.appearance && feat.appearance) rows.push(`  外貌: ${escapeNaiTagList(feat.appearance)}`)
  if (flags.clothing && feat.clothing) rows.push(`  服装: ${escapeNaiTagList(feat.clothing)}`)
  return rows.join('\n')
}

/** search_character_features 命中一个角色时的返回块 */
export function characterSearchBlock(feat: CharacterFeature): string {
  return [
    `角色: ${escapeNaiTag(feat.character)}`,
    `作品: ${escapeNaiTag(feat.copyright)}`,
    `外貌标签: ${escapeNaiTagList(feat.appearance)} → 放入 appearance 字段`,
    `服装标签: ${escapeNaiTagList(feat.clothing)} → 放入 appearance 字段`,
  ].join('\n')
}
