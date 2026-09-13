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
