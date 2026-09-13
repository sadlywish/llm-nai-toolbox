import { describe, expect, it } from 'vitest'
import { defaultAppConfig, type AppConfig } from '../../src/shared/config'
import type { LlmLogLine } from '../../src/shared/llm'
import { RunLog } from '../../src/main/llm/log'
import { createOpenAIChat, parseToolArguments } from '../../src/main/llm/openai'
import type { ChatFn, ChatMessage, FetchLike, JsonObject, ToolDefinition } from '../../src/main/llm/types'

const tool: ToolDefinition = { name: 'search_tags', description: 'd', inputSchema: { type: 'object' } }
const reply = (message: JsonObject, finish = 'tool_calls') => ({
  choices: [{ message, finish_reason: finish }],
  usage: { prompt_tokens: 50, completion_tokens: 5 },
})
const ok = { status: 200, body: reply({ role: 'assistant', content: 'hi' }, 'stop') }
const REASONING_KEYS = ['reasoning_effort', 'reasoning', 'thinking', 'enable_thinking', 'thinking_budget']

function harness(
  responses: Array<{ status: number; body: unknown }>,
  over: Partial<AppConfig> = {},
  messages: ChatMessage[] = [{ role: 'user', content: '画初音' }],
) {
  const bodies: JsonObject[] = []
  const urls: string[] = []
  const headers: Array<Record<string, string>> = []
  const fetchFn: FetchLike = async (url, init) => {
    urls.push(url)
    headers.push(init.headers as Record<string, string>)
    bodies.push(JSON.parse(String(init.body)) as JsonObject)
    const r = responses[bodies.length - 1]
    return new Response(JSON.stringify(r.body), { status: r.status })
  }
  const lines: LlmLogLine[] = []
  const config: AppConfig = { ...defaultAppConfig(), apiType: 'openai', apiBaseUrl: 'https://oai.example.com', ...over }
  const chat: ChatFn = createOpenAIChat(fetchFn, 1)
  const call = () =>
    chat({ config, apiKey: 'sk-o', system: 'SYS', messages, tools: [tool], signal: new AbortController().signal, log: new RunLog((l) => lines.push(l)) })
  return { call, bodies, urls, headers, lines }
}

describe('createOpenAIChat：请求体', () => {
  it('system 在最前、function 工具、max_tokens、Bearer 头、/v1/chat/completions；思维链关闭时不带任何思维链参数', async () => {
    const h = harness([ok])
    await h.call()
    expect(h.urls[0]).toBe('https://oai.example.com/v1/chat/completions')
    expect(h.headers[0].Authorization).toBe('Bearer sk-o')
    expect((h.bodies[0].messages as ChatMessage[])[0]).toEqual({ role: 'system', content: 'SYS' })
    expect(h.bodies[0].tools).toEqual([{ type: 'function', function: { name: 'search_tags', description: 'd', parameters: { type: 'object' } } }])
    expect(h.bodies[0].max_tokens).toBe(16000)
    for (const k of REASONING_KEYS) expect(k in h.bodies[0]).toBe(false)
  })

  it('尾部注入：末尾一条 system', async () => {
    const h = harness([ok], { tailInjectionEnabled: true, tailInjection: 'TAIL' })
    await h.call()
    expect((h.bodies[0].messages as ChatMessage[]).at(-1)).toEqual({ role: 'system', content: 'TAIL' })
  })

  it('思维链按设置里的写法发送', async () => {
    const h = harness([ok], { thinkingEnabled: true, openaiReasoningDialect: 'thinking_object' })
    await h.call()
    expect(h.bodies[0].thinking).toEqual({ type: 'enabled' })
  })

  it('附加请求参数合并进请求体，同名字段以它为准；给了 max_completion_tokens 就不再发 max_tokens', async () => {
    const h = harness([ok], {
      thinkingEnabled: true,
      openaiExtraParams: '{"top_p": 0.9, "reasoning_effort": "max", "max_completion_tokens": 999}',
    })
    await h.call()
    expect(h.bodies[0].top_p).toBe(0.9)
    expect(h.bodies[0].reasoning_effort).toBe('max')
    expect(h.bodies[0].max_completion_tokens).toBe(999)
    expect('max_tokens' in h.bodies[0]).toBe(false)
  })
})

describe('createOpenAIChat：被拒后的自动退让', () => {
  it('端点不认思维链参数：去掉重发并告警；同一轮之后不再发', async () => {
    const h = harness(
      [{ status: 400, body: { error: { message: 'Unrecognized request argument supplied: reasoning_effort' } } }, ok, ok],
      { thinkingEnabled: true },
    )
    await h.call()
    expect(h.bodies[0].reasoning_effort).toBe('high')
    expect('reasoning_effort' in h.bodies[1]).toBe(false)
    expect(h.lines.some((l) => l.level === 'W' && l.text.includes('端点不认思维链参数'))).toBe(true)
    await h.call()
    expect('reasoning_effort' in h.bodies[2]).toBe(false)
  })

  it('max_tokens 被拒（OpenAI 官方推理模型）：改发 max_completion_tokens，同一轮之后保持', async () => {
    const msg = "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."
    const h = harness([{ status: 400, body: { error: { message: msg } } }, ok, ok])
    await h.call()
    expect(h.bodies[1].max_completion_tokens).toBe(16000)
    expect('max_tokens' in h.bodies[1]).toBe(false)
    expect(h.lines.some((l) => l.level === 'W' && l.text.includes('max_completion_tokens'))).toBe(true)
    await h.call()
    expect('max_tokens' in h.bodies[2]).toBe(false)
  })

  it('带回去的推理字段被拒：从历史里剥掉 reasoning_content、reasoning_details 与 extra_content 再发', async () => {
    const history: ChatMessage[] = [
      { role: 'user', content: '画初音' },
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'R',
        reasoning_details: [{ type: 'reasoning.text', text: 'R' }],
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_tags', arguments: '{}' }, extra_content: { google: {} } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'r' },
    ]
    const h = harness([{ status: 400, body: { error: { message: "Extra inputs are not permitted: messages[1].reasoning_content" } } }, ok], {}, history)
    await h.call()
    const assistant = (h.bodies[1].messages as ChatMessage[])[2]
    expect(assistant).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_tags', arguments: '{}' } }],
    })
    expect(history[1].reasoning_content).toBe('R')
  })

  it('其余 400 不重发', async () => {
    const h = harness([{ status: 400, body: { error: { message: 'bad tools' } } }], { thinkingEnabled: true })
    await expect(h.call()).rejects.toThrow('400 bad tools')
    expect(h.bodies).toHaveLength(1)
  })
})

describe('createOpenAIChat：解析', () => {
  it('工具参数清洗、原始 message 保留、用量与停止原因', async () => {
    const message = {
      role: 'assistant',
      content: null,
      reasoning_content: 'R',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_tags', arguments: '{"concepts":["&lt;俯视&gt;"]}' } }],
    }
    const h = harness([{ status: 200, body: reply(message) }])
    const r = await h.call()
    expect(r.pendingCalls).toEqual([{ id: 'c1', name: 'search_tags', args: { concepts: ['<俯视>'] } }])
    expect(r.rawMessage?.reasoning_content).toBe('R')
    expect(r.usage).toEqual({ inputTokens: 50, outputTokens: 5 })
    expect(r.stopReason).toBe('tool_calls')
  })

  it('开着思维链时记一行推理内容长度（reasoning_content 或 reasoning 字段）', async () => {
    const h = harness([{ status: 200, body: reply({ role: 'assistant', content: 'x', reasoning: 'abc' }, 'stop') }], { thinkingEnabled: true })
    await h.call()
    expect(h.lines.some((l) => l.text === '[thinking] 本轮推理内容 3 字')).toBe(true)
  })

  it('工具参数实在救不回来：抛错说明是哪个工具', async () => {
    const message = { role: 'assistant', tool_calls: [{ id: 'c', function: { name: 'generate_image', arguments: 'nope' } }] }
    const h = harness([{ status: 200, body: reply(message) }])
    await expect(h.call()).rejects.toThrow('模型给 generate_image 的参数不是合法 JSON')
  })

  it('没有 choices：抛错说明', async () => {
    const h = harness([{ status: 200, body: { foo: 1 } }])
    await expect(h.call()).rejects.toThrow('OpenAI 接口返回的格式不对')
  })
})

describe('parseToolArguments', () => {
  it('字符串 JSON、对象、空串、截断的 JSON、坏的', () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 })
    expect(parseToolArguments({ a: 1 })).toEqual({ a: 1 })
    expect(parseToolArguments('')).toEqual({})
    expect(parseToolArguments('{"tags":"smile')).toEqual({ tags: 'smile' })
    expect(parseToolArguments('[1,2]')).toBeNull()
    expect(parseToolArguments(3)).toBeNull()
  })
})
