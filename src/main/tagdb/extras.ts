import { readFile } from 'fs/promises'
import { parseBrowseDb, type BrowseDb } from './browse'
import { parseCharacterCsv, type CharacterFeatureDb } from './charfeat'
import { parseDeprecatedDb, parseGlossDb, type DeprecatedDb, type GlossDb } from './gloss'
import { TAGDB_FILES, tagdbFilePath } from './paths'

/**
 * 一次加载的结果。
 *
 * `fresh` 只在**第一次**把成功结果交出去时为 true：调用方据此只打一次「已加载 N 条」，
 * 之后每一轮 LLM 都复用内存里的数据，不必每轮刷一遍日志。
 */
export type ExtraLoad<T> = { ok: true; value: T; fresh: boolean } | { ok: false; detail: string }

type Loaded<T> = { ok: true; value: T } | { ok: false; detail: string }

/**
 * LLM 工具用的附加数据文件，第一次跑 LLM 时按需加载（规格 §10.1）。
 *
 * - 成功的结果缓存进程终生；**失败不缓存**：用户看到「找不到 tag_browse.json」后把文件放进去，
 *   下一轮就该能用，不必重启应用。
 * - 并发调用共享同一次读取（缓存的是 promise，不是布尔量——见 loader.ts 的同类说明）。
 * - `JSON.parse` 本身是同步的，tags_detail_v2.json（41MB）会占住主线程一秒左右。
 *   这是一次性代价；它只在打开了任一类「返回 wiki」开关时才会被请求（见 llm/data.ts）。
 */
export class TagExtrasLoader {
  private readonly pending = new Map<string, Promise<Loaded<unknown>>>()
  private readonly announced = new Set<string>()

  constructor(private readonly dir: string) {}

  browse(): Promise<ExtraLoad<BrowseDb>> {
    return this.load(TAGDB_FILES.browse, (text) => parseBrowseDb(JSON.parse(text)), (db) => db.cats.size === 0)
  }

  gloss(): Promise<ExtraLoad<GlossDb>> {
    return this.load(TAGDB_FILES.gloss, (text) => parseGlossDb(JSON.parse(text)), (db) => db.size === 0)
  }

  deprecated(): Promise<ExtraLoad<DeprecatedDb>> {
    return this.load(TAGDB_FILES.deprecated, (text) => parseDeprecatedDb(JSON.parse(text)), (db) => db.size === 0)
  }

  characterFeatures(): Promise<ExtraLoad<CharacterFeatureDb>> {
    return this.load(TAGDB_FILES.characterFeatures, parseCharacterCsv, (db) => db.size === 0)
  }

  wiki(): Promise<ExtraLoad<Map<string, string>>> {
    return this.load(
      TAGDB_FILES.detail,
      (text) => {
        const raw: unknown = JSON.parse(text)
        const map = new Map<string, string>()
        if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
          for (const [tag, body] of Object.entries(raw)) {
            if (typeof body === 'string') map.set(tag, body)
          }
        }
        return map
      },
      (map) => map.size === 0,
    )
  }

  private async load<T>(file: string, parse: (text: string) => T, isEmpty: (value: T) => boolean): Promise<ExtraLoad<T>> {
    let p = this.pending.get(file) as Promise<Loaded<T>> | undefined
    if (p === undefined) {
      p = this.read(file, parse, isEmpty)
      this.pending.set(file, p)
    }
    const r = await p
    if (!r.ok) {
      // 失败不缓存。只删自己放进去的那一个，别把别人刚发起的新读取删掉
      if (this.pending.get(file) === p) this.pending.delete(file)
      return r
    }
    const fresh = !this.announced.has(file)
    this.announced.add(file)
    return { ok: true, value: r.value, fresh }
  }

  private async read<T>(file: string, parse: (text: string) => T, isEmpty: (value: T) => boolean): Promise<Loaded<T>> {
    const path = tagdbFilePath(this.dir, file)
    let text: string
    try {
      text = await readFile(path, 'utf-8')
    } catch (e) {
      // 与 loader.ts 一样分开两种失败：没放文件，和文件在但读不了
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: false, detail: `找不到 ${file}，请把它放进 ${this.dir}` }
      }
      return { ok: false, detail: `读取 ${file} 失败：${String(e)}` }
    }
    let value: T
    try {
      value = parse(text)
    } catch (e) {
      return { ok: false, detail: `${file} 解析失败：${String(e)}。文件可能不完整，请重新取一份` }
    }
    if (isEmpty(value)) {
      return { ok: false, detail: `${file} 里没有可用的数据，文件可能是旧版本或不完整` }
    }
    return { ok: true, value }
  }
}
