import { MODEL_OPTIONS, NOISE_SCHEDULE_OPTIONS, SAMPLER_OPTIONS, alignTo64, exceedsOpusFree } from '@shared/naiOptions'
import type { GenParams } from '@shared/workspace'

const CUSTOM_MODEL = '__custom__'

interface NumberFieldProps {
  label: string
  value: number
  step?: number
  min?: number
  max?: number
  disabled?: boolean
  hint?: string
  /** hint 旁的一键修正按钮；目前只有宽高的「对齐到 64」用到 */
  hintAction?: { label: string; onClick: () => void }
  /** 附加到 label 上的 class，用于按状态高亮 */
  className?: string
  onCommit: (v: number) => void
}

function NumberField({
  label,
  value,
  step,
  min,
  max,
  disabled = false,
  hint,
  hintAction,
  className,
  onCommit,
}: NumberFieldProps): JSX.Element {
  return (
    <label className={`field ${className ?? ''} ${disabled ? 'is-disabled' : ''}`}>
      <span>{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.valueAsNumber
          // 输入过程中出现的空值/半截负号会先经过 NaN，不接住的话会把 NaN 写进工作区
          if (Number.isNaN(v)) return
          onCommit(v)
        }}
      />
      {hint !== undefined && (
        <div className="field-row">
          <span className="field-hint">{hint}</span>
          {hintAction !== undefined && (
            <button type="button" onClick={hintAction.onClick}>
              {hintAction.label}
            </button>
          )}
        </div>
      )}
    </label>
  )
}

interface Props {
  params: GenParams
  onChange: (mutate: (p: GenParams) => void) => void
}

/** 参数区。字段、顺序与提示照画师串工具箱例图面板的参数网格 */
export default function ParamsPanel({ params, onChange }: Props): JSX.Element {
  const isKnownModel = MODEL_OPTIONS.some((m) => m.value === params.model)
  // perImage 模式下 seed 不参与计算，可填反而误导以为钉住了 seed；
  // 置灰后仍展示出图后回填的最后一次实际值，供查看/复制
  const seedDisabled = params.seedMode === 'perImage'
  // 真正发出去的是对齐到 64 之后的宽高，免费范围按它算
  const sentWidth = alignTo64(params.width)
  const sentHeight = alignTo64(params.height)

  /**
   * 预览「会被对齐成多少」。不提示的后果不是少个体验优化：用户填 800、
   * 快照里也记 800，实际发出去、存下来的却是 832——一条假溯源。
   */
  function dimensionHint(v: number): string | undefined {
    return v === alignTo64(v) ? undefined : `不是 64 的倍数，会被对齐到 ${alignTo64(v)}`
  }

  return (
    <div className={`params ${params.seedMode === 'fixed' ? 'is-fixed-seed' : ''}`}>
      <label className="field span2">
        <span>模型</span>
        <select
          value={isKnownModel ? params.model : CUSTOM_MODEL}
          onChange={(e) => {
            const v = e.target.value
            // 选「自定义」时清空模型名，下面才会出现手填框——已知模型名下没有别的入口
            onChange((p) => {
              p.model = v === CUSTOM_MODEL ? '' : v
            })
          }}
        >
          {MODEL_OPTIONS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
          <option value={CUSTOM_MODEL}>自定义…</option>
        </select>
      </label>

      {!isKnownModel && (
        <label className="field span2">
          <span>自定义模型名</span>
          <input
            type="text"
            value={params.model}
            placeholder="NovelAI 接口里的模型名"
            onChange={(e) => {
              const v = e.target.value
              onChange((p) => {
                p.model = v
              })
            }}
          />
        </label>
      )}

      {/* 尺寸与 Seed 是反复改动的热参数，紧跟模型。尺寸单独框出：LLM 回填会整组覆盖它 */}
      <div className="size-box">
        <div className="size-box-head">
          <span>尺寸</span>
          <span className="size-box-note">LLM 回填时会按宽高比与像素上限重算，覆盖这里的宽高</span>
        </div>
        <div className="two-col">
          <NumberField
            label="宽度"
            value={params.width}
            step={64}
            hint={dimensionHint(params.width)}
            hintAction={{
              label: '对齐到 64',
              onClick: () =>
                onChange((p) => {
                  p.width = alignTo64(p.width)
                }),
            }}
            onCommit={(v) =>
              onChange((p) => {
                p.width = v
              })
            }
          />
          <NumberField
            label="高度"
            value={params.height}
            step={64}
            hint={dimensionHint(params.height)}
            hintAction={{
              label: '对齐到 64',
              onClick: () =>
                onChange((p) => {
                  p.height = alignTo64(p.height)
                }),
            }}
            onCommit={(v) =>
              onChange((p) => {
                p.height = v
              })
            }
          />
        </div>
        {exceedsOpusFree(sentWidth, sentHeight) && (
          <div className="opus-warn" role="note">
            总像素 {sentWidth}×{sentHeight} = {sentWidth * sentHeight}，超过 1024×1024，超出 Opus 免费范围，每张图都会消耗 Anlas。
          </div>
        )}
      </div>

      <label className="field row-start seed-mode">
        <span>Seed 模式</span>
        <select
          value={params.seedMode}
          onChange={(e) => {
            const v = e.target.value
            if (v !== 'fixed' && v !== 'perImage') return
            onChange((p) => {
              p.seedMode = v
            })
          }}
        >
          <option value="perImage">每张随机</option>
          <option value="fixed">固定</option>
        </select>
      </label>
      <NumberField
        label="Seed"
        value={params.seed}
        disabled={seedDisabled}
        hint={seedDisabled ? '每张随机，出图后回填最后一次的值' : undefined}
        className="seed-value"
        onCommit={(v) =>
          onChange((p) => {
            p.seed = v
          })
        }
      />

      {/* 固定 seed 要醒目：每张都用同一个 seed，最容易出现「怎么出的图都一样」 */}
      {params.seedMode === 'fixed' && (
        <div className="seed-fixed-warn" role="note">
          固定 seed：{params.seed >= 0 ? `每张都用 ${params.seed}` : '开跑时随机一个、每张都用它'}，同一套参数出的图几乎一样。要出不同的图，把 seed 模式改回「每张随机」。
        </div>
      )}

      <NumberField
        label="步数"
        value={params.steps}
        min={1}
        onCommit={(v) =>
          onChange((p) => {
            p.steps = v
          })
        }
      />
      <NumberField
        label="CFG（Scale）"
        value={params.scale}
        step={0.5}
        onCommit={(v) =>
          onChange((p) => {
            p.scale = v
          })
        }
      />

      <label className="field">
        <span>采样器</span>
        <select
          value={params.sampler}
          onChange={(e) => {
            const v = e.target.value
            onChange((p) => {
              p.sampler = v
            })
          }}
        >
          {SAMPLER_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>噪声调度</span>
        <select
          value={params.noiseSchedule}
          onChange={(e) => {
            const v = e.target.value
            onChange((p) => {
              p.noiseSchedule = v
            })
          }}
        >
          {NOISE_SCHEDULE_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>

      <NumberField
        label="CFG Rescale"
        value={params.cfgRescale}
        step={0.01}
        min={0}
        max={1}
        onCommit={(v) =>
          onChange((p) => {
            p.cfgRescale = v
          })
        }
      />

      <label className="field-check span2">
        <input
          type="checkbox"
          checked={params.transparentBackground}
          onChange={(e) => {
            const checked = e.target.checked
            onChange((p) => {
              p.transparentBackground = checked
            })
          }}
        />
        透明背景（transparent_background）
      </label>
    </div>
  )
}
