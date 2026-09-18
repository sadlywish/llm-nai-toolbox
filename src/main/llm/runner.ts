import type { AppConfig } from '@shared/config'
import type { LlmEvent, LlmRunInput, LlmRunResult } from '@shared/llm'
import { formatToc } from '../tagdb/browse'
import { buildInjectionBlock } from '../tagdb/gloss'
import { formatArgsForEdit } from './args'
import type { TagData } from './data'
import { postProcess } from './fill'
import { LlmHttpError, LlmTimeoutError, errorMessage } from './http'
import { RunLog } from './log'
import { appendToolRound, appendTruncationRetry, userMessage, type ToolOutput } from './messages'
import { buildSystemPrompt, buildUserPrompt, effectiveMultiCharacter, resolveStyleLock, workspaceToEditArgs } from './prompt'
import { manualTopicCount } from './resources'
import { executeBrowse, executeLoadManual, executeSearchTags } from './toolExec'
import { GENERATE_CHARACTERS_TOOL_NAME, SEARCH_TOOL_NAMES, isGenerateTool, selectRoundTools } from './tools'
import type { ChatFn, ChatMessage, ChatResult } from './types'

/**
 * 一轮 LLM 交互（规格 §9.1）。插件 index.ts 第 2068–2564 行的主流程，循环只写这一份（规格 §4.1）。
 *
 * 依赖全部注入：端点、标签数据、随包资源、中止信号、事件出口。IPC 层（main/ipc.ts）负责接线，
 * 这里不 import electron，因此能在 node 环境里把整轮流程跑一遍。
 */
export interface RunnerDeps {
  config: AppConfig
  apiKey: string
  chat: ChatFn
  /** 一轮开始前备齐标签数据（生产环境是 prepareTagData） */
  prepareData: (log: RunLog) => Promise<TagData>
  manuals: ReadonlyMap<string, string>
  manualToc: string
  skillCore: string
  signal: AbortSignal
  emit: (event: LlmEvent) => void
  /** 计时用，测试可注入 */
  now?: () => number
  /** 日志时间戳用，测试可注入 */
  clock?: () => Date
}

class RunAborted extends Error {}

/** 失败原因 → 日志的两行：接口原文，以及用户下一步该做什么 */
function describeFailure(e: unknown, config: AppConfig): { summary: string; advice: string } {
  if (e instanceof LlmHttpError) {
    const summary = e.message
    if (e.status === 401 || e.status === 403) return { summary, advice: 'API Key 无效或已过期，去「设置 → LLM API」重新填写。' }
    if (e.status === 404) return { summary, advice: '接口地址或模型名不对，检查「设置 → LLM API」的 API 地址与模型。' }
    if (e.status === 429) return { summary, advice: '请求太频繁或额度用完了，稍后再试。' }
    if (e.status === 400) {
      return {
        summary,
        advice: config.thinkingEnabled
          ? '请求被接口拒绝，原因见上一行；开着思维链的话，也可能是模型不支持当前的思维链格式。'
          : '请求被接口拒绝，原因见上一行。',
      }
    }
    if (e.status >= 500) return { summary, advice: '接口服务端出错，重试 3 次仍失败，稍后再试。' }
    return { summary, advice: '' }
  }
  if (e instanceof LlmTimeoutError) {
    return { summary: e.message, advice: '检查网络与代理，或在「设置 → LLM API」调大请求超时。' }
  }
  const summary = errorMessage(e)
  return { summary, advice: /fetch failed|network|ERR_|ECONN|ENOTFOUND/i.test(summary) ? '网络请求没有成功，检查网络与代理设置。' : '' }
}

export async function runLlm(input: LlmRunInput, deps: RunnerDeps): Promise<LlmRunResult> {
  const now = deps.now ?? Date.now
  const started = now()
  const elapsed = (): number => now() - started
  const { config, signal } = deps
  const log = new RunLog((line) => deps.emit({ kind: 'log', line }), deps.clock)
  let rounds = 0
  /** 失败发生在请求里还是本地处理里，决定日志写「第 N 轮请求失败」还是「处理失败」 */
  let requesting = false
  const checkAbort = (): void => {
    if (signal.aborted) throw new RunAborted()
  }

  try {
    if (!deps.apiKey.trim()) {
      log.error('还没有填写 API Key，去「设置 → LLM API」填写。编辑器内容未改动')
      return { status: 'failed', rounds, elapsedMs: elapsed(), message: '还没有填写 API Key' }
    }
    const instruction = input.instruction.trim()
    if (!instruction) {
      log.error('指令是空的，编辑器内容未改动')
      return { status: 'failed', rounds, elapsedMs: elapsed(), message: '指令是空的' }
    }

    const data = await deps.prepareData(log)
    checkAbort()

    const multi = effectiveMultiCharacter(input, log)
    const lockedStyle = resolveStyleLock(input.style, input.workspace, log)
    const manualEnabled = config.tagManualEnabled && manualTopicCount(deps.manuals) > 0
    if (config.tagManualEnabled && !manualEnabled) log.warn('load_tag_manual 已从工具集摘掉：随包的标签手册是空的')
    const browse = data.browse !== null && data.browse.cats.size > 0 ? data.browse : null
    const available = {
      searchTags: data.categories !== null,
      browse: browse !== null,
      manual: manualEnabled,
    }

    const system = buildSystemPrompt({
      config,
      multi,
      editExisting: input.editExisting,
      skillCore: deps.skillCore,
      manualToc: manualEnabled ? deps.manualToc : null,
      browseToc: browse !== null ? formatToc(browse) : '',
    })
    log.info(`系统提示词共 ${system.length} 字符`)

    let existingParams: string | null = null
    if (input.editExisting) {
      const editArgs = workspaceToEditArgs(input.workspace, multi !== 'off')
      existingParams = formatArgsForEdit(editArgs, config.promptOrder)
      log.info(`[修改模式] 载入现有参数: ${Object.keys(editArgs).join(', ')}`)
    }
    // 层 1：扫描输入中的标签，把「字面会读错的」释义注入上下文。修改模式扫 <现有参数>，否则扫指令本身
    const injection =
      data.gloss !== null || data.deprecated !== null
        ? buildInjectionBlock(existingParams || instruction, data.gloss ?? new Map(), data.deprecated ?? new Map())
        : null
    if (injection) log.info(`[tag-inject] 注入 ${(injection.match(/^- /gm) ?? []).length} 条标签释义`)

    const user = buildUserPrompt({ instruction, config, existingParams, injection })
    log.info(`LLM 请求正文:\n${user}`)

    const messages: ChatMessage[] = [userMessage(config.apiType, user)]
    const maxRounds = config.maxToolRounds
    let result: ChatResult = { text: '', pendingCalls: [], stopReason: '', usage: { inputTokens: 0, outputTokens: 0 } }
    let skipSearch = false
    let totalIn = 0
    let totalOut = 0
    let totalQueries = 0
    let totalBrowses = 0

    for (let round = 0; round < maxRounds; round++) {
      checkAbort()
      rounds = round + 1
      deps.emit({ kind: 'round', round: rounds, maxRounds })
      const tools = selectRoundTools({ round, maxRounds, skipSearch, multi: multi !== 'off', promptOrder: config.promptOrder, available })
      log.info(`本轮工具集: ${tools.map((t) => t.name).join(', ')}`)

      requesting = true
      result = await deps.chat({ config, apiKey: deps.apiKey, system, messages, tools, signal, log })
      requesting = false
      checkAbort()

      totalIn += result.usage.inputTokens
      totalOut += result.usage.outputTokens
      log.info(`Token 累计: 第${round + 1}轮 ${result.usage.inputTokens}in/${result.usage.outputTokens}out, 总计 ${totalIn}in/${totalOut}out`)

      // 凡是「需要把结果喂回给 LLM 再往下走」的工具都必须在 SEARCH_TOOL_NAMES 里——漏一个，那个工具就永远不会被执行
      const searchCalls = result.pendingCalls.filter((c) => SEARCH_TOOL_NAMES.has(c.name))
      if (searchCalls.length === 0 && round > 0) {
        log.info(`[查询覆盖] 第${round + 1}轮 LLM 停止检索，累计 ${totalQueries} 个查询词、${totalBrowses} 次分类浏览`)
      }

      // 截断：想调用工具但响应被 max_tokens 截断
      if ((result.stopReason === 'max_tokens' || result.stopReason === 'length') && result.pendingCalls.length === 0) {
        log.warn(`第 ${round + 1} 轮响应被截断 (${result.stopReason})，追加续接提示`)
        appendTruncationRetry(messages, result)
        continue
      }
      if (searchCalls.length === 0) break

      log.info(`多轮 tool_use: 第 ${round + 1} 轮，${searchCalls.length} 个搜索调用`)
      // 初值取决于本轮是否真的有 search_tags：只调了 browse_tags 的轮次不该被判成「全部高置信」
      let allHigh = result.pendingCalls.some((c) => c.name === 'search_tags')
      const outputs: ToolOutput[] = []
      for (const pc of result.pendingCalls) {
        let content: string
        switch (pc.name) {
          case 'search_tags': {
            const o = executeSearchTags(pc.args, data, config, log)
            totalQueries += o.queryCount
            if (!o.allHigh) allHigh = false
            content = o.text
            break
          }
          case 'browse_tags':
            totalBrowses++
            content = executeBrowse(pc.args, data, config, log)
            break
          case 'load_tag_manual':
            content = executeLoadManual(pc.args, deps.manuals, manualEnabled, log)
            break
          default:
            content = '请先完成标签查询后再调用此工具。'
        }
        outputs.push({ id: pc.id, content })
      }
      appendToolRound(messages, config.apiType, result, outputs)

      if (config.autoSkipSearch && allHigh) {
        log.info('所有搜索结果高置信度 (≥0.85)，下一轮禁用 search_tags')
        skipSearch = true
      }
    }

    const finalCalls = result.pendingCalls.filter((c) => !SEARCH_TOOL_NAMES.has(c.name))
    log.info(`LLM 全部轮次完成, 总消耗 token: ${totalIn} input + ${totalOut} output = ${totalIn + totalOut} total`)

    const generateCalls = finalCalls.filter((c) => isGenerateTool(c.name))
    if (generateCalls.length === 0) {
      const others = finalCalls.map((c) => c.name)
      if (others.length > 0) log.warn(`模型调用了没有提供的工具: ${others.join(', ')}`)
      log.warn(`AI 未调用生成工具，文本回复: ${result.text.trim() || '(空)'}`)
      log.warn('模型没有给出参数，编辑器内容未改动')
      return { status: 'noParams', rounds, elapsedMs: elapsed() }
    }
    for (const extra of generateCalls.slice(1)) log.info(`跳过多余的 ${extra.name} 调用（仅执行第一个）`)

    checkAbort()
    const gen = generateCalls[0]
    const fill = postProcess(gen.args, {
      config,
      lockedStyle,
      multi,
      transparent: input.transparent,
      withCharacters: gen.name === GENERATE_CHARACTERS_TOOL_NAME,
      log,
    })
    return { status: 'filled', fill, rounds, elapsedMs: elapsed() }
  } catch (e) {
    if (signal.aborted) {
      log.warn(rounds > 0 ? `已中止（第 ${rounds} 轮），编辑器内容未改动` : '已中止（还没开始请求），编辑器内容未改动')
      return { status: 'aborted', rounds, elapsedMs: elapsed() }
    }
    const { summary, advice } = describeFailure(e, config)
    log.error(requesting ? `第 ${rounds} 轮请求失败: ${summary}` : `处理失败: ${summary}`)
    log.error(`${advice}编辑器内容未改动`)
    return { status: 'failed', rounds, elapsedMs: elapsed(), message: summary }
  }
}
