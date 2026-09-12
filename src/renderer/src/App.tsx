import { useEffect, useState } from 'react'
import { CHARACTER_FIELDS, MAIN_FIELDS } from '@shared/fields'
import { checkTokenLimit, totalTokens } from '@shared/blockMetrics'
import { tokenLimitFor } from '@renderer/prompt/t5'
import PromptEditor from './editor/PromptEditor'
import { useWorkspace } from './state/workspace'

// 模型选择要到后续计划才有，先钉死在 V5 上把上限跑通
const MODEL = 'nai-diffusion-5-full'

export default function App(): JSX.Element {
  const [version, setVersion] = useState('')
  const main = useWorkspace((s) => s.main)
  const setMain = useWorkspace((s) => s.setMain)
  const character = useWorkspace((s) => s.character)
  const setCharacter = useWorkspace((s) => s.setCharacter)

  useEffect(() => {
    void window.api.appVersion().then(setVersion)
  }, [])

  // TODO(后续计划): 1471 是「base + 全部角色提示词」的合计上限，这里只喂了 main，
  // 角色完全不进预算；且 totalTokens 是分段求和、低估约 9 token（见其 JSDoc）。
  const total = totalTokens(main, MAIN_FIELDS)
  const over = checkTokenLimit(main, MAIN_FIELDS, MODEL)

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-title">llm-nai-toolbox</span>
        {version !== '' && <span className="app-version">v{version}</span>}
      </header>

      <main className="workarea">
        <section className="pane">
          <div className="pane-bar">
            <span className="pane-title">提示词</span>
            <span className="pane-budget">
              合计 <b>{total}</b> / {tokenLimitFor(MODEL)} token
            </span>
          </div>
          <PromptEditor specs={MAIN_FIELDS} values={main} onChange={setMain} />
          {over !== null && (
            <p className="pane-warn" role="alert">
              提示词 {over.total} token 超过上限 {over.limit}，最长的是「{over.longest.name}」
              （{over.longest.tokens} token）。
            </p>
          )}
        </section>

        <section className="pane">
          <div className="pane-bar">
            <span className="pane-title">角色 1</span>
            <span className="pane-budget">
              合计 <b>{totalTokens(character, CHARACTER_FIELDS)}</b> token
            </span>
          </div>
          <PromptEditor specs={CHARACTER_FIELDS} values={character} onChange={setCharacter} />
        </section>
      </main>
    </div>
  )
}
