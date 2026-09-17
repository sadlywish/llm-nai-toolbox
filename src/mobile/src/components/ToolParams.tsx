// 大图的「本工具参数」页（界面稿 2026-09-17 第二节 A 的参数页，第四节方案 Y 里盖在全屏上）。
//
// 内容与桌面端出图弹窗侧栏的「本工具参数」页签同一套：尺寸与 Seed、LLM 请求、整图、画面文字、负面词、
// 角色、参数、拼接结果。全部取那一轮落盘的快照，不取手机现在的工作区。
// 块的先后取快照里存的出图时字段顺序；旧记录没存，才按电脑当前的设置排（并注明）。
import { CHARACTER_FIELDS, MAIN_FIELDS, type FieldSpec } from '@shared/fields'
import type { FieldValues } from '@shared/blockDoc'
import type { RoundRecord } from '@shared/gen'
import { readSnapshotLlm, type SnapshotLlm } from '@shared/llmProvenance'
import type { MobileMeta } from '@shared/mobileApi'
import { paramsLine, snapshotSpecs } from '@shared/toolParams'
import { API_LABELS, MULTI_LABELS, STYLE_MODE_LABELS } from '@renderer/llmLabels'
import BlockRow from './BlockRow'

interface Props {
  round: RoundRecord
  /** 点开的这一张的 seed（同一轮里各张不同） */
  seed: number
  /** 旧记录没存字段顺序时，按它给的当前顺序排；拿不到就用默认顺序 */
  meta: MobileMeta | null
}

const onOff = (v: boolean): string => (v ? '开' : '关')

/** 只列有内容的块；一个都没有写「无」 */
function Blocks({ values, specs }: { values: FieldValues; specs: readonly FieldSpec[] }): JSX.Element {
  const filled = specs.filter((s) => (values[s.name] ?? '').trim() !== '')
  if (filled.length === 0) return <p className="hint">（无）</p>
  return (
    <>
      {filled.map((s) => (
        <BlockRow key={s.name} label={s.label} hue={s.hue} value={values[s.name] ?? ''} />
      ))}
    </>
  )
}

/** undefined 是这项功能之前的旧记录，说不清有没有经过 LLM，与「确定没经过」分开写（同桌面端） */
function LlmRequest({ llm }: { llm: SnapshotLlm | null | undefined }): JSX.Element {
  if (llm == null) {
    return (
      <div className="tp-group">
        <div className="sec">LLM 请求</div>
        <p className="hint">{llm === null ? '（无：这一轮的提示词没有经过 LLM 回填）' : '（旧记录，没有保存 LLM 请求信息）'}</p>
      </div>
    )
  }
  const r = llm.request
  const style = r.styleMode === 'preset' ? `${STYLE_MODE_LABELS.preset}「${r.presetName}」` : STYLE_MODE_LABELS[r.styleMode]
  return (
    <div className="tp-group">
      <div className="sec">
        LLM 请求 · {API_LABELS[r.apiType]} · {r.model} · {r.llmRounds} 轮 · 用时 {Math.round(r.elapsedMs / 1000)}s
      </div>
      {llm.stale && <p className="tp-stale">回填之后提示词或参数又被手工改过，这张图和这次请求不完全对应</p>}
      <div className="tp-instr">{r.instruction}</div>
      <div className="tp-opts">
        <span><i>多角色</i>{MULTI_LABELS[r.multiCharacter]}</span>
        <span><i>在现有内容上修改</i>{onOff(r.editExisting)}</span>
        <span><i>透明背景</i>{onOff(r.transparent)}</span>
        <span><i>画风</i>{style}</span>
        <span><i>回填后自动生成</i>{onOff(r.autoGenerate)}</span>
      </div>
    </div>
  )
}

export default function ToolParams({ round, seed, meta }: Props): JSX.Element {
  const s = round.snapshot
  const specs = snapshotSpecs(s, {
    main: meta?.mainFields ?? MAIN_FIELDS,
    character: meta?.charFields ?? CHARACTER_FIELDS,
  })
  const assembled = round.assembled

  return (
    <div className="tp">
      {/* 尺寸与 Seed 是最常要对照的两项，并排放最前（同桌面端） */}
      <div className="tp-hot">
        <div className="tp-kv">
          <span className="sec">尺寸</span>
          <b>
            {s.params.width}×{s.params.height}
          </b>
        </div>
        <div className="tp-kv">
          <span className="sec">Seed</span>
          <b>{seed}</b>
        </div>
      </div>

      <LlmRequest llm={readSnapshotLlm(s.llm)} />

      <div className="tp-group">
        <div className="sec">整图{specs.legacy && '（旧记录，按当前字段顺序排列）'}</div>
        <Blocks values={s.main} specs={specs.main} />
      </div>

      <div className="tp-group">
        <div className="sec">画面文字</div>
        <BlockRow label="text" hue={null} value={s.text} emptyText="无" />
      </div>

      <div className="tp-group">
        <div className="sec">负面词</div>
        <BlockRow label="negative" hue={null} value={s.negative} emptyText="无" />
      </div>

      {s.characters.map((c, i) => (
        <div key={i} className="tp-group">
          <div className="sec">
            角色 {i + 1} · 坐标 {c.position.trim() || '居中'}
          </div>
          <Blocks values={c.fields} specs={specs.character} />
          <BlockRow label="negative" hue={null} value={c.negative} emptyText="无" />
        </div>
      ))}

      <div className="tp-group">
        <div className="sec">参数 · 使用坐标定位 {onOff(s.useCoords)}</div>
        <div className="tp-line">{paramsLine(s.params)}</div>
      </div>

      {/* 默认收起：要对照的多是上面的块，拼接结果是核对「到底发了什么」时才看 */}
      <details className="tp-group">
        <summary className="sec">拼接结果（实际发给 NovelAI 的）</summary>
        <div className="sec">正向</div>
        <pre className="tp-pre">{assembled.positive}</pre>
        <div className="sec">负面</div>
        <pre className="tp-pre">{assembled.negative || '（无）'}</pre>
        {assembled.characters.map((c, i) => (
          <div key={i} className="tp-group">
            <div className="sec">角色 {i + 1}</div>
            <pre className="tp-pre">{c.prompt}</pre>
            <pre className="tp-pre">负面：{c.negative || '（无）'}</pre>
          </div>
        ))}
      </details>
    </div>
  )
}
