import { join } from 'path'

/**
 * 本计划需要的数据文件。
 *
 * 只列真正有消费方的那一个。规格 §10.1 还列了 detail / browse / gloss /
 * deprecated / character_features / tag-manuals，但它们的消费方是 LLM 工具，
 * 属计划 3；提前声明就是没人读的死代码。
 */
export const TAGDB_FILES = {
  index: 'tags_index_v2.json',
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
