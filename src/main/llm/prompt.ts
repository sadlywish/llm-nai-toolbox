import { sanitizeFieldText } from '@shared/blockDoc'
import type { AppConfig } from '@shared/config'
import type { LlmRunInput, MultiCharacterMode, StyleLock } from '@shared/llm'
import type { Workspace } from '@shared/workspace'
import type { RunLog } from './log'
import { multiCharacterAddendum, stripUnsupportedLoras } from './nai'
import type { JsonObject } from './types'

/**
 * 一轮 LLM 交互的上下文组装。插件 index.ts 第 2068–2144 行。
 *
 * 与插件的差别：
 * - 没有 `[高清修复: …]`（SD 专属）、没有随机画风、没有 LoRA 列表；
 * - 画风三选一的后两档注入 `[画风已锁定: …]`，要求模型不写 artist（规格 §8）；
 * - 修改模式的 <现有参数> 来自工作区，不是缓存里的上一次参数。
 */

/** 修改模式追加到系统提示词末尾的规则。插件第 2136–2143 行，去掉了只对 SD/LoRA 有意义的字样 */
export const EDIT_SYSTEM_BLOCK = `

[修改模式已启用] 本次是在一组已有的生成参数上做局部修改，不是从零创作。
- 用户消息中的 <现有参数> 是当前的完整参数，[用户的修改要求] 才是这次要做的改动
- 只改用户明确要求变动的部分，其余字段必须原样保留——包括 artist、quality、宽高比、负面词
- 调用生成工具时必须输出完整参数，不能只输出改动的字段：没输出的字段会直接丢失
- 用户说"去掉/不要 X"时，从对应字段里删掉那个标签，而不是往负面词里加
- 改动若引入新的角色/画师/概念，照常先用 search_tags 等工具确认标签再填`

export interface SystemPromptParts {
  config: AppConfig
  multi: MultiCharacterMode
  editExisting: boolean
  skillCore: string
  /** 手册启用时传目录，否则 null */
  manualToc: string | null
  /** 分类目录（formatToc 的结果）；分类库不可用时为空串 */
  browseToc: string
}

/** 系统提示词 = 用户的系统提示词 + 多角色说明 + 技能文档（规则、手册目录、分类目录）+ 修改模式规则 */
export function buildSystemPrompt(p: SystemPromptParts): string {
  let system = p.config.systemPrompt
  system += multiCharacterAddendum(p.config, p.multi)
  const skill = [p.skillCore.trim(), (p.manualToc ?? '').trim(), p.browseToc].filter(Boolean).join('\n\n')
  if (skill) system += '\n\n' + skill
  if (p.editExisting) system += EDIT_SYSTEM_BLOCK
  return system
}

/** 画风锁定时注入用户消息的一行。写了也会被收口后处理覆盖，提前告知既省 token，又让其余字段不至于跟画风打架 */
export function styleLockLine(tags: string): string {
  return `[画风已锁定: ${tags}（画风由用户指定，生成时不要填写 artist 字段——收口后 artist 会被替换成这段内容；其余字段照常填写，并与这段画风协调）]`
}

/**
 * 画风三选一 → 要锁定的画风文本；不锁定返回 null。
 * 两种退化情况写进日志（规格 §8、§15）：预设是空的、当前 artist 块是空的——绝不往上下文注入一个空画风。
 */
export function resolveStyleLock(style: StyleLock, workspace: Workspace, log: RunLog): string | null {
  if (style.mode === 'none') return null
  let tags: string
  if (style.mode === 'preset') {
    tags = style.tags.trim()
    if (!tags) {
      log.warn('[画风] 选用的预设画风是空的，本次按不覆盖处理')
      return null
    }
  } else {
    tags = sanitizeFieldText(workspace.main.artist ?? '').trim()
    if (!tags) {
      log.warn('[画风] 当前 artist 块为空，已退化成不锁定')
      return null
    }
  }
  const stripped = stripUnsupportedLoras(tags)
  if (stripped.removed.length > 0) {
    log.info(
      `[画风] NovelAI 不支持 LoRA，已从锁定的画风里剥离 ${stripped.removed.join(', ')}` +
        (stripped.style ? '' : '（剥离后为空，本次不锁定画风）'),
    )
    if (!stripped.style) return null
  }
  log.info(`[画风] 已锁定: ${stripped.style}`)
  return stripped.style
}

export interface UserPromptParts {
  instruction: string
  config: AppConfig
  lockedStyle: string | null
  /** 修改模式的 <现有参数> 文本；非修改模式为 null */
  existingParams: string | null
  /** 标签释义注入块（buildInjectionBlock 的结果） */
  injection: string | null
}

export function buildUserPrompt(p: UserPromptParts): string {
  const settings: string[] = []
  if (p.config.quality) settings.push(`[质量词: ${p.config.quality}]`)
  if (p.lockedStyle) settings.push(styleLockLine(p.lockedStyle))
  if (p.config.negativePrompt) settings.push(`[负面词: ${p.config.negativePrompt}]`)
  const settingsText = settings.join('\n')

  if (p.existingParams !== null) {
    return [
      '[修改模式] 以下是当前的完整生成参数：',
      '',
      '<现有参数>',
      p.existingParams,
      '</现有参数>',
      '',
      ...(p.injection ? [p.injection, ''] : []),
      `[用户的修改要求] ${p.instruction}`,
      '',
      settingsText,
    ]
      .join('\n')
      .trimEnd()
  }
  return [p.injection, p.instruction, settingsText].filter((s): s is string => Boolean(s)).join('\n\n')
}

/** 宽高约分成比例，给 <现有参数> 的 aspect_ratio 用：LLM 只认比例，回填时再按像素上限换算回宽高 */
export function aspectRatioOf(width: number, height: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const g = gcd(w, h)
  return `${w / g}:${h / g}`
}

/**
 * 工作区 → 修改模式的 <现有参数>。形状与生成工具的参数一致，LLM 看到的就是它该输出的样子。
 * 空值不带（省 token）；seed 只在固定模式下带；只带启用的角色——没启用的不参与生成。
 */
export function workspaceToEditArgs(ws: Workspace, withCharacters: boolean): JsonObject {
  const args: JsonObject = {}
  for (const [name, value] of Object.entries(ws.main)) {
    if (value.trim()) args[name] = value.trim()
  }
  if (ws.negative.trim()) args.negative_prompt = ws.negative.trim()
  args.aspect_ratio = aspectRatioOf(ws.params.width, ws.params.height)
  if (ws.params.seedMode === 'fixed') args.seed = ws.params.seed
  if (ws.text.trim()) args.text = ws.text.trim()
  if (ws.params.transparentBackground) args.transparent_background = true
  if (withCharacters) {
    const chars = ws.characters
      .filter((c) => c.enabled)
      .map((c) => {
        const o: JsonObject = {}
        for (const [name, value] of Object.entries(c.fields)) {
          if (value.trim()) o[name] = value.trim()
        }
        if (c.negative.trim()) o.negative_prompt = c.negative.trim()
        if (c.position.trim()) o.position = c.position.trim()
        return o
      })
    if (chars.length > 0) args.characters = chars
  }
  return args
}

/**
 * 实际使用的多角色模式。修改模式下现有内容有启用的角色、多角色却是关闭的：
 * 照插件（index.ts 第 1741–1746 行，原图用多角色工具就自动开 -r）改用多角色工具，
 * 否则字段结构对不上，角色会整组丢失。位置交给模型安排——用户没有要求手动坐标。
 */
export function effectiveMultiCharacter(input: LlmRunInput, log: RunLog): MultiCharacterMode {
  if (input.editExisting && input.multiCharacter === 'off' && input.workspace.characters.some((c) => c.enabled)) {
    log.info('[修改模式] 现有内容里有启用的角色，已按多角色处理（位置由模型安排）')
    return 'auto'
  }
  return input.multiCharacter
}
