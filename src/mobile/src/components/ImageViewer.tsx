// 点开一张图：大图 + 这张的参数 + 两个动作（界面稿第三节右边那张）。
//
// 显示的参数一律取那一轮落盘的快照，不取手机现在这份工作区——出图之后接着改参数是常事，
// 拿当前值去说「这张图是这么出来的」就是撒谎。seed 用点开的这一张的（同一轮里各张不同）。
import { useState } from 'react'
import { MAIN_FIELDS } from '@shared/fields'
import type { GenSnapshot, RoundRecord } from '@shared/gen'
import type { MobileMeta } from '@shared/mobileApi'
import { buildPositivePrompt } from '@shared/prompt'
import type { ApiClient } from '../api'
import { copyText } from '../clipboard'

interface Props {
  /** 这一轮的第几张，从 0 数 */
  index: number
  file: string
  seed: number
  /** 那一轮的记录：大图地址要它的 startedAt，参数与提示词取它的快照 */
  round: RoundRecord
  meta: MobileMeta | null
  client: ApiClient
  onClose: () => void
  /** 「参数写回手机」：整套覆盖手机本地那份工作区，seed 用这张的并改成固定 */
  onApply: (snapshot: GenSnapshot, seed: number) => void
}

/** 参数那一行（界面稿：`832×1216 · 28 步 · CFG 5 · k_euler_ancestral`） */
function paramsLine(snapshot: GenSnapshot): string {
  const p = snapshot.params
  return `${p.width}×${p.height} · ${p.steps} 步 · CFG ${p.scale} · ${p.sampler}`
}

export default function ImageViewer({ index, file, seed, round, meta, client, onClose, onApply }: Props): JSX.Element {
  const [applied, setApplied] = useState(false)
  /** 复制不了时把提示词摊开让人自己长按选（明文 HTTP 页面里 Clipboard API 常常不可用） */
  const [fallback, setFallback] = useState<string | null>(null)

  // 字段顺序照电脑上的 promptOrder（meta 给的已经排好），拿不到 meta 才退回默认顺序
  const specs = meta?.mainFields ?? MAIN_FIELDS
  const positive = buildPositivePrompt(round.snapshot.main, round.snapshot.text, specs)

  const copy = (): void => {
    void copyText(positive).then((ok) => {
      setFallback(ok ? null : positive)
    })
  }

  const apply = (): void => {
    onApply(round.snapshot, seed)
    setApplied(true)
    // 只是一句回执，两秒后自己退回去（同 EditSheet 的「已复制」）
    setTimeout(() => setApplied(false), 2000)
  }

  return (
    // 盖住整页而不是从底部弹一半：看图要的是尽量大的画面，半截弹层只剩一条缝
    <div className="viewer">
      <div className="viewer-head">
        <span className="viewer-title">
          第 {index + 1} 张 · seed {seed}
        </span>
        <span className="grow" />
        <button type="button" className="btn sm" onClick={onClose}>
          关闭
        </button>
      </div>
      <div className="viewer-body">
        <img className="viewer-img" src={client.imageUrl(round.startedAt, file, 'full')} alt={`第 ${index + 1} 张`} />
        <p className="sec">{paramsLine(round.snapshot)}</p>
        <div className="viewer-actions">
          <button type="button" className="btn sm" onClick={apply}>
            {applied ? '已写回手机' : '参数写回手机'}
          </button>
          <button type="button" className="btn sm" onClick={copy}>
            复制正面提示词
          </button>
        </div>
        {fallback !== null && (
          <>
            <p className="hint">这个页面是明文 HTTP 发出来的，浏览器不给复制。长按下面这段自己选。</p>
            {/* readOnly 的 textarea 而不是 <p>：手机上长按输入框会直接给出「全选」，比选段落准得多 */}
            <textarea className="viewer-fallback" value={fallback} readOnly spellCheck={false} />
          </>
        )}
      </div>
    </div>
  )
}
