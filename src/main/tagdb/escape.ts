/**
 * Danbooru 原始标签 → NovelAI 提示词里的写法：下划线换空格，括号原样保留。
 *
 * 插件里还有一套 SD 风格（把括号转义成 `\(` `\)`）。NovelAI 的加权语法不是圆括号，
 * 转义反而会把反斜杠写进提示词（规格 §10.3），所以本工程只有这一种。
 */
export function escapeNaiTag(tag: string): string {
  return tag.replace(/_/g, ' ')
}

/** 逗号分隔的标签列表逐个转写（角色特征的外貌、服装列） */
export function escapeNaiTagList(list: string): string {
  if (!list) return list
  return list
    .split(',')
    .map((t) => escapeNaiTag(t.trim()))
    .filter(Boolean)
    .join(', ')
}
