import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TagExtrasLoader } from '../../src/main/tagdb/extras'
import { TAGDB_FILES } from '../../src/main/tagdb/paths'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'extras-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const put = (file: string, content: string) => writeFileSync(join(dir, file), content, 'utf-8')

describe('TagExtrasLoader', () => {
  it('缺文件：ok 为 false，detail 写明文件名与目录', async () => {
    const r = await new TagExtrasLoader(dir).browse()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.detail).toContain(TAGDB_FILES.browse)
      expect(r.detail).toContain(dir)
    }
  })

  it('JSON 坏了：说解析失败', async () => {
    put(TAGDB_FILES.gloss, '{ 半截')
    const r = await new TagExtrasLoader(dir).gloss()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain('解析失败')
  })

  it('解析出来是空的：说没有可用数据', async () => {
    put(TAGDB_FILES.deprecated, '{}')
    const r = await new TagExtrasLoader(dir).deprecated()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain('没有可用的数据')
  })

  it('读成功：第一次 fresh 为 true，之后为 false，且拿到的是同一份数据', async () => {
    put(TAGDB_FILES.gloss, JSON.stringify({ smile: { g: '微笑' } }))
    const loader = new TagExtrasLoader(dir)
    const a = await loader.gloss()
    const b = await loader.gloss()
    expect(a.ok && a.fresh).toBe(true)
    expect(b.ok && !b.fresh).toBe(true)
    if (a.ok && b.ok) expect(b.value).toBe(a.value)
  })

  it('失败不缓存：补上文件后下一次调用能读到', async () => {
    const loader = new TagExtrasLoader(dir)
    expect((await loader.characterFeatures()).ok).toBe(false)
    put(TAGDB_FILES.characterFeatures, 'character,copyright,appearance,clothing\nmiku,vocaloid,aqua_hair,necktie\n')
    const r = await loader.characterFeatures()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.get('miku')?.copyright).toBe('vocaloid')
  })

  it('并发调用共享同一次读取', async () => {
    put(TAGDB_FILES.browse, JSON.stringify({ _toc: [], 'a/b': [{ t: 'x', g: 'y', c: 1 }] }))
    const loader = new TagExtrasLoader(dir)
    const [a, b] = await Promise.all([loader.browse(), loader.browse()])
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(b.value).toBe(a.value)
      expect([a.fresh, b.fresh].filter(Boolean)).toHaveLength(1)
    }
  })

  it('wiki：只收字符串值', async () => {
    put(TAGDB_FILES.detail, JSON.stringify({ miku: 'Vocaloid', bad: 3 }))
    const r = await new TagExtrasLoader(dir).wiki()
    expect(r.ok).toBe(true)
    if (r.ok) expect([...r.value.entries()]).toEqual([['miku', 'Vocaloid']])
  })

  it('同名目录（读不了）：说读取失败而不是找不到', async () => {
    mkdirSync(join(dir, TAGDB_FILES.browse))
    const r = await new TagExtrasLoader(dir).browse()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain('读取')
  })
})
