import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JsonStore } from '../../src/main/store'

interface Doc {
  n: number
}

const isDoc = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && typeof (v as { n?: unknown }).n === 'number'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jsonstore-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('JsonStore', () => {
  it('文件不存在时返回 fallback，exists 为 false', () => {
    const store = new JsonStore<Doc>(join(dir, 'a.json'), () => ({ n: 0 }), isDoc)
    expect(store.exists()).toBe(false)
    expect(store.read()).toEqual({ n: 0 })
  })

  it('写入后读回一致，且不留下 .tmp', () => {
    const file = join(dir, 'a.json')
    const store = new JsonStore<Doc>(file, () => ({ n: 0 }), isDoc)
    store.write({ n: 42 })
    expect(store.exists()).toBe(true)
    expect(store.read()).toEqual({ n: 42 })
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it('父目录不存在时自动创建', () => {
    const file = join(dir, 'nested', 'deeper', 'a.json')
    new JsonStore<Doc>(file, () => ({ n: 0 })).write({ n: 1 })
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ n: 1 })
  })

  it('JSON 解析失败回退 fallback，不动原文件', () => {
    const file = join(dir, 'a.json')
    writeFileSync(file, '{ 半截')
    const store = new JsonStore<Doc>(file, () => ({ n: 0 }), isDoc)
    expect(store.read()).toEqual({ n: 0 })
    expect(readFileSync(file, 'utf-8')).toBe('{ 半截')
  })

  it('形状不对回退 fallback，并把坏文件改名为 .corrupt 留证', () => {
    const file = join(dir, 'a.json')
    writeFileSync(file, JSON.stringify({ n: 'x' }))
    const store = new JsonStore<Doc>(file, () => ({ n: 0 }), isDoc)
    expect(store.read()).toEqual({ n: 0 })
    expect(existsSync(file)).toBe(false)
    expect(existsSync(`${file}.corrupt`)).toBe(true)
  })
})
