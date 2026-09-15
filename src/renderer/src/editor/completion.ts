import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import type { Extension } from '@codemirror/state'
import { completionTargetAt, type CompletionTarget } from '@shared/blockCompletion'
import type { FieldSpec } from '@shared/fields'
import type { CompletionItem } from '@shared/ipc'
import { formatCount } from '../format'

/** 编辑器补全里按中文释义补充的最多条数（界面稿 2026-09-15-magicbook-mockup.html 第六节） */
export const EDITOR_GLOSS_MAX = 10

export interface TagCompletionOption extends Completion {
  /** 工具附带的中文释义，渲染在标签名后面 */
  gloss?: string
  /** 按释义补充进来的行，行尾标「释义」 */
  byGloss?: boolean
}

export function toCompletionOptions(items: CompletionItem[]): TagCompletionOption[] {
  return items.map((item) => {
    const option: TagCompletionOption = {
      label: item.tag,
      detail: formatCount(item.count),
      info: [item.zh.join(' / '), item.series.length ? `作品：${item.series.join(', ')}` : '']
        .filter(Boolean)
        .join('　') || undefined,
      apply: item.tag,
    }
    if (item.gloss !== undefined) option.gloss = item.gloss
    if (item.byGloss) option.byGloss = true
    return option
  })
}

/**
 * 标签名后面的释义与「释义」标记；没有释义的行不加节点。
 * addToOptions 只收一个节点，所以外面包一层：截断挂在里层释义上，「释义」标记不会被一起截掉。
 */
export function renderGloss(completion: Completion): Node | null {
  const { gloss, byGloss } = completion as TagCompletionOption
  if (gloss === undefined) return null
  const wrap = document.createElement('span')
  wrap.className = 'cm-completionGlossWrap'
  const text = document.createElement('span')
  text.className = 'cm-completionGloss'
  text.textContent = gloss
  wrap.appendChild(text)
  if (byGloss) {
    const by = document.createElement('span')
    by.className = 'cm-completionBy'
    by.textContent = '释义'
    wrap.appendChild(by)
  }
  return wrap
}

/** 规格 §10.4 给的防抖。与「跟随光标」的 400ms 不是一回事 */
export const COMPLETION_DEBOUNCE_MS = 250

/**
 * 把一个 async 查询函数包成「安静 250ms 才真发」。
 *
 * CodeMirror 自己的节流约 50ms，远达不到规格要的 250ms —— 打字时每敲一个
 * 字符都要往主进程发一次查询，而每次查询要在几十万条目上跑相似度。
 *
 * 被后续按键取代的那一次 resolve(null)，不是 reject：CodeMirror 会把
 * reject 当成补全源出错并在控制台刷报错。
 */
function debounced<T>(fn: (arg: T) => Promise<CompletionResult | null>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let discardPrevious: (() => void) | null = null
  return (arg: T): Promise<CompletionResult | null> =>
    new Promise((resolve) => {
      if (timer !== null) clearTimeout(timer)
      if (discardPrevious !== null) discardPrevious()
      discardPrevious = () => resolve(null)
      timer = setTimeout(() => {
        timer = null
        discardPrevious = null
        void fn(arg).then(resolve, () => resolve(null))
      }, ms)
    })
}

/**
 * 本地标签补全。
 *
 * 查询走 IPC 到主进程的本地标签库，**不请求 Danbooru** —— 渲染进程不发外部
 * HTTP 是本工程的硬约束，而且补全是打字过程中的高频操作，走网络体验不可接受。
 *
 * 补全哪个词、偏好哪一类由调用方给的 resolveTarget 算：分块编辑器用
 * completionTargetAt（负责段内坐标换算），单字段编辑器用 completionTargetInText。
 */
export function tagCompletion(
  resolveTarget: (doc: string, pos: number) => CompletionTarget | null,
): Extension {
  async function source(ctx: CompletionContext): Promise<CompletionResult | null> {
    const target = resolveTarget(ctx.state.doc.toString(), ctx.pos)
    if (target === null) return null
    const res = await window.api.tagdbComplete({
      query: target.query,
      prefer: target.prefer,
      glossMax: EDITOR_GLOSS_MAX,
    })
    if (!res.ok || res.items.length === 0) return null

    return {
      from: target.from,
      to: target.to,
      options: toCompletionOptions(res.items),
      // 主进程已按图数排好序，**必须**关掉 CodeMirror 自己的过滤：这是词首
      // 匹配，打的字不一定是 label 的前缀（打 hair 会命中 long_hair），
      // 默认的模糊过滤会把这类候选直接筛掉或乱序。释义补充行更是和 label 毫无字面关系
      filter: false,
    }
  }

  const debouncedSource = debounced<CompletionContext>(source, COMPLETION_DEBOUNCE_MS)

  return autocompletion({
    override: [debouncedSource],
    activateOnTyping: true,
    closeOnBlur: true,
    // 候选集全量返回（单字符查询实测最多约 1.8 万条），但只为可见的这些建
    // DOM —— 结果集大小与渲染量是两件事，压力挡在这里而不是在查询层截断
    maxRenderedOptions: 50,
    // 释义排在标签名（position 50）之后、帖子数（80）之前
    addToOptions: [{ render: renderGloss, position: 60 }],
  })
}

/** 分块编辑器的补全：按光标所在段与字段的补全偏好取词 */
export function localTagCompletion(specs: readonly FieldSpec[]): Extension {
  return tagCompletion((doc, pos) => completionTargetAt(doc, specs, pos))
}
