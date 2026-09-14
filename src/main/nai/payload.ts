import type { ImageFormat } from '@shared/config'
import type { AssembledPrompt, NaiCenter } from '@shared/gen'
import { alignTo64 } from '@shared/naiOptions'
import type { GenParams } from '@shared/workspace'

/**
 * 解析角色位置。两种写法都认（照画师串工具箱 nai/payload.ts）：
 * - 5×5 网格 `B3`：V4/V4.5 时代的写法，列 A~E → x，行 1~5 → y
 * - 自由坐标 `0.35,0.62`：V5 起可任意定位
 * 切模型不该让写好的提示词失效，所以两种都认；认不出就居中。
 */
export function positionToCenter(pos: string): NaiCenter {
  const raw = String(pos || '').trim()

  const free = /^(-?[\d.]+)\s*[,，]\s*(-?[\d.]+)$/.exec(raw)
  if (free) {
    const clamp = (v: number): number => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.5))
    return { x: clamp(parseFloat(free[1])), y: clamp(parseFloat(free[2])) }
  }

  const AXIS = [0.1, 0.3, 0.5, 0.7, 0.9]
  const grid = /^([A-E])([1-5])$/.exec(raw.toUpperCase())
  if (grid) return { x: AXIS[grid[1].charCodeAt(0) - 65], y: AXIS[Number(grid[2]) - 1] }

  return { x: 0.5, y: 0.5 }
}

/** 插件 naiUcPreset 的枚举：0=Heavy, 1=Light, 2=Human Focus, 3=None。本工具不加负面预设 */
export const UC_PRESET_NONE = 3

export interface PayloadInput {
  assembled: AssembledPrompt
  params: GenParams
  useCoords: boolean
  seed: number
  imageFormat: ImageFormat
}

export interface NaiRequestBody {
  input: string
  model: string
  action: 'generate'
  parameters: Record<string, unknown>
}

/**
 * NovelAI 请求体。字段与常量照 koishi 插件 buildPayload（nai-backend.ts:175-315），
 * 去掉负面预设、质量词与 Variety Boost（工具面向 V5；官网默认正负面不悄悄加进请求）。
 */
export function buildPayload(inp: PayloadInput): NaiRequestBody {
  const { assembled, params } = inp
  const width = alignTo64(params.width)
  const height = alignTo64(params.height)

  const characterPrompts = assembled.characters.map((c) => ({
    prompt: c.prompt,
    uc: c.negative,
    // 坐标无条件发送——官方客户端也这么做，未启用定位时服务端忽略
    center: c.center,
    enabled: true,
  }))
  const charCaptions = characterPrompts.map((c) => ({ char_caption: c.prompt, centers: [c.center] }))
  const charNegCaptions = characterPrompts.map((c) => ({ char_caption: c.uc, centers: [c.center] }))

  // 布朗噪声树；开启时同时关掉「保留 bug 兼容」的开关，互为反值由构造保证
  const preferBrownian = true

  const parameters: Record<string, unknown> = {
    params_version: 3,
    width,
    height,
    scale: params.scale,
    sampler: params.sampler,
    steps: params.steps,
    n_samples: 1,
    ucPreset: UC_PRESET_NONE,
    qualityToggle: false,
    autoSmea: false,
    dynamic_thresholding: false,
    controlnet_strength: 1,
    legacy: false,
    add_original_image: true,
    cfg_rescale: params.cfgRescale,
    noise_schedule: params.noiseSchedule,
    legacy_v3_extend: false,
    skip_cfg_above_sigma: null,
    seed: inp.seed,
    negative_prompt: assembled.negative,
    // 官方 API 文档没有 characterPrompts（只有 v4_prompt），但网页端和各社区实现都在发它；
    // 未知字段服务端会忽略，缺了反而可能影响 V4 系列
    characterPrompts,
    image_format: inp.imageFormat,
    prefer_brownian: preferBrownian,
    deliberate_euler_ancestral_bug: !preferBrownian,
    v4_prompt: {
      caption: { base_caption: assembled.positive, char_captions: charCaptions },
      // 没有角色时恒 false，否则 NAI 会按空坐标表处理
      use_coords: inp.useCoords && charCaptions.length > 0,
      use_order: true,
    },
    v4_negative_prompt: {
      caption: { base_caption: assembled.negative, char_captions: charNegCaptions },
      legacy_uc: false,
    },
  }
  if (params.transparentBackground) {
    parameters.tag_hint_transparent_background = true
    parameters.straight_alpha = true
  }

  return { input: assembled.positive, model: params.model, action: 'generate', parameters }
}
