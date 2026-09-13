import type { AppConfig } from '@shared/config'
import { parseFieldOrder } from '@shared/fields'
import type { MultiCharacterMode } from '@shared/llm'
import { isJsonObject } from './args'
import type { JsonObject } from './types'

/**
 * NovelAI 专属的规范化。插件里分散在 backend/nai-api.ts、backend/nai-backend.ts 与 utils.ts，
 * 本工程只有 NovelAI 一个后端，合在一处。
 */

// ─── 画师字段后处理 ─────────────────────────────────────────

const AT_PLACEHOLDER = '___NAI_LITERAL_AT___'

/**
 * 把 artist 字段里每个标签词首的 `@` 换成 NovelAI 的 `artist:` 前缀。
 *
 * 动机：`@name` 写起来短，也是用户在别的模型上的既有习惯；
 * 而 NovelAI 认的是 `artist:name`。与其要求 LLM 每次写全，不如在这里统一转换。
 *
 * 转义保护（极少数 Danbooru 标签本身以 @ 开头，如 `@_@`）：
 * - `@@name` → 字面 `@name`
 * - `\@name` → 字面 `@name`
 *
 * 只替换**词首**的 @（字符串开头，或逗号/空白/冒号/花括号/方括号/圆括号之后），
 * 这样权重语法 `1.5::@jima ::`、`{@fkey}`、以及沿用 SD 写法的 `(@halcon:0.8)`
 * 里的画师名同样能被识别，而词中间的 @（如 `e-mail@example`）不受影响。
 *
 * 圆括号是后补的：用户的画风预设大量写成 `(@name:权重)`，
 * 漏掉它会让这些画师原样保留 `@name`，NovelAI 不认，画风静默失效。
 */
export function normalizeNaiArtists(text: string): string {
  if (!text || !text.includes('@')) return text
  // 1. 先把转义写法藏起来，避免被下一步替换
  let out = text.replace(/@@/g, AT_PLACEHOLDER).replace(/\\@/g, AT_PLACEHOLDER)
  // 2. 词首的裸 @ → artist:
  out = out.replace(/(^|[,\s:{[(])@/g, '$1artist:')
  // 3. 还原被保护的字面 @
  return out.split(AT_PLACEHOLDER).join('@')
}

/** 从文本中提取所有 LoRA 调用。插件 utils.ts 第 135–141 行 */
export function extractLoras(text: string): string[] {
  if (!text) return []
  return text.match(/<lora:[^>]+>/gi) ?? []
}

/**
 * 从文本中移除所有 LoRA 调用，并清理因此产生的多余逗号/空白。
 */
export function stripLoras(text: string): string {
  if (!text) return text
  return text
    .replace(/<lora:[^>]+>/gi, '')
    .replace(/(\s*,\s*){2,}/g, ' , ')   // 连续逗号合并，保持 " , " 分隔风格
    .replace(/^\s*,\s*/, '')            // 开头逗号
    .replace(/\s*,\s*$/, ' ,')          // 结尾统一为 " ,"
    .replace(/[^\S\n]{2,}/g, ' ')       // 多余空格（不动换行）
    .trim()
}

/**
 * 画风文本里的 `<lora:...>` 在**注入上下文之前**剥掉。插件 utils.ts 第 178–198 行，
 * 去掉了 supportsLora 参数（NovelAI 不认 LoRA）。
 * 留着会造成指令冲突：系统提示词说不支持 LoRA，注入的画风里却带着——实测 LLM 的处理是整个 artist 段留空。
 */
export function stripUnsupportedLoras(style: string): { style: string; removed: string[] } {
  if (!style) return { style, removed: [] }
  const removed = extractLoras(style)
  if (removed.length === 0) return { style, removed: [] }
  return { style: stripLoras(style).replace(/^[\s,]+|[\s,]+$/g, ''), removed }
}

/** 按宽高比与像素上限反推分辨率，对齐到 64 的倍数（NAI 要求）。插件 nai-api.ts 第 87–104 行 */
export function calcNaiDimensions(aspectRatio: string, maxPixels: number): [number, number] {
  const parts = String(aspectRatio).split(':')
  const wR = parseFloat(parts[0]) || 1
  const hR = parseFloat(parts[1]) || 1
  const ratio = wR / hR
  let h = Math.sqrt(maxPixels / ratio)
  let w = h * ratio
  const align = (v: number) => Math.max(64, Math.round(v / 64) * 64)
  w = align(w)
  h = align(h)
  // 对齐后可能超过上限，逐步收缩
  while (w * h > maxPixels && (w > 64 || h > 64)) {
    if (w >= h) w -= 64
    else h -= 64
  }
  return [w, h]
}

/**
 * 就地规范化 LLM 给出的参数。插件 nai-backend.ts 第 564–662 行。
 *
 * 必须就地改而不是返回副本：args 同时是回填内容、落盘内容、展示内容（规格 §9.4）。
 * 与插件的差别：`config.naiMaxCharacters || 6` 与 `config.naiCharPromptOrder || 默认串` 去掉回退——
 * 配置经 mergeConfig 保证合法（规格 §14.1）；角色数组里不是对象的元素跳过而不是抛错。
 *
 * @returns 需要写进日志的处理说明
 */
export function finalizeArgs(args: JsonObject, config: AppConfig): string[] {
  const notes: string[] = []

  // 画师前缀：`@name` → `artist:name`
  const artistRaw = String(args.artist || '')
  if (artistRaw) {
    const normalized = normalizeNaiArtists(artistRaw)
    if (normalized !== artistRaw) {
      args.artist = normalized
      notes.push(`画师前缀归一: "${artistRaw}" → "${normalized}"`)
    }
  }

  // NovelAI 不支持 LoRA。留在 args 里会被修改模式原样喂回去，所以在这里就剥掉
  const loraFields = ['count', 'character', 'series', 'style', 'artist', 'appearance', 'tags', 'environment', 'nltags', 'quality']
  const foundLoras: string[] = []
  for (const f of loraFields) {
    const v = String(args[f] || '')
    if (!v) continue
    const found = extractLoras(v)
    if (found.length > 0) {
      foundLoras.push(...found)
      args[f] = stripLoras(v)
    }
  }
  if (foundLoras.length > 0) {
    notes.push(`已移除 LoRA 调用（NovelAI 不支持）: ${[...new Set(foundLoras)].join(', ')}`)
  }

  if (Array.isArray(args.characters)) {
    // 顶层 character 在多角色模式下应当留空——角色名要落到各自的 characters[].character，
    // 否则模型无法把角色和位置对应起来。
    // 但只在角色层确实填了名字时才剔除：若角色层全空、名字只写在顶层，
    // 剔除等于把角色信息整个丢掉，那比放错位置更糟。
    const topCharacter = String(args.character || '').trim()
    if (topCharacter) {
      const chars = args.characters as unknown[]
      const anyCharNamed = chars.some((c) => isJsonObject(c) && String(c.character || '').trim() !== '')
      if (anyCharNamed) {
        delete args.character
        notes.push(`多角色模式下顶层 character 应留空，已移除: ${topCharacter}`)
      } else {
        notes.push(
          `多角色模式下角色名写在了顶层（"${topCharacter}"）而各角色未填，` + '已保留以免丢失，但模型可能无法把角色与位置对应',
        )
      }
    }

    const max = Math.max(1, config.naiMaxCharacters)
    const all = args.characters as unknown[]
    if (all.length > max) {
      notes.push(`角色数 ${all.length} 超过上限 ${max}，已截断`)
      args.characters = all.slice(0, max)
    }

    const charFields = new Set(parseFieldOrder(config.naiCharPromptOrder))
    // 白名单之外的全局字段整个删掉
    const globalOnly = ['style', 'artist', 'quality', 'series', 'environment'].filter((f) => !charFields.has(f))
    // 逐标签剔除：分级与质量词是整幅画的属性
    const qualityTagSet = new Set(
      String(args.quality || '')
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    )
    const isGlobalTag = (t: string): boolean => /^rating:/.test(t.toLowerCase()) || qualityTagSet.has(t.toLowerCase())

    const dropped: string[] = []
    const kept: unknown[] = args.characters as unknown[]
    for (const c of kept) {
      if (!isJsonObject(c)) continue
      for (const f of globalOnly) {
        if (c[f]) {
          dropped.push(f)
          delete c[f]
        }
      }
      for (const field of ['count', 'character', 'appearance', 'tags']) {
        const v = String(c[field] || '')
        if (!v) continue
        const keep: string[] = []
        for (const t of v.split(',').map((x) => x.trim()).filter(Boolean)) {
          if (isGlobalTag(t)) dropped.push(t)
          else keep.push(t)
        }
        c[field] = keep.join(', ')
      }
      // 角色里的 LoRA 同样剥掉
      for (const field of ['appearance', 'tags', 'nltags']) {
        const v = String(c[field] || '')
        if (v && extractLoras(v).length > 0) c[field] = stripLoras(v)
      }
    }
    if (dropped.length > 0) {
      notes.push(`角色提示词中混入的整图内容已剔除: ${[...new Set(dropped)].join(', ')}`)
    }
  }

  return notes
}

/**
 * 多角色模式追加到系统提示词的说明。插件 nai-backend.ts 第 499–558 行 systemPromptAddendum。
 *
 * 与插件的差别：「想精确控制位置请让用户改用 -R 参数」改成指向界面上的选项——
 * 本应用没有命令，LLM 转述给用户的话也不该出现命令名。
 */
export function multiCharacterAddendum(config: AppConfig, mode: MultiCharacterMode): string {
  if (mode === 'off') return ''
  let out = `

[多角色模式已启用] 你必须使用 generate_image_characters 工具代替 generate_image。

### 顶层字段 vs characters 数组
**顶层只做整体性描述，不出现任何具体角色的信息。**
- **顶层**：总人数（2girls / 1girl 1boy）、分级、画风、画师、质量词、场景、光影、整体构图景别
- **顶层 character 必须留空**——角色名逐个写进 characters 数组各自的 character 字段。
  写在顶层会让模型无法把角色和位置对应起来，多角色就退化成一锅乱炖
- **characters 数组**里每个元素描述该角色本身：性别标记、角色名、外观、动作、表情
  - 例：角色1 = count: girl + character: saber，角色2 = count: girl + character: hatsune miku
- 角色元素里**放弃画风**：不要写 artist、style、质量词。画风是整幅画的，写进单个角色
  会让各角色画风互相打架
- 角色元素里**不要描述背景**：场景、环境、光影、天气只写在顶层 environment。
  在每个角色里重复一遍背景，等于让模型画 N 次背景
- 角色元素里**不要写分级标签和质量词**：rating:xxx、masterpiece、very aesthetic
  这类是整幅画的属性，写进角色只会挤占该角色的有效描述额度
- 也不要在顶层写某个角色专属的外观

### 角色的性别标记
每个角色的 count 只写 **girl / boy / other**，**不带数字**——这对应官方界面上
每个角色的性别选择器。总人数（2girls、1girl 1boy）写在顶层 count。
写成 1girl 会让模型在该角色位置上再数一次人。

### 角色定位
每个角色的 position 优先用自由坐标 "x,y"（0~1，x 左→右，y 上→下）：
- 两人并排：左 "0.3,0.5"、右 "0.7,0.5"
- 三人并排："0.25,0.5"、"0.5,0.5"、"0.75,0.5"
- 前后景："0.4,0.65"（近）、"0.65,0.4"（远）
也可以用 5×5 网格标记（B3 / C3 / D3），但坐标更精确。
位置是构图指引，模型会在此基础上做合理调整。

### 角色间互动标记
NovelAI 用方向前缀标记动作关系，写在**角色自己的 tags 字段**里。
注意是**前缀**：标记直接贴在动作词前面，不加空格、不写成后缀。
- 发起方 source#动作，承受方 target#动作
- 双向动作两边都写 mutual#动作
- 例：拥抱 → 角色A 的 tags 写 source#hug，角色B 写 target#hug
- 例：对视 → 两边都写 mutual#eye contact
- 官方说明这个语法"并非总是可靠"，所以互动动作本身也要在两边的 tags 里正常写一遍
- 没有跨角色互动时不要写这些标记，会干扰模型

### 注意
- NovelAI 不支持 LoRA，提示词中不要写 <lora:...>
- 顶层的 count 写全图总人数，角色的 count 只写 girl / boy / other
- 每个角色至少写清发色 + 瞳色 + 一件标志性服饰，避免多角色特征串味
- 需要透明背景时，把顶层的 transparent_background 设为 true，
  并在 environment 里写上 transparent background`
  if (mode === 'auto') {
    out += `

注意：本次未启用坐标定位（对应官方客户端的 AI's Choice），position 字段会被忽略，
角色位置由模型按 characters 数组顺序自行安排。想精确控制位置请让用户把多角色切到「手动指定坐标」。`
  }
  if (config.naiCharSystemPrompt.trim()) out += '\n' + config.naiCharSystemPrompt
  return out
}
