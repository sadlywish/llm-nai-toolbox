import type { FieldSpec } from '@shared/fields'
import { buildPositivePrompt, hasPromptContent } from '@shared/prompt'
import type { Workspace } from '@shared/workspace'
import { tokenBudget } from '@renderer/prompt/tokenBudget'
import PromptEditor from '../editor/PromptEditor'
import TagTextEditor from '../editor/TagTextEditor'
import AutoTextarea from './AutoTextarea'
import CharacterPanel from './CharacterPanel'
import CopyButton from './CopyButton'
import GenerateBar from './GenerateBar'
import ParamsPanel from './ParamsPanel'

interface Props {
  workspace: Workspace
  /** 按 promptOrder 排好的整图字段集。⚠️ 引用必须稳定（见 PromptEditor 的 Props） */
  mainSpecs: readonly FieldSpec[]
  /** 按 naiCharPromptOrder 排好的角色字段集。同样要求引用稳定 */
  charSpecs: readonly FieldSpec[]
  /** 角色数上限（设置 naiMaxCharacters） */
  maxCharacters: number
  update: (fn: (draft: Workspace) => void) => void
}

/**
 * 提示词面板。布局照画师串工具箱的例图面板：左 2 份提示词、右 1 份参数。
 *
 * token 合计口径与工具箱一致：正向 + 全部启用角色（NAI 的上限就是这两者合计）。
 * 仍是分段估算之和，低估约每段一个 token，见 blockMetrics.totalTokens 的说明。
 */
export default function PromptPane({
  workspace,
  mainSpecs,
  charSpecs,
  maxCharacters,
  update,
}: Props): JSX.Element {
  const { total, limit, over, longest } = tokenBudget(workspace, mainSpecs, charSpecs)

  return (
    <section className="pane">
      <div className="pane-bar">
        <span className="pane-title">提示词</span>
        <span className="copy-btns">
          <CopyButton
            label="复制正面"
            title="复制正面提示词：各字段按提示词排序拼接，并按画面文字规则处理，与发给 NovelAI 的一致"
            disabled={!hasPromptContent(workspace.main, mainSpecs)}
            getText={() => buildPositivePrompt(workspace.main, workspace.text, mainSpecs)}
          />
          <CopyButton
            label="复制负面"
            title="复制负面词"
            disabled={workspace.negative.trim() === ''}
            getText={() => workspace.negative.trim()}
          />
        </span>
        <span className="pane-budget">
          合计 <b>{total}</b> / {limit} token
        </span>
      </div>

      <div className="prompt-body">
        <div className="prompt-columns">
          <div className="prompt-left">
            <PromptEditor
              specs={mainSpecs}
              values={workspace.main}
              onChange={(values) =>
                update((ws) => {
                  ws.main = values
                })
              }
              editorId="main"
            />

            <label className="field text-row">
              <span>画面文字（text）</span>
              <AutoTextarea
                singleLine
                value={workspace.text}
                placeholder="要画进画面里的文字，留空不加"
                onChange={(v) =>
                  update((ws) => {
                    ws.text = v
                  })
                }
              />
              <span className="field-hint">
                提示词排序里没有它的位置：出图时才按规则接到提示词最末尾（text:…），留空则补 no text
              </span>
            </label>

            <TagTextEditor
              value={workspace.negative}
              placeholder="负面词"
              onChange={(v) =>
                update((ws) => {
                  ws.negative = v
                })
              }
            />

            <div className={`token-bar ${over ? 'is-over' : ''}`}>
              提示词约 {total} token（上限 {limit}，正向 + 全部启用角色合计）
              {over && ' —— 已超限，不会自动截断'}
            </div>
            {longest !== null && (
              <p className="pane-warn" role="alert">
                最长的是「{longest.where}」（{longest.tokens} token）。
              </p>
            )}
          </div>

          <div className="params-column">
            <GenerateBar workspace={workspace} mainSpecs={mainSpecs} charSpecs={charSpecs} update={update} />
            <ParamsPanel params={workspace.params} onChange={(mutate) => update((ws) => mutate(ws.params))} />
          </div>
        </div>

        <CharacterPanel
          characters={workspace.characters}
          useCoords={workspace.useCoords}
          charSpecs={charSpecs}
          maxCharacters={maxCharacters}
          update={update}
        />
      </div>
    </section>
  )
}
