import skillCoreMd from '../../../resources/prompts/tag-skill-core.md?raw'

/**
 * 随包的标签规则与主题手册（规格 §10.1）。
 *
 * 构建期用 vite 的 `?raw` 与 `import.meta.glob` 打进主进程包，不在运行时读盘：
 * 一共一百多 KB，打进包里就不存在「装好的应用找不到手册目录」这种故障，
 * 也不必像标签库那样区分开发态与打包态的路径。
 */
export const TAG_SKILL_CORE = skillCoreMd.trim()

const manualFiles = import.meta.glob('../../../resources/tag-manuals/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** 文件名（如 `hair-styles.md`）→ 正文。`_toc.md` 是目录，不是主题 */
export const TAG_MANUALS: ReadonlyMap<string, string> = new Map(
  Object.entries(manualFiles).map(([path, text]) => [path.slice(path.lastIndexOf('/') + 1), text]),
)

/** 手册目录。启用手册时追加到系统提示词：不注入目录，LLM 不知道有哪些主题可调 */
export const TAG_MANUAL_TOC = (TAG_MANUALS.get('_toc.md') ?? '').trim()

/** 主题数（不含目录）。为 0 时 load_tag_manual 不注册 */
export function manualTopicCount(manuals: ReadonlyMap<string, string>): number {
  return [...manuals.keys()].filter((name) => name !== '_toc.md').length
}

/**
 * 主题名 → 文件名。照插件 index.ts 第 2408 行：空白换连字符、只留 a-z0-9-，
 * topic 里塞进来的路径穿越字符因此全部被剥掉。
 */
export function manualFileName(topic: string): string {
  return topic.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '.md'
}
