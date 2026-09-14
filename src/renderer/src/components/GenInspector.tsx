import type { FieldSpec } from '@shared/fields'
import type { ImageRecord, RoundRecord } from '@shared/gen'
import type { Workspace } from '@shared/workspace'

export interface InspectedImage {
  round: RoundRecord
  record: ImageRecord
  url: string
}

interface Props {
  item: InspectedImage
  mainSpecs: readonly FieldSpec[]
  charSpecs: readonly FieldSpec[]
  update: (fn: (draft: Workspace) => void) => void
  onClose: () => void
  onOpenViewer: () => void
  onCopied: () => void
}

/** 溯源信息侧栏。Task 7 实现完整内容 */
export default function GenInspector({ item, onClose, onOpenViewer }: Props): JSX.Element {
  return (
    <aside className="gen-inspector">
      <div className="gen-inspector-header">
        <span>溯源信息</span>
        <button type="button" className="gen-inspector-close" title="关闭详情" onClick={onClose}>
          ×
        </button>
      </div>
      <img className="gen-inspector-preview" src={item.url} alt={`第 ${item.record.index + 1} 张`} onClick={onOpenViewer} />
    </aside>
  )
}
