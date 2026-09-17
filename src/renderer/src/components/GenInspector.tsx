import { useEffect, useState, type CSSProperties } from 'react'
import type { FieldValues } from '@shared/blockDoc'
import { applyRoundToWorkspace } from '@shared/copyInfo'
import type { FieldSpec } from '@shared/fields'
import type { ImageMeta, ImageRecord, RoundRecord } from '@shared/gen'
import { readSnapshotLlm, type SnapshotLlm } from '@shared/llmProvenance'
import { paramsLine, snapshotSpecs } from '@shared/toolParams'
import type { Workspace } from '@shared/workspace'
import { API_LABELS, MULTI_LABELS, STYLE_MODE_LABELS } from '../llmLabels'

export interface InspectedImage {
  round: RoundRecord
  record: ImageRecord
  url: string
}

interface Props {
  item: InspectedImage
  /** 当前设置的字段顺序。块的先后照快照里存的出图时顺序；旧记录没存，才按这个排 */
  mainSpecs: readonly FieldSpec[]
  charSpecs: readonly FieldSpec[]
  update: (fn: (draft: Workspace) => void) => void
  onOpenViewer: () => void
  /** 复制信息写进参数区之后 */
  onCopied: () => void
}

type MetaState = { kind: 'loading' } | { kind: 'ready'; meta: ImageMeta } | { kind: 'none' }

/** 字段按块显示，沿用编辑器的块配色；空的块不列 */
function Blocks({ values, specs }: { values: FieldValues; specs: readonly FieldSpec[] }): JSX.Element {
  const filled = specs.filter((s) => (values[s.name] ?? '').trim() !== '')
  if (filled.length === 0) return <span className="gen-field-value">（无）</span>
  return (
    <div className="gen-blocks">
      {filled.map((s) => (
        <span key={s.name} className="gen-block" style={{ '--h': s.hue } as CSSProperties}>
          <i>{s.name}</i>
          {values[s.name]}
        </span>
      ))}
    </div>
  )
}

const onOff = (v: boolean): string => (v ? '开' : '关')

/**
 * 产出这些提示词的 LLM 请求（界面稿 2026-09-15-llm-provenance-mockup.html 位置 B）。
 * undefined 是这项功能之前的旧记录，说不清有没有经过 LLM，与「确定没经过」分开写。
 */
function LlmRequest({ llm }: { llm: SnapshotLlm | null | undefined }): JSX.Element {
  if (llm == null) {
    return (
      <div className="gen-field gen-llm">
        <span className="gen-field-label">LLM 请求</span>
        <span className="gen-field-value">
          {llm === null ? '（无：这一轮的提示词没有经过 LLM 回填）' : '（旧记录，没有保存 LLM 请求信息）'}
        </span>
      </div>
    )
  }
  const r = llm.request
  const style = r.styleMode === 'preset' ? `${STYLE_MODE_LABELS.preset}「${r.presetName}」` : STYLE_MODE_LABELS[r.styleMode]
  return (
    <div className="gen-field gen-llm">
      <span className="gen-field-label">
        LLM 请求 · {API_LABELS[r.apiType]} · {r.model} · {r.llmRounds} 轮 · 用时 {Math.round(r.elapsedMs / 1000)}s
      </span>
      {llm.stale && <span className="gen-llm-stale">回填之后提示词或参数又被手工改过，这张图和这次请求不完全对应</span>}
      <span className="gen-llm-instruction">{r.instruction}</span>
      <span className="gen-llm-opts">
        <span><i>多角色</i>{MULTI_LABELS[r.multiCharacter]}</span>
        <span><i>在现有内容上修改</i>{onOff(r.editExisting)}</span>
        <span><i>透明背景</i>{onOff(r.transparent)}</span>
        <span><i>画风</i>{style}</span>
        <span><i>回填后自动生成</i>{onOff(r.autoGenerate)}</span>
      </span>
    </div>
  )
}

/** Comment 里是 JSON：排版后显示；不是 JSON 就原样 */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/**
 * 点开一张图之后的溯源侧栏（照工具箱 ImageInspector）。
 * 「本工具参数」是落盘时存下的本工具格式快照与真正发出去的拼接结果；「图片元信息」直接读图片文件。
 * 「复制信息」把快照整套覆盖到参数区，seed 以图片元信息里的为准（读不到用记录里的），并改成固定模式。
 * 界面稿：docs/superpowers/specs/2026-09-14-generation-mockup.html 第 3 版状态 3、3b。
 */
export default function GenInspector({ item, mainSpecs, charSpecs, update, onOpenViewer, onCopied }: Props): JSX.Element {
  const { round, record, url } = item
  const snapshot = round.snapshot
  const specs = snapshotSpecs(snapshot, { main: mainSpecs, character: charSpecs })
  const [tab, setTab] = useState<'tool' | 'meta'>('tool')
  const [meta, setMeta] = useState<MetaState>({ kind: 'loading' })
  const [copying, setCopying] = useState(false)

  // 选中哪张就读哪张的元信息：「图片元信息」页签与「复制信息」取 seed 共用这一次读取
  useEffect(() => {
    let cancelled = false
    setMeta({ kind: 'loading' })
    void window.api.readImageMeta({ roundStartedAt: round.startedAt, file: record.file }).then((m) => {
      if (!cancelled) setMeta(m === null ? { kind: 'none' } : { kind: 'ready', meta: m })
    })
    return () => {
      cancelled = true
    }
  }, [round.startedAt, record.file])

  const metaSeed = meta.kind === 'ready' ? meta.meta.seed : null
  const scope = '覆盖参数区的整图字段、画面文字、负面词、角色、使用坐标定位与参数；'
  const copyHint =
    meta.kind === 'loading'
      ? `${scope}seed 取图片元信息里的值，seed 模式改为固定`
      : metaSeed !== null
        ? `${scope}seed 取图片元信息里的 ${metaSeed}，seed 模式改为固定`
        : `${scope}元信息里没有 seed，用的是记录里的 ${record.seed}，seed 模式改为固定`

  async function copyInfo(): Promise<void> {
    setCopying(true)
    let seed = metaSeed ?? record.seed
    // 元信息还没读回来时现读一次：seed 必须以图片里的为准
    if (meta.kind === 'loading') {
      const m = await window.api.readImageMeta({ roundStartedAt: round.startedAt, file: record.file })
      seed = m?.seed ?? record.seed
    }
    update((ws) => applyRoundToWorkspace(ws, snapshot, seed))
    setCopying(false)
    onCopied()
  }

  const chunks = meta.kind === 'ready' ? Object.entries(meta.meta.chunks) : []

  return (
    <aside className="gen-inspector">
      {/* 侧栏常驻（没有关闭按钮）：点格子切换展示哪一张 */}
      <div className="gen-inspector-header">
        <span>溯源信息</span>
      </div>
      <img className="gen-inspector-preview" src={url} alt={`第 ${record.index + 1} 张`} onClick={onOpenViewer} />

      <div className="gen-tabs" role="tablist">
        <button type="button" role="tab" className={tab === 'tool' ? 'is-on' : ''} onClick={() => setTab('tool')}>
          本工具参数
        </button>
        <button type="button" role="tab" className={tab === 'meta' ? 'is-on' : ''} onClick={() => setTab('meta')}>
          图片元信息
        </button>
      </div>

      {tab === 'tool' ? (
        <div className="gen-inspector-body">
          {/* 尺寸与 Seed 是最常要对照的两项，并排放最前 */}
          <div className="gen-hot-row">
            <div className="gen-field">
              <span className="gen-field-label">尺寸</span>
              <span className="gen-field-value">
                {snapshot.params.width}×{snapshot.params.height}
              </span>
            </div>
            <div className="gen-field">
              <span className="gen-field-label">Seed</span>
              <span className="gen-field-value">{record.seed}</span>
            </div>
          </div>
          <LlmRequest llm={readSnapshotLlm(snapshot.llm)} />
          <div className="gen-field">
            <span className="gen-field-label">整图{specs.legacy && '（旧记录，按当前字段顺序排列）'}</span>
            <Blocks values={snapshot.main} specs={specs.main} />
          </div>
          <div className="gen-field">
            <span className="gen-field-label">画面文字</span>
            <span className="gen-field-value">{snapshot.text.trim() || '（无）'}</span>
          </div>
          <div className="gen-field">
            <span className="gen-field-label">负面词</span>
            <span className="gen-field-value">{snapshot.negative.trim() || '（无）'}</span>
          </div>
          {snapshot.characters.map((c, i) => (
            <div key={i} className="gen-field">
              <span className="gen-field-label">
                角色 {i + 1} · 坐标 {c.position.trim() || '居中'}
              </span>
              <Blocks values={c.fields} specs={specs.character} />
              <span className="gen-field-value">负面：{c.negative.trim() || '（无）'}</span>
            </div>
          ))}
          <div className="gen-field">
            <span className="gen-field-label">参数 · 使用坐标定位 {snapshot.useCoords ? '开' : '关'}</span>
            <span className="gen-field-value">{paramsLine(snapshot.params)}</span>
          </div>
          <details className="gen-field">
            <summary className="gen-field-label">拼接结果</summary>
            <span className="gen-field-label">正向</span>
            <pre className="gen-pre">{round.assembled.positive}</pre>
            <span className="gen-field-label">负面</span>
            <pre className="gen-pre">{round.assembled.negative || '（无）'}</pre>
            {round.assembled.characters.map((c, i) => (
              <div key={i} className="gen-field">
                <span className="gen-field-label">角色 {i + 1}</span>
                <pre className="gen-pre">{c.prompt}</pre>
                <pre className="gen-pre">负面：{c.negative || '（无）'}</pre>
              </div>
            ))}
          </details>
        </div>
      ) : (
        <div className="gen-inspector-body">
          {meta.kind === 'loading' && <div className="placeholder">读取中…</div>}
          {meta.kind !== 'loading' && chunks.length === 0 && <div className="placeholder">这张图里没有读到元信息</div>}
          {chunks.map(([key, text]) => (
            <div key={key} className="gen-field">
              <span className="gen-field-label">{key}</span>
              {key === 'Comment' ? <pre className="gen-pre">{prettyJson(text)}</pre> : <span className="gen-field-value">{text}</span>}
            </div>
          ))}
        </div>
      )}

      <button type="button" className="gen-copy-btn" disabled={copying} onClick={() => void copyInfo()}>
        复制信息
      </button>
      <span className="gen-copy-hint">{copyHint}</span>
    </aside>
  )
}
