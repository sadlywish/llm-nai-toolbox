import { describe, expect, it } from 'vitest'
import { TAGDB_FILES, resolveTagdbDir, tagdbFilePath } from '../../src/main/tagdb/paths'

describe('resolveTagdbDir', () => {
  it('打包后指向 resourcesPath 下的 tagdb', () => {
    const dir = resolveTagdbDir({
      isPackaged: true,
      resourcesPath: 'C:/Program Files/llm-nai-toolbox/resources',
      appRoot: 'C:/Program Files/llm-nai-toolbox/resources/app.asar',
    })
    expect(dir.replace(/\\/g, '/')).toBe('C:/Program Files/llm-nai-toolbox/resources/tagdb')
  })

  it('开发态指向项目根的 resources/tagdb', () => {
    const dir = resolveTagdbDir({
      isPackaged: false,
      resourcesPath: 'C:/whatever/node_modules/electron/dist/resources',
      appRoot: 'F:/llm-nai-toolbox',
    })
    expect(dir.replace(/\\/g, '/')).toBe('F:/llm-nai-toolbox/resources/tagdb')
  })

  it('开发态不去碰 resourcesPath —— 那是 Electron 自己的目录，里面没有我们的数据', () => {
    const dir = resolveTagdbDir({
      isPackaged: false,
      resourcesPath: 'C:/electron/dist/resources',
      appRoot: 'F:/proj',
    })
    expect(dir).not.toContain('electron')
  })
})

describe('tagdbFilePath', () => {
  it('拼出文件全路径', () => {
    expect(tagdbFilePath('F:/p/resources/tagdb', TAGDB_FILES.index).replace(/\\/g, '/'))
      .toBe('F:/p/resources/tagdb/tags_index_v2.json')
  })
})

describe('TAGDB_FILES', () => {
  it('index 之外还声明 LLM 工具用的五个附加数据文件', () => {
    expect(Object.keys(TAGDB_FILES)).toEqual(['index', 'detail', 'browse', 'gloss', 'deprecated', 'characterFeatures'])
  })
})
