import { describe, expect, it } from 'vitest'
import type { CompletionItem } from '@shared/ipc'
import { EDITOR_GLOSS_MAX, toCompletionOptions } from '@renderer/editor/completion'

const item = (over: Partial<CompletionItem>): CompletionItem => ({ tag: 'x', count: 1, zh: [], series: [], ...over })

describe('toCompletionOptions', () => {
  it('标签名、帖子数、中文别名与作品照旧；有释义的挂 gloss', () => {
    const [o] = toCompletionOptions([item({ tag: 'looking_at_viewer', count: 4_300_000, zh: ['看向观众', '直视镜头'], gloss: '角色直视镜头' })])
    expect(o).toMatchObject({ label: 'looking_at_viewer', apply: 'looking_at_viewer', detail: '4.3M', info: '看向观众 / 直视镜头', gloss: '角色直视镜头' })
    expect(o.byGloss).toBeUndefined()
  })

  it('释义补充行带 byGloss', () => {
    const [o] = toCompletionOptions([item({ tag: 'from_above', gloss: '俯视视角', byGloss: true })])
    expect(o).toMatchObject({ label: 'from_above', gloss: '俯视视角', byGloss: true })
  })

  it('没有别名与作品时 info 为 undefined；没有释义时不挂 gloss', () => {
    const [o] = toCompletionOptions([item({ tag: 'solo' })])
    expect(o.info).toBeUndefined()
    expect(o).not.toHaveProperty('gloss')
  })

  it('编辑器最多补 10 条释义', () => {
    expect(EDITOR_GLOSS_MAX).toBe(10)
  })
})
