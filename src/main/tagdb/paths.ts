import { join } from 'path'

/**
 * 标签库数据文件（规格 §10.1）。
 *
 * index 在启动后由 loader.ts 异步加载，服务补全与 search_tags；
 * 其余五个是 LLM 工具的数据，第一次跑 LLM 时由 extras.ts 按需加载。
 */
export const TAGDB_FILES = {
  index: 'tags_index_v2.json',
  detail: 'tags_detail_v2.json',
  browse: 'tag_browse.json',
  gloss: 'tag_gloss.json',
  deprecated: 'tag_deprecated.json',
  characterFeatures: 'character_features_v2.csv',
} as const

/**
 * 解析 `resources/tagdb/` 的位置。
 *
 * 打包后 electron-builder 把 extraResources 放进 `process.resourcesPath`；
 * 开发态那个路径指向 Electron 自己 dist 里的 resources，跟本工程无关，
 * 必须回落到项目根。
 *
 * 不 import electron 的 `app`：那会让本模块在 vitest 的 node 环境里
 * 一 import 就炸。三个值由调用方从 `app` 取好传进来。
 */
export function resolveTagdbDir(opts: {
  isPackaged: boolean
  resourcesPath: string
  appRoot: string
}): string {
  return opts.isPackaged
    ? join(opts.resourcesPath, 'tagdb')
    : join(opts.appRoot, 'resources', 'tagdb')
}

export function tagdbFilePath(dir: string, file: string): string {
  return join(dir, file)
}
