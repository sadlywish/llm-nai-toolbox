// 参数页：手机自己的一份生成参数（计划 Task 13，界面稿第四节「参数（手机自己的一份）」）。
//
// 字段、顺序与文案照桌面端 ParamsPanel（renderer/src/components/ParamsPanel.tsx），
// 不重新发明一套措辞——两边说的是同一件事，用词不一样只会让人怀疑是不是行为也不一样。
// 这一页只改手机本地那份工作区，出图时才整包发给桌面端（Global Constraints）。
import { MODEL_OPTIONS, NOISE_SCHEDULE_OPTIONS, SAMPLER_OPTIONS } from '@shared/naiOptions'
import type { MobileMeta } from '@shared/mobileApi'
import type { GenParams, Workspace } from '@shared/workspace'
import { clampParams } from '../clampParams'
import NumberField from '../components/NumberField'

const CUSTOM_MODEL = '__custom__'

/** meta 还没拉到时的兜底像素上限，与 shared/config.ts 的 naiMaxPixels 默认值一致 */
const DEFAULT_MAX_PIXELS = 1024 * 1024

interface Props {
  workspace: Workspace
  meta: MobileMeta | null
  onChange: (update: (w: Workspace) => Workspace) => void
}

function patchParams(w: Workspace, patch: Partial<GenParams>): Workspace {
  return { ...w, params: { ...w.params, ...patch } }
}

export default function Params({ workspace, meta, onChange }: Props): JSX.Element {
  const params = workspace.params
  const models = meta?.models ?? MODEL_OPTIONS.map((m) => m.value)
  const samplers = meta?.samplers ?? SAMPLER_OPTIONS
  const noiseSchedules = meta?.noiseSchedules ?? NOISE_SCHEDULE_OPTIONS
  const maxPixels = meta?.maxPixels ?? DEFAULT_MAX_PIXELS

  const isKnownModel = models.includes(params.model)
  const seedDisabled = params.seedMode === 'perImage'

  const setParams = (patch: Partial<GenParams>): void => onChange((w) => patchParams(w, patch))
  const clampSize = (): void => onChange((w) => patchParams(w, clampParams(w.params, maxPixels)))

  return (
    <div className="params-page">
      <label className="field">
        <span>模型</span>
        <select
          value={isKnownModel ? params.model : CUSTOM_MODEL}
          onChange={(e) => {
            const v = e.target.value
            setParams({ model: v === CUSTOM_MODEL ? '' : v })
          }}
        >
          {models.map((m) => (
            <option key={m} value={m}>
              {MODEL_OPTIONS.find((o) => o.value === m)?.label ?? m}
            </option>
          ))}
          <option value={CUSTOM_MODEL}>自定义…</option>
        </select>
      </label>

      {!isKnownModel && (
        <label className="field">
          <span>自定义模型名</span>
          <input
            type="text"
            value={params.model}
            placeholder="NovelAI 接口里的模型名"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setParams({ model: e.target.value })}
          />
        </label>
      )}

      <div className="two">
        <NumberField label="宽度" value={params.width} step={64} range={{ min: 64, integer: true }} onCommit={(v) => setParams({ width: v })} onSettled={clampSize} />
        <NumberField label="高度" value={params.height} step={64} range={{ min: 64, integer: true }} onCommit={(v) => setParams({ height: v })} onSettled={clampSize} />
      </div>
      <p className="hint">失焦后自动对齐到 64 的倍数；总像素超过上限（{maxPixels.toLocaleString('en-US')}）会按比例缩小。</p>

      <div className="two">
        <label className="field">
          <span>Seed 模式</span>
          <select
            value={params.seedMode}
            onChange={(e) => {
              const v = e.target.value
              if (v !== 'fixed' && v !== 'perImage') return
              setParams({ seedMode: v })
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
          onCommit={(v) => setParams({ seed: v })}
        />
      </div>

      <div className="two">
        <NumberField label="步数" value={params.steps} range={{ min: 1, integer: true }} onCommit={(v) => setParams({ steps: v })} />
        <NumberField label="CFG（Scale）" value={params.scale} step={0.5} range={{ min: 0 }} onCommit={(v) => setParams({ scale: v })} />
      </div>

      <div className="two">
        <label className="field">
          <span>采样器</span>
          <select value={params.sampler} onChange={(e) => setParams({ sampler: e.target.value })}>
            {samplers.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>噪声调度</span>
          <select value={params.noiseSchedule} onChange={(e) => setParams({ noiseSchedule: e.target.value })}>
            {noiseSchedules.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="two">
        <NumberField
          label="CFG Rescale"
          value={params.cfgRescale}
          step={0.01}
          range={{ min: 0, max: 1 }}
          onCommit={(v) => setParams({ cfgRescale: v })}
        />
        <NumberField label="跑图次数" value={workspace.runCount} range={{ min: 1, integer: true }} onCommit={(v) => onChange((w) => ({ ...w, runCount: v }))} />
      </div>

      <label className="field-check">
        <input
          type="checkbox"
          checked={params.transparentBackground}
          onChange={(e) => setParams({ transparentBackground: e.target.checked })}
        />
        透明背景（transparent_background）
      </label>
    </div>
  )
}
