import { describe, expect, it } from 'vitest'
import {
  TRUNCATION_RETRY_TEXT,
  appendToolRound,
  appendTruncationRetry,
  buildAssistantContent,
  buildOpenAIAssistant,
  userMessage,
  withTailInjection,
} from '../../src/main/llm/messages'
import type { ChatMessage, ChatResult } from '../../src/main/llm/types'

const result = (over: Partial<ChatResult> = {}): ChatResult => ({
  text: '',
  pendingCalls: [],
  stopReason: 'tool_use',
  usage: { inputTokens: 0, outputTokens: 0 },
  ...over,
})

describe('userMessage', () => {
  it('Claude 用 text 块，OpenAI 用字符串', () => {
    expect(userMessage('claude', 'hi')).toEqual({ role: 'user', content: [{ type: 'text', text: 'hi' }] })
    expect(userMessage('openai', 'hi')).toEqual({ role: 'user', content: 'hi' })
  })
})

describe('withTailInjection', () => {
  it('空文本原样返回同一个数组', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'x' }]
    expect(withTailInjection(msgs, '  ', 'claude')).toBe(msgs)
  })

  it('OpenAI：末尾追加一条 system', () => {
    const out = withTailInjection([{ role: 'user', content: 'x' }], 'TAIL', 'openai')
    expect(out[out.length - 1]).toEqual({ role: 'system', content: 'TAIL' })
  })

  it('Claude：追加到最后一条 user 的 content 末尾，字符串 content 先展开成块；不改动原数组', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'x' }]
    const out = withTailInjection(msgs, 'TAIL', 'claude')
    expect(out).toEqual([{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'text', text: 'TAIL' }] }])
    expect(msgs).toEqual([{ role: 'user', content: 'x' }])
  })

  it('Claude：tool_result 块之后追加；最后一条不是 user 时新起一条', () => {
    const tr = { type: 'tool_result', tool_use_id: 'a', content: 'r' }
    const out = withTailInjection([{ role: 'user', content: [tr] }], 'TAIL', 'claude')
    expect(out[0].content).toEqual([tr, { type: 'text', text: 'TAIL' }])
    const out2 = withTailInjection([{ role: 'assistant', content: 'y' }], 'TAIL', 'claude')
    expect(out2[1]).toEqual({ role: 'user', content: [{ type: 'text', text: 'TAIL' }] })
  })
})

describe('buildAssistantContent', () => {
  it('有原始块时原样回传，只把 tool_use 的 input 换成清洗后的参数', () => {
    const thinking = { type: 'thinking', thinking: '...', signature: 'SIG' }
    const raw = [thinking, { type: 'tool_use', id: 't1', name: 'search_tags', input: { concepts: '&lt;x&gt;' } }]
    const out = buildAssistantContent(
      result({ rawContent: raw, pendingCalls: [{ id: 't1', name: 'search_tags', args: { concepts: '<x>' } }] }),
    )
    expect(out[0]).toBe(thinking)
    expect(out[1]).toEqual({ type: 'tool_use', id: 't1', name: 'search_tags', input: { concepts: '<x>' } })
  })

  it('没有原始块时按文本与调用重建', () => {
    expect(
      buildAssistantContent(result({ text: 'hi', pendingCalls: [{ id: 't', name: 'n', args: { a: 1 } }] })),
    ).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'tool_use', id: 't', name: 'n', input: { a: 1 } },
    ])
  })
})

describe('buildOpenAIAssistant', () => {
  it('参数用清洗后的版本序列化；正文、reasoning_content、reasoning_details、tool_calls 的 extra_content 原样带回', () => {
    const msg = buildOpenAIAssistant(
      result({
        rawMessage: {
          role: 'assistant',
          content: '想一下',
          reasoning_content: 'R',
          reasoning: 'R',
          reasoning_details: [{ type: 'reasoning.text', text: 'R' }],
          annotations: [],
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'search_tags', arguments: '{"concepts":["&lt;x&gt;"]}' },
              extra_content: { google: { thought_signature: 'SIG' } },
            },
          ],
        },
        pendingCalls: [{ id: 'c1', name: 'search_tags', args: { concepts: ['<x>'] } }],
      }),
    )
    // 明文 reasoning 与 annotations 不带回
    expect(msg).toEqual({
      role: 'assistant',
      content: '想一下',
      reasoning_content: 'R',
      reasoning_details: [{ type: 'reasoning.text', text: 'R' }],
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'search_tags', arguments: '{"concepts":["<x>"]}' },
          extra_content: { google: { thought_signature: 'SIG' } },
        },
      ],
    })
  })

  it('没有正文时 content 为 null，没有推理字段时不带', () => {
    const msg = buildOpenAIAssistant(result({ pendingCalls: [] }))
    expect(msg).toEqual({ role: 'assistant', content: null, tool_calls: [] })
  })
})

describe('appendToolRound', () => {
  const r = result({ pendingCalls: [{ id: 'a', name: 'search_tags', args: {} }] })

  it('Claude：assistant 一条 + user 一条（全部 tool_result）', () => {
    const msgs: ChatMessage[] = []
    appendToolRound(msgs, 'claude', r, [{ id: 'a', content: '结果' }])
    expect(msgs[1]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '结果' }] })
    expect(msgs[0].role).toBe('assistant')
  })

  it('OpenAI：assistant 一条 + 每个结果一条 tool', () => {
    const msgs: ChatMessage[] = []
    appendToolRound(msgs, 'openai', r, [{ id: 'a', content: '结果' }])
    expect(msgs[1]).toEqual({ role: 'tool', tool_call_id: 'a', content: '结果' })
  })
})

describe('appendTruncationRetry', () => {
  it('有文本时先回放 assistant 文本，再追加续接提示', () => {
    const msgs: ChatMessage[] = []
    appendTruncationRetry(msgs, result({ text: '写到一半' }))
    expect(msgs).toEqual([
      { role: 'assistant', content: '写到一半' },
      { role: 'user', content: TRUNCATION_RETRY_TEXT },
    ])
  })

  it('没有文本时只追加续接提示', () => {
    const msgs: ChatMessage[] = []
    appendTruncationRetry(msgs, result())
    expect(msgs).toEqual([{ role: 'user', content: TRUNCATION_RETRY_TEXT }])
  })
})
