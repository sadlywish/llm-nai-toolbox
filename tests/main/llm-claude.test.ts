import { describe, expect, it } from 'vitest'
import { defaultAppConfig, type AppConfig } from '../../src/shared/config'
import type { LlmLogLine } from '../../src/shared/llm'
import { createClaudeChat } from '../../src/main/llm/claude'
import { RunLog } from '../../src/main/llm/log'
import type { ChatMessage, FetchLike, JsonObject, ToolDefinition } from '../../src/main/llm/types'

const tool: ToolDefinition = { name: 'search_tags', description: 'd', inputSchema: { type: 'object' } }

function harness(response: unknown, over: Partial<AppConfig> = {}) {
  const bodies: JsonObject[] = []
  const urls: string[] = []
  const headers: Array<Record<string, string>> = []
  const fetchFn: FetchLike = async (url, init) => {
    urls.push(url)
    headers.push(init.headers as Record<string, string>)
    bodies.push(JSON.parse(String(init.body)) as JsonObject)
    return new Response(JSON.stringify(response), { status: 200 })
  }
  const lines: LlmLogLine[] = []
  const config: AppConfig = { ...defaultAppConfig(), apiBaseUrl: 'https://api.example.com/ ', ...over }
  const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: '画初音' }] }]
  const call = (system = 'SYS') =>
    createClaudeChat(fetchFn, 1)({
      config,
      apiKey: 'sk-test',
      system,
      messages,
      tools: [tool],
      signal: new AbortController().signal,
      log: new RunLog((l) => lines.push(l)),
    })
  return { call, bodies, urls, headers, lines, messages }
}

const okResponse = {
  content: [
    { type: 'thinking', thinking: '...', signature: 'SIG' },
    { type: 'text', text: '先查一下' },
    { type: 'tool_use', id: 't1', name: 'search_tags', input: { concepts: ['&lt;俯视&gt;'] } },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 120, output_tokens: 30 },
}

describe('createClaudeChat', () => {
  it('请求：地址去掉尾部斜杠与空白；头带 Key 与版本；工具转 input_schema；思维链关闭时不带 thinking', async () => {
    const h = harness(okResponse)
    await h.call()
    expect(h.urls[0]).toBe('https://api.example.com/v1/messages')
    expect(h.headers[0]['x-api-key']).toBe('sk-test')
    expect(h.headers[0]['anthropic-version']).toBe('2023-06-01')
    expect(h.bodies[0].tools).toEqual([{ name: 'search_tags', description: 'd', input_schema: { type: 'object' } }])
    expect(h.bodies[0].system).toBe('SYS')
    expect('thinking' in h.bodies[0]).toBe(false)
    expect(h.bodies[0].max_tokens).toBe(16000)
  })

  it('系统提示词为空时不发 system 字段', async () => {
    const h = harness(okResponse)
    await h.call('  ')
    expect('system' in h.bodies[0]).toBe(false)
  })

  it('尾部注入：追加到发出去的最后一条 user，调用方的数组不被改动', async () => {
    const h = harness(okResponse, { tailInjectionEnabled: true, tailInjection: 'TAIL' })
    await h.call()
    const sent = h.bodies[0].messages as ChatMessage[]
    expect((sent[0].content as JsonObject[]).at(-1)).toEqual({ type: 'text', text: 'TAIL' })
    expect(h.messages[0].content).toEqual([{ type: 'text', text: '画初音' }])
    expect(h.lines.some((l) => l.text === '[尾部注入] 已注入 4 字符到上下文末尾')).toBe(true)
  })

  it('解析：文本拼接、工具参数清洗、原始块原样保留、用量与停止原因', async () => {
    const h = harness(okResponse)
    const r = await h.call()
    expect(r.text).toBe('先查一下')
    expect(r.pendingCalls).toEqual([{ id: 't1', name: 'search_tags', args: { concepts: ['<俯视>'] } }])
    expect(r.rawContent?.[0]).toEqual({ type: 'thinking', thinking: '...', signature: 'SIG' })
    expect(r.usage).toEqual({ inputTokens: 120, outputTokens: 30 })
    expect(r.stopReason).toBe('tool_use')
  })

  it('参数修复的说明写成 W 日志', async () => {
    const h = harness({
      content: [{ type: 'tool_use', id: 't', name: 'generate_image', input: { nltags: 'a</nltags><parameter name="quality">q' } }],
      stop_reason: 'tool_use',
    })
    const r = await h.call()
    expect(r.pendingCalls[0].args).toEqual({ nltags: 'a', quality: 'q' })
    expect(h.lines.some((l) => l.level === 'W' && l.text.startsWith('[参数修复] generate_image: nltags'))).toBe(true)
  })

  it('开了思维链却没有 thinking 块：W 提醒', async () => {
    const h = harness({ content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' }, { thinkingEnabled: true })
    await h.call()
    expect(h.lines.some((l) => l.level === 'W' && l.text.includes('响应中没有 thinking 块'))).toBe(true)
  })

  it('响应格式不对：抛错说明', async () => {
    const h = harness({ foo: 1 })
    await expect(h.call()).rejects.toThrow('Claude 接口返回的格式不对')
  })
})
