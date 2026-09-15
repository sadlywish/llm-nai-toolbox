import type { TagGloss } from '@shared/magicbook'

interface Props {
  gloss: TagGloss
  /** 魔法书详情显示「中文说明（与 LLM 工具看到的一致）」；WIKI 竖栏不带标题 */
  title?: string
  /** 魔法书详情显示所属分类；WIKI 竖栏不显示 */
  showCat?: boolean
  /** 点辨析里的对立标签 */
  onTag: (tag: string) => void
}

/** 工具附带的中文说明（tag_gloss.json）：释义、易误读、辨析（界面稿 2026-09-15-magicbook-mockup.html 二、四节） */
export default function GlossCard({ gloss, title, showCat = false, onTag }: Props): JSX.Element {
  return (
    <div className="gloss-card">
      {title !== undefined && <div className="gloss-title">{title}</div>}
      <div className="gloss-main">{gloss.g}</div>
      {gloss.trap !== undefined && (
        <div className="gloss-row is-trap">
          <span className="k">易误读</span>
          <span className="v">{gloss.trap}</span>
        </div>
      )}
      {gloss.vs !== undefined && gloss.vs.length > 0 && (
        <div className="gloss-row">
          <span className="k">辨析</span>
          <div>
            {gloss.vs.map(([tag, why]) => (
              <div key={tag} className="gloss-vs">
                <button type="button" className="wiki-chip" onClick={() => onTag(tag)}>
                  {tag.replace(/_/g, ' ')}
                </button>
                <span>{why}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {showCat && gloss.cat !== undefined && (
        <div className="gloss-row">
          <span className="k">分类</span>
          <span>{gloss.cat.replace('/', ' / ')}</span>
        </div>
      )}
    </div>
  )
}
