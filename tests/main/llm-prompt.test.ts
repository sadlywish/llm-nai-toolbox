import { describe, expect, it } from 'vitest'
import { defaultAppConfig } from '../../src/shared/config'
import type { LlmLogLine, LlmRunInput } from '../../src/shared/llm'
import { createCharacter, emptyWorkspace } from '../../src/shared/workspace'
import { RunLog } from '../../src/main/llm/log'
import {
  EDIT_SYSTEM_BLOCK,
  aspectRatioOf,
  buildSystemPrompt,
  buildUserPrompt,
  effectiveMultiCharacter,
  resolveStyleLock,
  styleLockLine,
  workspaceToEditArgs,
} from '../../src/main/llm/prompt'

const config = { ...defaultAppConfig(), systemPrompt: 'SYS', quality: 'Q', negativePrompt: 'N' }
function logger() {
  const lines: LlmLogLine[] = []
  return { lines, log: new RunLog((l) => lines.push(l)) }
}

describe('buildSystemPrompt', () => {
  it('系统提示词 → 技能文档 → 手册目录 → 分类目录，以空行分隔', () => {
    expect(
      buildSystemPrompt({ config, multi: 'off', editExisting: false, skillCore: 'CORE', manualToc: 'TOC', browseToc: 'BROWSE' }),
    ).toBe('SYS\n\nCORE\n\nTOC\n\nBROWSE')
  })

  it('手册未启用、分类目录为空时不带', () => {
    expect(buildSystemPrompt({ config, multi: 'off', editExisting: false, skillCore: 'CORE', manualToc: null, browseToc: '' })).toBe(
      'SYS\n\nCORE',
    )
  })

  it('多角色说明接在系统提示词之后、技能文档之前；修改模式说明在最后', () => {
    const s = buildSystemPrompt({ config, multi: 'auto', editExisting: true, skillCore: 'CORE', manualToc: null, browseToc: '' })
    expect(s.indexOf('[多角色模式已启用]')).toBeGreaterThan(s.indexOf('SYS'))
    expect(s.indexOf('[多角色模式已启用]')).toBeLessThan(s.indexOf('CORE'))
    expect(s.endsWith(EDIT_SYSTEM_BLOCK)).toBe(true)
  })
})

describe('buildUserPrompt', () => {
  it('普通：指令，空一行，设置行（质量词、画风锁定、负面词）', () => {
    expect(buildUserPrompt({ instruction: '画初音', config, lockedStyle: 'artist:wlop', existingParams: null, injection: null })).toBe(
      `画初音\n\n[质量词: Q]\n${styleLockLine('artist:wlop')}\n[负面词: N]`,
    )
  })

  it('有注入块时放在最前；没有任何设置行时只有指令', () => {
    const bare = { ...config, quality: '', negativePrompt: '' }
    expect(buildUserPrompt({ instruction: '画初音', config: bare, lockedStyle: null, existingParams: null, injection: 'INJ' })).toBe(
      'INJ\n\n画初音',
    )
  })

  it('修改模式：<现有参数> 在前，[用户的修改要求] 在后', () => {
    expect(
      buildUserPrompt({ instruction: '换成短发', config, lockedStyle: null, existingParams: 'tags: smile', injection: 'INJ' }),
    ).toBe(
      [
        '[修改模式] 以下是当前的完整生成参数：',
        '',
        '<现有参数>',
        'tags: smile',
        '</现有参数>',
        '',
        'INJ',
        '',
        '[用户的修改要求] 换成短发',
        '',
        '[质量词: Q]',
        '[负面词: N]',
      ].join('\n'),
    )
  })

  it('画风锁定行要求不写 artist', () => {
    expect(styleLockLine('artist:wlop')).toContain('[画风已锁定: artist:wlop')
    expect(styleLockLine('artist:wlop')).toContain('不要填写 artist 字段')
  })
})

describe('resolveStyleLock', () => {
  const ws = emptyWorkspace()

  it('不覆盖：null，不写日志', () => {
    const { lines, log } = logger()
    expect(resolveStyleLock({ mode: 'none' }, ws, log)).toBeNull()
    expect(lines).toEqual([])
  })

  it('选用的预设：去首尾空白后锁定', () => {
    const { lines, log } = logger()
    expect(resolveStyleLock({ mode: 'preset', tags: '  artist:wlop ' }, ws, log)).toBe('artist:wlop')
    expect(lines.map((l) => l.text)).toEqual(['[画风] 已锁定: artist:wlop'])
  })

  it('预设是空的：按不覆盖处理并告警', () => {
    const { lines, log } = logger()
    expect(resolveStyleLock({ mode: 'preset', tags: ' ' }, ws, log)).toBeNull()
    expect(lines[0].level).toBe('W')
  })

  it('当前 artist 块：有内容就锁定它；为空时退化成不锁定并写明', () => {
    const filled = emptyWorkspace()
    filled.main.artist = 'artist:ask'
    expect(resolveStyleLock({ mode: 'current' }, filled, logger().log)).toBe('artist:ask')
    const { lines, log } = logger()
    expect(resolveStyleLock({ mode: 'current' }, ws, log)).toBeNull()
    expect(lines[0]).toMatchObject({ level: 'W', text: '[画风] 当前 artist 块为空，已退化成不锁定' })
  })

  it('画风里的 LoRA 剥掉；剥完为空就不锁定', () => {
    expect(resolveStyleLock({ mode: 'preset', tags: '<lora:a:1>, wlop' }, ws, logger().log)).toBe('wlop')
    expect(resolveStyleLock({ mode: 'preset', tags: '<lora:a:1>' }, ws, logger().log)).toBeNull()
  })
})

describe('aspectRatioOf / workspaceToEditArgs', () => {
  it('宽高约分成比例', () => {
    expect(aspectRatioOf(1024, 1024)).toBe('1:1')
    expect(aspectRatioOf(832, 1216)).toBe('13:19')
    expect(aspectRatioOf(1344, 768)).toBe('7:4')
  })

  it('只带非空字段；seed 只在固定模式带；透明背景只在打开时带；只带启用的角色', () => {
    const ws = emptyWorkspace()
    ws.main.tags = ' smile '
    ws.negative = 'lowres'
    ws.text = 'HELLO'
    ws.params.width = 832
    ws.params.height = 1216
    ws.params.seed = 42
    ws.params.seedMode = 'perImage'
    const on = createCharacter()
    on.fields.character = 'miku'
    on.position = '0.3,0.5'
    const off = createCharacter()
    off.enabled = false
    off.fields.character = 'rin'
    ws.characters = [on, off]

    expect(workspaceToEditArgs(ws, true)).toEqual({
      tags: 'smile',
      negative_prompt: 'lowres',
      aspect_ratio: '13:19',
      text: 'HELLO',
      characters: [{ character: 'miku', position: '0.3,0.5' }],
    })
    ws.params.seedMode = 'fixed'
    ws.params.transparentBackground = true
    const args = workspaceToEditArgs(ws, false)
    expect(args.seed).toBe(42)
    expect(args.transparent_background).toBe(true)
    expect(args.characters).toBeUndefined()
  })
})

describe('effectiveMultiCharacter', () => {
  const input = (over: Partial<LlmRunInput>): LlmRunInput => ({
    instruction: 'x',
    multiCharacter: 'off',
    editExisting: false,
    transparent: false,
    style: { mode: 'none' },
    workspace: emptyWorkspace(),
    ...over,
  })

  it('修改模式 + 多角色关闭 + 现有内容有启用的角色：按「位置由模型安排」处理并写明', () => {
    const ws = emptyWorkspace()
    ws.characters = [createCharacter()]
    const { lines, log } = logger()
    expect(effectiveMultiCharacter(input({ editExisting: true, workspace: ws }), log)).toBe('auto')
    expect(lines[0].text).toContain('已按多角色处理')
  })

  it('其余情况原样', () => {
    const ws = emptyWorkspace()
    const disabled = createCharacter()
    disabled.enabled = false
    ws.characters = [disabled]
    expect(effectiveMultiCharacter(input({ editExisting: true, workspace: ws }), logger().log)).toBe('off')
    expect(effectiveMultiCharacter(input({ multiCharacter: 'coords', editExisting: true }), logger().log)).toBe('coords')
    const withChar = emptyWorkspace()
    withChar.characters = [createCharacter()]
    expect(effectiveMultiCharacter(input({ workspace: withChar }), logger().log)).toBe('off')
  })
})
