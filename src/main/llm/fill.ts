import { sanitizeFieldText, type FieldValues } from '@shared/blockDoc'
import type { AppConfig } from '@shared/config'
import { CHARACTER_FIELDS, MAIN_FIELDS, type FieldSpec } from '@shared/fields'
import type { FillCharacter, FillResult, MultiCharacterMode } from '@shared/llm'
import { isJsonObject } from './args'
import type { RunLog } from './log'
import { calcNaiDimensions, finalizeArgs } from './nai'
import type { JsonObject } from './types'

/**
 * 收口后处理：把生成工具的参数变成回填内容。
 *
 * 插件在「调 API 出图」之前做的事全部在这里做完（index.ts 第 2515–2540 行，以及
 * nai-backend.ts buildPayload 里的负面词兜底、宽高换算、角色负面词拼接）。
 * 回填本身不再做任何处理，所以不存在「没回填」的值。
 *
 * 例外是 text：插件在拼接完提示词之后才用 applyTextRendering 处理它，
 * 提示词排序里没有它的位置，所以这里原样带出，出图时再处理（计划 4）。
 */

export interface PostProcessContext {
  config: AppConfig
  /** resolveStyleLock 的结果 */
  lockedStyle: string | null
  multi: MultiCharacterMode
  /** 指令区的「透明背景」 */
  transparent: boolean
  /** 本次收口用的是 generate_image_characters */
  withCharacters: boolean
  log: RunLog
}

/** 一个字段值 → 编辑器里的一段。编辑器每段只有一行：换行换成空格，再去掉分隔符 */
function fieldText(raw: unknown, where: string, log: RunLog): string {
  const s = String(raw || '')
  const oneLine = s.replace(/\s*[\r\n]+\s*/g, ' ')
  if (oneLine !== s) log.info(`[回填] ${where} 里的换行已换成空格（编辑器每个块只有一行）`)
  return sanitizeFieldText(oneLine).trim()
}

function fieldsFrom(src: JsonObject, specs: readonly FieldSpec[], prefix: string, log: RunLog): FieldValues {
  const out: FieldValues = {}
  for (const spec of specs) out[spec.name] = fieldText(src[spec.name], `${prefix}${spec.name}`, log)
  return out
}

/**
 * 角色负面词 + 设置里的角色默认负面词（插件 buildPayload 第 203–204 行）。
 * 已经带着默认负面词时不再追加：修改模式会把上次回填的结果原样喂回来，不判重就会一轮叠一层。
 */
export function joinCharacterNegative(own: string, defaults: string): string {
  const a = own.trim()
  const b = defaults.trim()
  if (!b) return a
  if (!a) return b
  if (a.toLowerCase().includes(b.toLowerCase())) return a
  return `${a}, ${b}`
}

export function postProcess(args: JsonObject, ctx: PostProcessContext): FillResult {
  const { config, log } = ctx

  // 画风锁定：在规范化之前覆盖，锁定的画风同样经过 @ → artist: 归一
  if (ctx.lockedStyle !== null) {
    args.artist = ctx.lockedStyle
    log.info(`[强制画风] artist 覆盖为: ${ctx.lockedStyle}`)
  }
  // 就地规范化：args 同时是回填、落盘与展示的那一份
  for (const note of finalizeArgs(args, config)) log.info(`[NovelAI] ${note}`)
  // 画风空置是个反复出现的故障，从图上看不出是 LLM 没填还是被后处理吃了，明确打出来
  if (!String(args.artist || '').trim()) {
    log.warn('[画风] artist 段为空（本次未锁定画风）——LLM 未填写该字段')
  }
  // 透明背景是强制开启，不覆盖模型已判断为 true 的情况
  if (ctx.transparent) args.transparent_background = true

  const main = fieldsFrom(args, MAIN_FIELDS, '', log)
  const negative = String(args.negative_prompt || config.negativePrompt || '').trim()

  const aspectRatio = String(args.aspect_ratio || '1:1')
  const [width, height] = calcNaiDimensions(aspectRatio, config.naiMaxPixels)
  log.info(`宽高比 ${aspectRatio} → ${width}×${height}（像素上限 ${config.naiMaxPixels}）`)

  const rawSeed = Number(args.seed ?? -1)
  const seed = Number.isFinite(rawSeed) && rawSeed >= 0 ? Math.floor(rawSeed) : null

  const characters: FillCharacter[] = []
  if (ctx.withCharacters && Array.isArray(args.characters)) {
    const list = args.characters as unknown[]
    list.forEach((c, i) => {
      if (!isJsonObject(c)) return
      characters.push({
        fields: fieldsFrom(c, CHARACTER_FIELDS, `角色 ${i + 1} 的 `, log),
        negative: joinCharacterNegative(String(c.negative_prompt || ''), config.naiCharDefaultNegative),
        position: String(c.position || '').trim(),
      })
    })
  }

  const tb = args.transparent_background
  return {
    main,
    text: String(args.text || '').replace(/\s*[\r\n]+\s*/g, ' ').trim(),
    negative,
    aspectRatio,
    width,
    height,
    seed,
    transparentBackground: tb === true || tb === 'true',
    characters,
    useCoords: ctx.multi === 'coords',
  }
}
