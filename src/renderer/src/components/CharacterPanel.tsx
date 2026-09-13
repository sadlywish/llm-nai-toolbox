import { useState } from 'react'
import type { FieldSpec } from '@shared/fields'
import { createCharacter, type CharacterPrompt, type Workspace } from '@shared/workspace'
import PromptEditor from '../editor/PromptEditor'
import TagTextEditor from '../editor/TagTextEditor'

interface Props {
  characters: CharacterPrompt[]
  useCoords: boolean
  /** 按 naiCharPromptOrder 排好的角色字段集。⚠️ 引用必须稳定（见 PromptEditor 的 Props） */
  charSpecs: readonly FieldSpec[]
  maxCharacters: number
  update: (fn: (draft: Workspace) => void) => void
}

/**
 * 角色面板，照画师串工具箱的 CharacterRows：页签范式——页签栏选中一个角色，
 * 下面是坐标输入与两个编辑器（正向 / 负面）。角色允许删到 0 个。
 */
export default function CharacterPanel({
  characters,
  useCoords,
  charSpecs,
  maxCharacters,
  update,
}: Props): JSX.Element {
  // 当前打开的是哪个角色：纯界面浏览状态，不写进工作区。
  // 找不到（被删掉、或回填换了一批角色）就退回第一个
  const [activeId, setActiveId] = useState<string | null>(null)
  const active = characters.find((c) => c.id === activeId) ?? characters[0] ?? null
  const full = characters.length >= maxCharacters

  function mutateCharacter(id: string, mutate: (c: CharacterPrompt) => void): void {
    update((ws) => {
      const target = ws.characters.find((c) => c.id === id)
      if (target) mutate(target)
    })
  }

  function addCharacter(): void {
    const c = createCharacter()
    update((ws) => {
      ws.characters.push(c)
    })
    setActiveId(c.id)
  }

  function removeCharacter(id: string): void {
    update((ws) => {
      ws.characters = ws.characters.filter((c) => c.id !== id)
    })
  }

  return (
    <div className="character-panel">
      <div className="character-panel-header">
        <div className="tabs">
          {characters.map((c, index) => (
            <div
              key={c.id}
              className={`tab ${c.id === active?.id ? 'is-active' : ''}`}
              onClick={() => setActiveId(c.id)}
            >
              <input
                type="checkbox"
                checked={c.enabled}
                title="是否参与本轮生成"
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  const checked = e.target.checked
                  mutateCharacter(c.id, (ch) => {
                    ch.enabled = checked
                  })
                }}
              />
              {/* 角色没有名字字段，按数组位置显示「角色 N」——不持久化序号，
                  删除/新增后自然按当前顺序重排，不留不连续的旧编号 */}
              <span className="tab-name">角色 {index + 1}</span>
              <button
                type="button"
                className="tab-close"
                title="删除这个角色"
                onClick={(e) => {
                  e.stopPropagation()
                  removeCharacter(c.id)
                }}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="tab-add"
            disabled={full}
            title={full ? `最多 ${maxCharacters} 个角色（设置 → 多角色与分辨率）` : '新增角色'}
            onClick={addCharacter}
          >
            +
          </button>
        </div>

        <label className="field-check" title="决定角色坐标是否发送给 NovelAI；关闭时由模型安排位置">
          <input
            type="checkbox"
            checked={useCoords}
            onChange={(e) => {
              const checked = e.target.checked
              update((ws) => {
                ws.useCoords = checked
              })
            }}
          />
          使用坐标定位
        </label>
      </div>

      {active === null && <div className="character-empty">没有角色（可选），点上面的 + 添加一个</div>}

      {active !== null && (
        <>
          <div className="character-toolbar">
            <label className="field">
              <span>坐标</span>
              <input
                type="text"
                placeholder="0.3,0.5 或 B3（留空居中）"
                value={active.position}
                onChange={(e) => {
                  const v = e.target.value
                  mutateCharacter(active.id, (ch) => {
                    ch.position = v
                  })
                }}
              />
            </label>
          </div>

          {/* key 必须同时带 id 与 -prompt/-negative 后缀：带 id 是为了切角色时换掉
              CodeMirror 实例与它的 undo 栈（否则在角色 B 按 Ctrl+Z 会把角色 A 的文本
              恢复进 B）；带后缀是为了同一角色下两个兄弟编辑器 key 不撞车——工具箱实测
              撞车的表现是每切一次页签就多叠出一套编辑框 */}
          <div className="character-prompts">
            <PromptEditor
              key={`${active.id}-prompt`}
              specs={charSpecs}
              values={active.fields}
              onChange={(values) =>
                mutateCharacter(active.id, (ch) => {
                  ch.fields = values
                })
              }
            />
            <TagTextEditor
              key={`${active.id}-negative`}
              value={active.negative}
              placeholder="角色负面词"
              onChange={(v) =>
                mutateCharacter(active.id, (ch) => {
                  ch.negative = v
                })
              }
            />
          </div>
        </>
      )}
    </div>
  )
}
