// 出图页（计划 Task 15，界面稿第三节中间那张）：一条状态、一片结果网格、底下一句存图目录。
//
// 这一页只显示，不判断：格子状态、状态行文字、断线补齐全在 slots.ts 的纯函数里（那几件事判错
// 的代价最大，必须能单独测）。图始终存在电脑上，手机这边只拿缩略图看（规格 §2：手机只看，不下载）。
import { useEffect, useState } from 'react'
import type { GenSnapshot } from '@shared/gen'
import type { MobileMeta } from '@shared/mobileApi'
import type { Workspace } from '@shared/workspace'
import type { ApiClient } from '../api'
import ImageViewer from '../components/ImageViewer'
import { applyRoundToMobile, genStatusText } from '../slots'
import type { GenRunHandle } from '../useGenRun'

interface Props {
  gen: GenRunHandle
  meta: MobileMeta | null
  client: ApiClient
  /** 记录还没拉到时用手机这份的宽高摆格子，免得图一到就整页跳一下 */
  workspace: Workspace
  onWorkspaceChange: (update: (w: Workspace) => Workspace) => void
}

export default function Gen({ gen, meta, client, workspace, onWorkspaceChange }: Props): JSX.Element {
  const [viewIndex, setViewIndex] = useState<number | null>(null)
  const { checkStalled } = gen

  // 进出图页就查一次：断线期间跑完的那一轮，进度事件已经丢了，只能靠历史补齐
  useEffect(() => checkStalled(), [checkStalled])

  const { progress, slots, round } = gen
  const params = round?.snapshot.params ?? workspace.params
  // 格子按真实比例留位，不写死像素：竖图与方图差得很远，先占对位置才不会等图到了整页重排
  const slotStyle = { aspectRatio: `${params.width} / ${params.height}` }

  const viewed = viewIndex === null ? null : slots.find((s) => s.index === viewIndex)
  const applyParams = (snapshot: GenSnapshot, seed: number): void => {
    onWorkspaceChange((w) => applyRoundToMobile(w, snapshot, seed))
  }

  return (
    <div className="gen-page">
      <div className="gen-bar">
        <span className="gen-status">{genStatusText(progress)}</span>
        <span className="grow" />
        {progress?.status === 'paused' && (
          <button type="button" className="btn sm" onClick={gen.resume}>
            继续
          </button>
        )}
        {gen.live && (
          <button type="button" className="btn sm danger" onClick={gen.cancel}>
            取消
          </button>
        )}
      </div>

      {/* 429 暂停的原因必须写出来：不写的话人只看到「已暂停」，不知道是撞上了别的客户端在出图 */}
      {progress?.pauseReason != null && <p className="alert">{progress.pauseReason}</p>}
      {progress?.abortReason != null && <p className="alert">{progress.abortReason}</p>}
      {gen.error !== null && <p className="alert">{gen.error}</p>}

      {progress === null ? (
        <p className="hint">{gen.starting ? '正在让电脑开跑…' : '还没出过图。回工作台点「生成」。'}</p>
      ) : (
        <div className="gen-grid">
          {slots.map((slot) => {
            if (slot.kind === 'ok' && round !== null) {
              return (
                <img
                  key={slot.index}
                  className="gen-slot"
                  style={slotStyle}
                  src={client.imageUrl(round.startedAt, slot.file, 'thumb')}
                  alt={`第 ${slot.index + 1} 张`}
                  loading="lazy"
                  onClick={() => setViewIndex(slot.index)}
                />
              )
            }
            // 出好了但那一轮的记录还没拉到（拼不出图片地址）：占着位置说一句，别画成「等待」
            const text =
              slot.kind === 'ok' ? '已出图' : slot.kind === 'running' ? '生成中' : slot.kind === 'failed' ? slot.reason : ''
            return (
              <div key={slot.index} className={`gen-slot is-${slot.kind}`} style={slotStyle}>
                {text}
              </div>
            )
          })}
        </div>
      )}

      <p className="sec gen-where">
        图存在电脑上{meta === null ? '' : '：'}
        {meta !== null && <code>{meta.saveDirName}</code>}（手机只看，不下载）
      </p>

      {viewed?.kind === 'ok' && round !== null && (
        <ImageViewer
          index={viewed.index}
          file={viewed.file}
          seed={viewed.seed}
          round={round}
          meta={meta}
          client={client}
          onClose={() => setViewIndex(null)}
          onApply={applyParams}
        />
      )}
    </div>
  )
}
