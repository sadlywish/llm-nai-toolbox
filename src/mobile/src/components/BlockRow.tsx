// 工作台上的一行一块（界面稿第二节「方案 A」的 .blk）。
//
// 整行就是一个按钮：手机上「点哪儿能编辑」必须一眼看得出来，把徽章与内容做成两个可点区域
// 只会让人反复点错。空块写「空」而不是留白——留白的块看起来像是渲染坏了。
import type { CSSProperties } from 'react'

interface Props {
  /** 徽章上的字。字段块用 FieldSpec.label，其余（画面文字、负面词、坐标）直接给中文 */
  label: string
  /**
   * 徽章底色的色相，取 FieldSpec.hue。
   * null = 没有对应 FieldSpec 的行（画面文字、负面词、坐标），画成中性灰徽章：
   * 给它们编一个色相会让人以为那也是个提示词字段。
   */
  hue: number | null
  value: string
  /** 值为空时显示的字，默认「空」。角色坐标空着是「居中」而不是没填，需要另说一句 */
  emptyText?: string
  /** 不给就是只读的一行（大图的「本工具参数」页）：画成普通块，不是按钮，也不占手指落点的高度 */
  onClick?: () => void
}

export default function BlockRow({ label, hue, value, emptyText = '空', onClick }: Props): JSX.Element {
  // trim 后为空才算空块：判据与 @shared/prompt 的 joinsPrompt 一致，
  // 否则会出现「块里看着有内容、拼接时被跳过」这种对不上
  const empty = value.trim() === ''
  // 界面稿的 .blk i 是 hsl(var(--h) 48% 58%)，文字压深色
  const badge: CSSProperties = hue === null ? {} : { background: `hsl(${hue} 48% 58%)`, color: '#0f1115' }

  const content = (
    <>
      <i className={hue === null ? 'plain' : undefined} style={badge}>
        {label}
      </i>
      <span className={empty ? 'empty' : undefined}>{empty ? emptyText : value}</span>
    </>
  )

  if (onClick === undefined) return <div className="blk is-static">{content}</div>
  return (
    <button type="button" className="blk" onClick={onClick}>
      {content}
    </button>
  )
}
