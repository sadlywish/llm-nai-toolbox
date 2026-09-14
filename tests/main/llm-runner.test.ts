import { describe, expect, it } from 'vitest'
import { defaultAppConfig, type AppConfig } from '../../src/shared/config'
import type { LlmEvent, LlmRunInput } from '../../src/shared/llm'
import { buildIndex, type TagEntry } from '../../src/shared/tagdb/search'
import { createCharacter, emptyWorkspace } from '../../src/shared/workspace'
import { parseBrowseDb } from '../../src/main/tagdb/browse'
import { parseCharacterCsv } from '../../src/main/tagdb/charfeat'
import { parseGlossDb } from '../../src/main/tagdb/gloss'
import type { TagdbCategories } from '../../src/main/tagdb/loader'
import type { TagData } from '../../src/main/llm/data'
import { LlmHttpError } from '../../src/main/llm/http'
import { TRUNCATION_RETRY_TEXT } from '../../src/main/llm/messages'
import { runLlm, type RunnerDeps } from '../../src/main/llm/runner'
import type { ChatFn, ChatMessage, ChatRequest, ChatResult, JsonObject, PendingCall } from '../../src/main/llm/types'

const e = (tag: string, count: number, extra: Partial<TagEntry> = {}): TagEntry => ({
  tag, count, zh: [], zhFull: [], zhShort: [], zhNick: [], ja: [], en: [], other: [], series: [], ...extra,
})
const cat = (entries: TagEntry[]) => ({ entries, index: buildIndex(entries), completionIndex: new Map<string, number[]>() })

const categories: TagdbCategories = {
  artists: cat([e('wlop', 9000)]),
  characters: cat([e('hatsune_miku', 5000, { zh: ['初音未来'] })]),
  series: cat([e('vocaloid', 100)]),
  general: cat([e('from_above', 300, { zh: ['俯视'] })]),
}

function tagData(over: Partial<TagData> = {}): TagData {
  return {
    categories,
    wikiMap: null,
    browse: parseBrowseDb({
      _toc: [{ cat: '画面构成/image composition', n: 25, top: 'from above, from below' }],
      '画面构成/image composition': [{ t: 'from_above', g: '俯视', c: 1 }],
    }),
    gloss: parseGlossDb({ deep_skin: { g: '深色皮肤', trap: '不是皮肤很深' } }),
    deprecated: null,
    characters: parseCharacterCsv('character,copyright,appearance,clothing\nhatsune_miku,vocaloid,aqua_hair,necktie\n'),
    ...over,
  }
}

type Step = (req: ChatRequest) => ChatResult | Promise<ChatResult>
interface Seen {
  messages: ChatMessage[]
  tools: string[]
  system: string
}

const call = (name: string, args: JsonObject, id = `${name}-1`): PendingCall => ({ id, name, args })
const reply =
  (pendingCalls: PendingCall[], over: Partial<ChatResult> = {}): Step =>
  () => ({
    text: '',
    pendingCalls,
    stopReason: pendingCalls.length > 0 ? 'tool_use' : 'end_turn',
    usage: { inputTokens: 100, outputTokens: 10 },
    ...over,
  })

function input(over: Partial<LlmRunInput> = {}): LlmRunInput {
  return {
    instruction: '画初音未来',
    multiCharacter: 'off',
    editExisting: false,
    transparent: false,
    style: { mode: 'none' },
    workspace: emptyWorkspace(),
    ...over,
  }
}

function harness(
  steps: Step[],
  over: { config?: Partial<AppConfig>; data?: Partial<TagData>; apiKey?: string; signal?: AbortSignal } = {},
) {
  const seen: Seen[] = []
  const chat: ChatFn = async (req) => {
    // 快照：runner 之后会继续往同一个数组里追加
    seen.push({ messages: structuredClone([...req.messages]), tools: req.tools.map((t) => t.name), system: req.system })
    const step = steps[seen.length - 1]
    if (step === undefined) throw new Error('脚本用完了')
    return step(req)
  }
  const events: LlmEvent[] = []
  const deps: RunnerDeps = {
    config: { ...defaultAppConfig(), maxToolRounds: 4, quality: 'masterpiece', negativePrompt: 'lowres', ...over.config },
    apiKey: over.apiKey ?? 'sk-test',
    chat,
    prepareData: async () => tagData(over.data),
    manuals: new Map([['_toc.md', 'TOC'], ['hair-styles.md', '# 发型']]),
    manualToc: 'TOC',
    skillCore: 'CORE',
    signal: over.signal ?? new AbortController().signal,
    emit: (ev) => events.push(ev),
  }
  const lines = () => events.flatMap((ev) => (ev.kind === 'log' ? [`[${ev.line.level}] ${ev.line.text}`] : []))
  const rounds = () => events.flatMap((ev) => (ev.kind === 'round' ? [ev.round] : []))
  return { deps, seen, lines, rounds }
}

const firstUserText = (s: Seen): string => String(((s.messages[0].content as JsonObject[])[0] as JsonObject).text)

describe('runLlm：跑通一轮', () => {
  it('第 1 轮查标签、第 2 轮收口：回填内容、轮次事件、上下文里带着工具结果', async () => {
    const h = harness(
      [
        reply([call('search_tags', { characters: [{ name: '初音未来' }] })]),
        reply([call('generate_image', { character: 'hatsune miku', artist: 'artist:wlop', tags: 'smile', aspect_ratio: '2:3' })]),
      ],
      { config: { tagManualEnabled: false } },
    )
    const r = await runLlm(input(), h.deps)
    expect(r.status).toBe('filled')
    if (r.status !== 'filled') return
    expect(r.rounds).toBe(2)
    expect(r.fill.main.character).toBe('hatsune miku')
    expect([r.fill.width, r.fill.height]).toEqual([832, 1216])
    expect(h.rounds()).toEqual([1, 2])

    const second = h.seen[1].messages
    expect(second).toHaveLength(3)
    expect(second[1].role).toBe('assistant')
    const toolResult = (second[2].content as JsonObject[])[0]
    expect(toolResult).toMatchObject({ type: 'tool_result', tool_use_id: 'search_tags-1' })
    expect(String(toolResult.content)).toContain('hatsune miku')

    expect(firstUserText(h.seen[0])).toBe('画初音未来\n\n[质量词: masterpiece]\n[负面词: lowres]')
    expect(h.seen[0].system).toContain('CORE')
    expect(h.seen[0].system).toContain('### 标签分类目录')
    expect(h.lines()).toContain('[I] 本轮工具集: generate_image, search_tags, search_character_features, browse_tags')
    expect(h.lines()).toContain('[I] 多轮 tool_use: 第 1 轮，1 个搜索调用')
    expect(h.lines()).toContain('[I] Token 累计: 第2轮 100in/10out, 总计 200in/20out')
    expect(h.lines()).toContain('[I] [查询覆盖] 第2轮 LLM 停止检索，累计 1 个查询词、0 次分类浏览')
    expect(h.lines()).toContain('[I] LLM 全部轮次完成, 总消耗 token: 200 input + 20 output = 220 total')
  })

  it('OpenAI 兼容端点：首条消息是字符串，工具结果是 role=tool', async () => {
    const h = harness(
      [reply([call('search_tags', { concepts: '俯视' }, 'c1')]), reply([call('generate_image', { artist: 'a' })])],
      { config: { apiType: 'openai' } },
    )
    await runLlm(input(), h.deps)
    expect(typeof h.seen[0].messages[0].content).toBe('string')
    expect(h.seen[1].messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'c1' })
  })
})

describe('runLlm：工具集', () => {
  it('搜索全部高置信且开着 autoSkipSearch：下一轮撤掉 search_tags；关掉开关则保留', async () => {
    const steps = () => [reply([call('search_tags', { characters: '初音未来' })]), reply([call('generate_image', { artist: 'a' })])]
    const on = harness(steps(), { config: { autoSkipSearch: true } })
    await runLlm(input(), on.deps)
    expect(on.seen[1].tools).not.toContain('search_tags')
    expect(on.lines()).toContain('[I] 所有搜索结果高置信度 (≥0.85)，下一轮禁用 search_tags')
    const off = harness(steps(), { config: { autoSkipSearch: false } })
    await runLlm(input(), off.deps)
    expect(off.seen[1].tools).toContain('search_tags')
  })

  it('只调了 browse_tags 的轮次不触发撤掉 search_tags', async () => {
    const h = harness([reply([call('browse_tags', { category: 'image composition' })]), reply([call('generate_image', { artist: 'a' })])])
    await runLlm(input(), h.deps)
    expect(h.seen[1].tools).toContain('search_tags')
  })

  it('最后一轮只给生成工具', async () => {
    const h = harness([reply([call('search_tags', { concepts: '俯视' })]), reply([call('generate_image', { artist: 'a' })])], {
      config: { maxToolRounds: 2, autoSkipSearch: false },
    })
    await runLlm(input(), h.deps)
    expect(h.seen[1].tools).toEqual(['generate_image'])
  })

  it('标签数据缺失的工具不注册，分类目录也不进系统提示词', async () => {
    const h = harness([reply([call('generate_image', { artist: 'a' })])], {
      data: { categories: null, browse: null, characters: null },
      config: { tagManualEnabled: false },
    })
    await runLlm(input(), h.deps)
    expect(h.seen[0].tools).toEqual(['generate_image'])
    expect(h.seen[0].system).not.toContain('标签分类目录')
  })

  it('开了标签手册：注册 load_tag_manual，手册目录进系统提示词', async () => {
    const h = harness([reply([call('generate_image', { artist: 'a' })])], { config: { tagManualEnabled: true } })
    await runLlm(input(), h.deps)
    expect(h.seen[0].tools).toContain('load_tag_manual')
    expect(h.seen[0].system).toContain('TOC')
  })
})

describe('runLlm：收口', () => {
  it('响应被截断且没有工具调用：回放文本、追加续接提示、继续下一轮', async () => {
    const h = harness([reply([], { stopReason: 'max_tokens', text: '写到一半' }), reply([call('generate_image', { artist: 'a' })])])
    const r = await runLlm(input(), h.deps)
    expect(r.status).toBe('filled')
    expect(h.seen[1].messages.slice(-2)).toEqual([
      { role: 'assistant', content: '写到一半' },
      { role: 'user', content: TRUNCATION_RETRY_TEXT },
    ])
    expect(h.lines()).toContain('[W] 第 1 轮响应被截断 (max_tokens)，追加续接提示')
  })

  it('模型没调生成工具就结束：不回填，原样写出它说了什么', async () => {
    const h = harness([reply([], { text: '「那个很火的」指代不明确' })])
    const r = await runLlm(input(), h.deps)
    expect(r).toMatchObject({ status: 'noParams', rounds: 1 })
    expect(h.lines().slice(-3)).toEqual([
      '[I] LLM 全部轮次完成, 总消耗 token: 100 input + 10 output = 110 total',
      '[W] AI 未调用生成工具，文本回复: 「那个很火的」指代不明确',
      '[W] 模型没有给出参数，编辑器内容未改动',
    ])
  })

  it('同一轮里既有搜索又有生成：生成调用拿到「请先完成标签查询」，循环继续', async () => {
    const h = harness([
      reply([call('search_tags', { concepts: '俯视' }), call('generate_image', { artist: 'early' })]),
      reply([call('generate_image', { artist: 'final' })]),
    ])
    const r = await runLlm(input(), h.deps)
    const results = h.seen[1].messages[2].content as JsonObject[]
    expect(results[1]).toEqual({ type: 'tool_result', tool_use_id: 'generate_image-1', content: '请先完成标签查询后再调用此工具。' })
    expect(r.status).toBe('filled')
    if (r.status === 'filled') expect(r.fill.main.artist).toBe('final')
  })

  it('一轮里有多个生成调用：只用第一个', async () => {
    const h = harness([reply([call('generate_image', { artist: 'first' }, 'a'), call('generate_image', { artist: 'second' }, 'b')])])
    const r = await runLlm(input(), h.deps)
    expect(r.status).toBe('filled')
    if (r.status === 'filled') expect(r.fill.main.artist).toBe('first')
    expect(h.lines()).toContain('[I] 跳过多余的 generate_image 调用（仅执行第一个）')
  })
})

describe('runLlm：指令区的开关', () => {
  it('手动指定坐标：多角色工具、多角色说明、角色回填、打开坐标定位', async () => {
    const h = harness([
      reply([
        call('generate_image_characters', {
          artist: 'a',
          count: '2girls',
          characters: [{ count: 'girl', character: 'miku', position: '0.3,0.5' }],
        }),
      ]),
    ])
    const r = await runLlm(input({ multiCharacter: 'coords' }), h.deps)
    expect(h.seen[0].tools[0]).toBe('generate_image_characters')
    expect(h.seen[0].system).toContain('[多角色模式已启用]')
    expect(h.seen[0].system).not.toContain('本次未启用坐标定位')
    expect(r.status).toBe('filled')
    if (r.status !== 'filled') return
    expect(r.fill.characters).toHaveLength(1)
    expect(r.fill.characters[0].position).toBe('0.3,0.5')
    expect(r.fill.useCoords).toBe(true)
  })

  it('位置由模型安排：说明里带「未启用坐标定位」，回填时坐标定位关闭', async () => {
    const h = harness([reply([call('generate_image_characters', { artist: 'a', characters: [{ count: 'girl' }] })])])
    const r = await runLlm(input({ multiCharacter: 'auto' }), h.deps)
    expect(h.seen[0].system).toContain('本次未启用坐标定位')
    expect(r.status).toBe('filled')
    if (r.status === 'filled') expect(r.fill.useCoords).toBe(false)
  })

  it('在现有内容上修改：<现有参数> 来自工作区；有启用的角色时自动用多角色工具', async () => {
    const ws = emptyWorkspace()
    ws.main.tags = 'smile'
    const ch = createCharacter()
    ch.fields.character = 'miku'
    ws.characters = [ch]
    const h = harness([reply([call('generate_image_characters', { artist: 'a', characters: [{ character: 'miku' }] })])])
    await runLlm(input({ editExisting: true, instruction: '换成短发', workspace: ws }), h.deps)
    const text = firstUserText(h.seen[0])
    expect(text).toContain('<现有参数>\ntags: smile\naspect_ratio: 1:1\ncharacters: [')
    expect(text).toContain('[用户的修改要求] 换成短发')
    expect(h.seen[0].system).toContain('[修改模式已启用]')
    expect(h.seen[0].tools[0]).toBe('generate_image_characters')
  })

  it('用选用的预设覆盖：画风不注入上下文，收口后 artist 被替换', async () => {
    const h = harness([reply([call('generate_image', { artist: 'someone', tags: 'smile' })])])
    const r = await runLlm(input({ style: { mode: 'preset', tags: 'artist:wlop' } }), h.deps)
    expect(JSON.stringify(h.seen[0].messages)).not.toContain('artist:wlop')
    expect(r.status).toBe('filled')
    if (r.status === 'filled') expect(r.fill.main.artist).toBe('artist:wlop')
  })

  it('用当前 artist 块覆盖但块是空的：退化成不锁定，上下文里没有锁定行', async () => {
    const h = harness([reply([call('generate_image', { artist: 'someone' })])])
    const r = await runLlm(input({ style: { mode: 'current' } }), h.deps)
    expect(h.lines()).toContain('[W] [画风] 当前 artist 块为空，已退化成不锁定')
    expect(JSON.stringify(h.seen[0].messages)).not.toContain('画风已锁定')
    expect(r.status).toBe('filled')
    if (r.status === 'filled') expect(r.fill.main.artist).toBe('someone')
  })

  it('指令里夹着字面会读错的标签：用户消息最前面注入释义', async () => {
    const h = harness([reply([call('generate_image', { artist: 'a' })])])
    await runLlm(input({ instruction: '要有 deep skin 的效果' }), h.deps)
    expect(firstUserText(h.seen[0]).startsWith('<标签释义>')).toBe(true)
    expect(h.lines()).toContain('[I] [tag-inject] 注入 1 条标签释义')
  })
})

describe('runLlm：失败与中止', () => {
  it('没填 API Key：不发请求，直接失败', async () => {
    const h = harness([], { apiKey: '  ' })
    const r = await runLlm(input(), h.deps)
    expect(r).toMatchObject({ status: 'failed', rounds: 0, message: '还没有填写 API Key' })
    expect(h.seen).toHaveLength(0)
    expect(h.lines()).toEqual(['[E] 还没有填写 API Key，去「设置 → LLM API」填写。编辑器内容未改动'])
  })

  it('请求失败 401：两行 E，第一行是接口原文，第二行是下一步', async () => {
    const h = harness([
      () => {
        throw new LlmHttpError(401, '{"error":{"type":"authentication_error","message":"invalid x-api-key"}}')
      },
    ])
    const r = await runLlm(input(), h.deps)
    expect(r).toMatchObject({ status: 'failed', rounds: 1, message: '401 authentication_error: invalid x-api-key' })
    expect(h.lines().slice(-2)).toEqual([
      '[E] 第 1 轮请求失败: 401 authentication_error: invalid x-api-key',
      '[E] API Key 无效或已过期，去「设置 → LLM API」重新填写。编辑器内容未改动',
    ])
  })

  it('不是请求阶段的失败：写「处理失败」，不冒充请求失败', async () => {
    const h = harness([])
    h.deps.prepareData = async () => {
      throw new Error('磁盘坏了')
    }
    const r = await runLlm(input(), h.deps)
    expect(r).toMatchObject({ status: 'failed', rounds: 0, message: '磁盘坏了' })
    expect(h.lines()).toEqual(['[E] 处理失败: 磁盘坏了', '[E] 编辑器内容未改动'])
  })

  it('中止：正在请求的那一轮被打断，不回填', async () => {
    const ac = new AbortController()
    const h = harness(
      [
        reply([call('search_tags', { concepts: '俯视' })]),
        (req) =>
          new Promise<ChatResult>((_resolve, reject) => {
            req.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
            ac.abort()
          }),
      ],
      { signal: ac.signal },
    )
    const r = await runLlm(input(), h.deps)
    expect(r).toMatchObject({ status: 'aborted', rounds: 2 })
    expect(h.lines().at(-1)).toBe('[W] 已中止（第 2 轮），编辑器内容未改动')
  })

  it('备数据期间就中止了：不发请求', async () => {
    const ac = new AbortController()
    const h = harness([], { signal: ac.signal })
    h.deps.prepareData = async () => {
      ac.abort()
      return tagData()
    }
    const r = await runLlm(input(), h.deps)
    expect(r).toMatchObject({ status: 'aborted', rounds: 0 })
    expect(h.seen).toHaveLength(0)
    expect(h.lines().at(-1)).toBe('[W] 已中止（还没开始请求），编辑器内容未改动')
  })
})
