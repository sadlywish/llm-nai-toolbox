import { useEffect, useState, type CSSProperties } from 'react'
import type { FieldValues } from '@shared/blockDoc'
import { applyRoundToWorkspace } from '@shared/copyInfo'
import type { FieldSpec } from '@shared/fields'
import type { ImageMeta, ImageRecord, RoundRecord } from '@shared/gen'
import type { GenParams, Workspace } from '@shared/workspace'

export interface InspectedImage {
  round: RoundRecord
  record: ImageRecord
  url: string
}

interface Props {
  item: InspectedImage
  /** 块的先后照当前的字段顺序显示 */
  mainSpecs: readonly FieldSpec[]
  charSpecs: readonly FieldSpec[]
  update: (fn: (draft: Workspace) => void) => void
  onClose: () => void
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

/** 尺寸不在这一行：它和 Seed 一起单独放在最前面 */
function paramsLine(p: GenParams): string {
  return `${p.model} · steps ${p.steps} · CFG ${p.scale} · CFG Rescale ${p.cfgRescale} · ${p.sampler} · ${p.noiseSchedule} · 透明背景 ${p.transparentBackground ? '开' : '关'}`
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
export default function GenInspector({ item, mainSpecs, charSpecs, update, onClose, onOpenViewer, onCopied }: Props): JSX.Element {
  const { round, record, url } = item
  const snapshot = round.snapshot
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
      <div className="gen-inspector-header">
        <span>溯源信息</span>
        <button type="button" className="gen-inspector-close" title="关闭详情" onClick={onClose}>
          ×
        </button>
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
          <div className="gen-field">
            <span className="gen-field-label">整图</span>
            <Blocks values={snapshot.main} specs={mainSpecs} />
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
              <Blocks values={c.fields} specs={charSpecs} />
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
