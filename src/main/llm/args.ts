import { parseFieldOrder } from '@shared/fields'
import type { CharacterQuery } from '@shared/tagdb/search'
import type { JsonObject } from './types'

/**
 * LLM 工具参数的结构性缺陷兜底。从插件 utils.ts 搬运（行号见各函数注释）。
 *
 * 这些是提示词压不住、只能靠代码处理的问题（插件 docs/decisions.md「LLM 输出的结构性缺陷」）。
 * 统一在端点响应的入口处理（claude.ts / openai.ts），下游拿到的永远是修过的参数。
 * 插件用 any 写成，这里改成 unknown 逐项收窄；行为差异在注释里点明。
 */

export function isJsonObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 解码 HTML 实体（Claude 会把 `<lora:x>` 写成 `&lt;lora:x&gt;`）。插件第 61–74 行 */
export function decodeHtmlEntities(s: string): string {
  if (!s) return s
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&') // &amp; 放最后，避免 &amp;lt; → &lt; → <
}

function sanitizeValue(v: unknown): unknown {
  if (typeof v === 'string') return decodeHtmlEntities(v)
  if (Array.isArray(v)) return v.map(sanitizeValue)
  if (isJsonObject(v)) return sanitizeLlmArgs(v)
  return v
}

/**
 * 递归清理参数里的 HTML 实体。插件第 111–133 行。
 * 与插件的差别：数组元素里的数组按值递归。插件把数组元素统一交给对象分支，
 * 嵌套数组会被 Object.entries 转成 {"0":…} 这样的类数组对象。
 */
export function sanitizeLlmArgs(args: JsonObject): JsonObject {
  const result: JsonObject = {}
  for (const [key, val] of Object.entries(args)) result[key] = sanitizeValue(val)
  return result
}

export interface RepairResult {
  args: JsonObject
  notes: string[]
}

// ─── 参数泄漏还原（插件第 433–555 行） ────────────────────────
//
/**
 * 修复「工具调用参数漏进字符串值」的情况。
 *
 * 实测形状（来自 reforge_cache 的真实记录）：模型写到某个参数中途，从「发结构化参数」
 * 切换成了「写字面文本」，于是**它之后本该发的参数，连标记带值整段落进了当前参数的值里**：
 *
 *   nltags = "……纯白色的背景没有任何多余元素。</nltags>
 *             <parameter name=\"quality\">very aesthetic, masterpiece"
 *
 *   nltags = "……她的皮肤十分苍白。</nltags>
 *             <parameter name=\"characters\">[{\"count\":\"girl\",\"character\":\"…\"}]"
 *
 * 关键认识：**尾部不是垃圾，是完整且有效的参数数据**。逐字符核算过四条真实记录，
 * 尾部 = 闭合标记 + <parameter> 标记 + 参数值，未被任何参数覆盖的残余每条只有 1 个换行。
 * 那些参数根本没进 args，工具收到的是一个尾巴超长的 nltags，而它们对应的字段全空。
 *
 * 所以修法是**还原而不是清理**：把尾部解析回参数补进 args。删掉了事等于凭空丢掉
 * 一整组角色描述或整段负面词——实测被吞的正是 characters(644 字符) 这种最长的参数。
 * 开角色分区时高发也是同一个原因：characters 又长又复杂，且排在 nltags 之后。
 *
 * 只在 args 里该字段缺失或为空时才回填：已经作为真参数收到的值更可信。
 */

export function repairLeakedParams(args: JsonObject): RepairResult {
  const notes: string[] = []
  return { args: repairObject(args, notes, ''), notes }
}

/**
 * 对一层对象做还原，并递归进数组与嵌套对象。
 *
 * 递归是必需的：characters 是一个角色对象数组，**每个角色对象自己的字段一样会中招**。
 * 那时还原出来的参数属于该角色对象，不是顶层——把它提到顶层等于把某个角色的服装
 * 描述安到全图上。同理，哪个字段中招是不确定的：模型的参数顺序本就不固定，
 * 所以不能只盯 nltags，每个字符串字段都要过一遍。
 */
function repairObject(obj: JsonObject, notes: string[], path: string): JsonObject {
  const out: JsonObject = { ...obj }
  // <parameter name="x"> 或 </字段名>，谁先出现算谁
  const MARKER = /<parameter\s+name\s*=\s*["']([^"']+)["']\s*>|<\/([A-Za-z_][\w:-]*)>/

  for (const [key, val] of Object.entries(obj)) {
    // 这个键已经被前面某个字段尾部还原出来的参数填上了：别再用原值（多半是空数组/空串）把它盖回去。
    // 插件没有这一行——还原出的 characters 会被排在后面的原始 `characters: []` 覆盖，日志却写着已还原
    if (out[key] !== val) continue
    const here = path ? `${path}.${key}` : key
    // 先下探：数组元素与嵌套对象各自成一层，还原出的参数留在它自己那层
    if (Array.isArray(val)) {
      out[key] = val.map((item, i) => (isJsonObject(item) ? repairObject(item, notes, `${here}[${i}]`) : item))
      continue
    }
    if (isJsonObject(val)) {
      out[key] = repairObject(val, notes, here)
      continue
    }
    if (typeof val !== 'string') continue
    // 看着像 JSON 的值整段交给 repairJsonTextFields：里面的标记是 JSON 字符串内部的内容，
    // 按尾巴切会把 JSON 拦腰截断
    if (/^\s*[[{]/.test(val)) continue
    const m = MARKER.exec(val)
    if (!m) continue

    // 截断点之前是该字段的真实值
    const head = val.slice(0, m.index).trim()
    if (head) out[key] = head
    const tail = val.slice(m.index)
    const recovered = parseLeakedTail(tail)

    let filled = 0
    for (const [name, raw] of recovered) {
      if (name === key) continue
      const cur = out[name]
      // 已经作为真参数收到的值更可信，不覆盖
      if (cur !== undefined && cur !== null && cur !== '' && !(Array.isArray(cur) && cur.length === 0)) continue
      out[name] = coerceLeakedValue(raw)
      filled++
    }
    const detail = recovered.map(([n, v]) => `${n}(${v.length}字符)`).join(', ')
    notes.push(
      `${here} 尾部混入了后续参数的完整数据：正文 ${head.length} 字符，` +
        `尾部 ${tail.length} 字符已还原为 ${filled}/${recovered.length} 个参数` +
        (detail ? `（${detail}）` : '（未能解析出参数，原值保留）'),
    )
    // 一个参数都没解析出来时别动原值：宁可留着带标记的原文，也不能凭空删内容
    if (recovered.length === 0) out[key] = val
  }
  return out
}

/** 从尾巴里逐个抠出 <parameter name="x">值。值一直取到下一个标记或结尾。 */
function parseLeakedTail(tail: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const re = /<parameter\s+name\s*=\s*["']([^"']+)["']\s*>/g
  let m: RegExpExecArray | null
  const starts: Array<{ name: string; from: number }> = []
  while ((m = re.exec(tail)) !== null) starts.push({ name: m[1], from: m.index + m[0].length })
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? tail.lastIndexOf('<parameter', starts[i + 1].from) : tail.length
    let v = tail.slice(starts[i].from, end < 0 ? tail.length : end)
    // 参数块可能带自己的闭合标记
    v = v.replace(/<\/parameter\s*>\s*$/i, '').replace(/<\/[A-Za-z_][\w:-]*>\s*$/, '').trim()
    if (v) out.push([starts[i].name, v])
  }
  return out
}

/** 回收到的值是纯文本；看起来是 JSON 数组/对象就解析掉，否则原样。 */
function coerceLeakedValue(raw: string): unknown {
  const t = raw.trim()
  if (!/^[[{]/.test(t)) return raw
  try {
    return JSON.parse(t)
  } catch {
    // 被截断的 JSON（模型写到一半就停了）尽量补回收尾符号再试一次，
    // 失败就退回原始文本——宁可让后续兜底去处理，也不丢内容
    for (const suffix of ['"}]', '"}', '}]', '}', ']']) {
      try {
        return JSON.parse(t + suffix)
      } catch {
        /* 继续试 */
      }
    }
    return raw
  }
}

// ─── JSON 文本还原（插件第 558–659 行） ──────────────────────
//
/**
 * 修复「本该是结构化数组/对象、却以 JSON 文本形式塞进字符串字段」的情况。
 *
 * 实测：generate_image_characters 的 characters 收到的是一个 1181 字符的**字符串**，
 * 内容是 `[{"count":"girl","character":"robin (honkai: star rail)",…}]`。
 * 后端那句 `Array.isArray(args.characters) ? … : []` 于是把整组角色静默丢光——
 * 不报错、不告警，用户只看到"分区没生效"。
 *
 * 更麻烦的是这种 JSON 常常是坏的。实测那条在第 1100 字符处炸在
 * `\u7 effe`——模型在 `\uXXXX` 转义中间插了个空格。整段 parse 失败就等于
 * 一个角色都不剩，所以要能**逐个对象抢救**：坏掉一个不该连累其余。
 */

export function repairJsonTextFields(args: JsonObject): RepairResult {
  const notes: string[] = []
  return { args: repairJsonObject(args, notes, ''), notes }
}

function repairJsonObject(obj: JsonObject, notes: string[], path: string): JsonObject {
  const out: JsonObject = { ...obj }
  for (const [key, val] of Object.entries(obj)) {
    const here = path ? `${path}.${key}` : key
    if (Array.isArray(val)) {
      out[key] = val.map((item, i) => (isJsonObject(item) ? repairJsonObject(item, notes, `${here}[${i}]`) : item))
      continue
    }
    if (isJsonObject(val)) {
      out[key] = repairJsonObject(val, notes, here)
      continue
    }
    if (typeof val !== 'string') continue
    const t = val.trim()
    if (!/^[[{]/.test(t)) continue
    const parsed = parseJsonLoose(t)
    if (parsed === undefined) continue
    // 只认对象、或元素全是对象的数组。限死这一条是为了不误伤 NovelAI 的 [tag] 降权写法
    if (Array.isArray(parsed)) {
      if (!parsed.every((x) => typeof x === 'object' && x !== null)) continue
      out[key] = parsed.map((x, i) => (isJsonObject(x) ? repairJsonObject(x, notes, `${here}[${i}]`) : x))
      notes.push(`${here} 收到的是 JSON 文本而非结构化值，已解析为 ${parsed.length} 项数组`)
    } else if (isJsonObject(parsed)) {
      out[key] = repairJsonObject(parsed, notes, here)
      notes.push(`${here} 收到的是 JSON 文本而非结构化值，已解析为对象`)
    }
  }
  return out
}

/**
 * 尽力解析一段 JSON。整段失败时逐个抢救顶层元素，坏掉一个不连累其余。
 * 全都救不回来才返回 undefined（交给调用方保留原值，不丢内容）。
 */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim()
  try {
    return JSON.parse(t)
  } catch {
    /* 往下抢救 */
  }
  // 模型在 \uXXXX 中间插空格是实测见过的坏法，补一刀再试
  const unescaped = t.replace(/\\u([0-9a-fA-F]{1,3})\s+([0-9a-fA-F])/g, '\\u$1$2')
  if (unescaped !== t) {
    try {
      return JSON.parse(unescaped)
    } catch {
      /* 继续 */
    }
  }
  if (!t.startsWith('[')) {
    // 对象被截断：补回收尾括号试试
    for (const suffix of ['"}', '}', '"]}', ']}']) {
      try {
        return JSON.parse(t + suffix)
      } catch {
        /* 继续试 */
      }
    }
    return undefined
  }
  // 数组：切出每个顶层 {...} 单独解析，能救几个算几个
  const items: unknown[] = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < unescaped.length; i++) {
    const ch = unescaped[i]
    if (esc) {
      esc = false
      continue
    }
    if (ch === '\\') {
      esc = true
      continue
    }
    if (ch === '"') {
      inStr = !inStr
      continue
    }
    if (inStr) continue
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        const piece = unescaped.slice(start, i + 1)
        try {
          items.push(JSON.parse(piece))
        } catch {
          /* 这个救不回来，跳过 */
        }
        start = -1
      }
    }
  }
  // 末尾那个没闭合的（模型写到一半就停了）也试着补上
  if (depth > 0 && start >= 0) {
    const piece = unescaped.slice(start)
    for (const suffix of ['"}', '}', '"}}', '}}']) {
      try {
        items.push(JSON.parse(piece + suffix))
        break
      } catch {
        /* 继续试 */
      }
    }
  }
  return items.length > 0 ? items : undefined
}

/**
 * LLM 工具参数的总修复入口。顺序有讲究：先把混进字符串的参数标记拆出来回收，
 * 再处理「本该是结构化值却是 JSON 文本」——回收出来的 characters 往往正是一段 JSON 文本。
 */
export function repairLlmArgs(args: JsonObject): RepairResult {
  const a = repairLeakedParams(args)
  const b = repairJsonTextFields(a.args)
  return { args: b.args, notes: [...a.notes, ...b.notes] }
}

// ─── 查询词归一（插件第 347–407 行） ─────────────────────────

/** 键全是数字的对象，即 LLM 把数组写成了 {"0":..,"1":..} */
function isArrayLike(x: JsonObject): boolean {
  const keys = Object.keys(x)
  return keys.length > 0 && keys.every((k) => /^\d+$/.test(k))
}

function arrayLikeValues(x: JsonObject): unknown[] {
  return Object.keys(x)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => x[k])
}

/**
 * 把 LLM 给的查询字段归一成字符串数组，且**不丢内容**：认不出形状的对象取它第一个字符串字段，
 * 实在取不出才丢弃。实测崩溃入参就是 concepts=[{"0":"罗森"}]。
 */
export function toQueryList(v: unknown): string[] {
  const out: string[] = []
  const push = (x: unknown): void => {
    if (x === null || x === undefined) return
    if (Array.isArray(x)) {
      x.forEach(push)
      return
    }
    if (isJsonObject(x)) {
      if (isArrayLike(x)) {
        arrayLikeValues(x).forEach(push)
        return
      }
      // LLM 常见的包装形态：{name/tag/query/text/value: "..."}
      const named = x.name ?? x.tag ?? x.query ?? x.text ?? x.value
      if (named !== undefined) {
        push(named)
        return
      }
      // 认不出的形状，退而取第一个非空字符串字段，别整条丢掉
      const first = Object.values(x).find((y) => typeof y === 'string' && y.trim() !== '')
      if (first !== undefined) push(first)
      return
    }
    String(x)
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .forEach((t) => out.push(t))
  }
  push(v)
  return out
}

/** 同上，但产出 searchTags 要的 {name, series} 形态 */
export function toCharacterList(v: unknown): CharacterQuery[] {
  const out: CharacterQuery[] = []
  const push = (x: unknown): void => {
    if (x === null || x === undefined) return
    if (Array.isArray(x)) {
      x.forEach(push)
      return
    }
    if (isJsonObject(x)) {
      if (isArrayLike(x)) {
        arrayLikeValues(x).forEach(push)
        return
      }
      // series 只在这里有意义，所以不能直接复用 toQueryList
      const names = toQueryList(x.name ?? x.tag ?? x.query ?? x.text ?? x.value ?? x)
      const series = typeof x.series === 'string' ? x.series.trim() : undefined
      names.forEach((n) => out.push(series ? { name: n, series } : { name: n }))
      return
    }
    toQueryList(x).forEach((n) => out.push({ name: n }))
  }
  push(v)
  return out
}

/**
 * 一组生成参数 → 可读文本，供修改模式的 <现有参数>。插件第 320–344 行。
 * 按顺序串排已知字段，其余字段（negative_prompt / aspect_ratio / characters 等）追加在后，保证不丢参数。
 */
export function formatArgsForEdit(args: JsonObject, order: string): string {
  const lines: string[] = []
  const seen = new Set<string>()
  const emit = (key: string, v: unknown): void => {
    if (v === null || v === undefined || v === '') return
    if (typeof v === 'object') lines.push(`${key}: ${JSON.stringify(v, null, 2)}`)
    else if (String(v).trim()) lines.push(`${key}: ${String(v).trim()}`)
  }
  for (const key of parseFieldOrder(order)) {
    seen.add(key)
    emit(key, args[key])
  }
  for (const [key, v] of Object.entries(args)) {
    if (!seen.has(key)) emit(key, v)
  }
  return lines.join('\n')
}
