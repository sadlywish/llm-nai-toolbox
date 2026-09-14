/**
 * NovelAI 参数的可选值。与 koishi 插件 src/config.ts 的 Schema 逐项一致——
 * sampler / noiseSchedule 是接口认的固定字面量，写错就是 400。
 *
 * 模型名额外留「自定义」入口（见 ParamsPanel）：V5 系列的模型名官方文档未公布，
 * 插件里也是按命名规律推断的，猜错了要能让用户手改。
 */
export const MODEL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'nai-diffusion-5-full', label: 'NAI Diffusion V5 Full' },
  { value: 'nai-diffusion-5-curated', label: 'NAI Diffusion V5 Curated' },
  { value: 'nai-diffusion-4-5-full', label: 'NAI Diffusion V4.5 Full' },
  { value: 'nai-diffusion-4-5-curated', label: 'NAI Diffusion V4.5 Curated' },
  { value: 'nai-diffusion-4-full', label: 'NAI Diffusion V4 Full' },
  { value: 'nai-diffusion-4-curated-preview', label: 'NAI Diffusion V4 Curated' },
  { value: 'nai-diffusion-3', label: 'NAI Diffusion V3（不支持多角色）' },
]

export const SAMPLER_OPTIONS: readonly string[] = [
  'k_euler_ancestral',
  'k_euler',
  'k_dpmpp_2s_ancestral',
  'k_dpmpp_2m',
  'k_dpmpp_2m_sde',
  'k_dpmpp_sde',
]

export const NOISE_SCHEDULE_OPTIONS: readonly string[] = ['karras', 'native', 'exponential', 'polyexponential']

/**
 * 对齐到 64 的倍数，下限 64。
 *
 * 与插件 calcNaiDimensions 里的 `align` 同一个算法。放在 shared 让参数区的
 * 「会被对齐到多少」提示与主进程真正对齐用的是同一个函数——两边各抄一份，
 * 只要取整方向差一点，提示里报的数就是错的，比不提示还误导。
 */
export function alignTo64(v: number): number {
  return Math.max(64, Math.round(v / 64) * 64)
}

export type PixelPresetId = 'normal' | 'large' | 'wallpaper'

/**
 * 设置里「像素上限」的预设，取 NAI 官网分辨率预设的总像素。Large 取方图 1472×1472
 * （用户定的）：1:1 换算回正好 1472×1472，竖/横图会换算成 1216×1728 这类非官网尺寸。
 */
export const PIXEL_PRESETS: ReadonlyArray<{ id: PixelPresetId; label: string; size: string; pixels: number }> = [
  { id: 'normal', label: 'Normal', size: '1024×1024', pixels: 1024 * 1024 },
  { id: 'large', label: 'Large', size: '1472×1472', pixels: 1472 * 1472 },
  { id: 'wallpaper', label: 'Wallpaper', size: '1920×1088', pixels: 1920 * 1088 },
]

/** 像素上限恰好等于某个预设时返回它；否则 null，下拉显示「手动设置」 */
export function pixelPresetOf(pixels: number): PixelPresetId | null {
  return PIXEL_PRESETS.find((p) => p.pixels === pixels)?.id ?? null
}

/** Opus 订阅免费出图的总像素上限；超过就按张消耗 Anlas */
export const OPUS_FREE_MAX_PIXELS = 1024 * 1024

export function exceedsOpusFree(width: number, height: number): boolean {
  return width * height > OPUS_FREE_MAX_PIXELS
}
