// 工作台：分块提示词的列表与编辑（计划 Task 12，界面稿第二节「方案 A」）。
//
// 这一页只改手机自己那份工作区（state.ts 的防抖存盘），不碰桌面端的 workspace.json——
// 服务端处理手机请求时绝不写工作区（Global Constraints），这边不存就是真丢了。
// 指令区与生成按钮是 Task 14 的事，这里只到提示词为止。
import { useState } from 'react'
import { CHARACTER_FIELDS, MAIN_FIELDS, type FieldInput, type FieldSpec } from '@shared/fields'
import type { MobileMeta } from '@shared/mobileApi'
import { buildPrompt, buildPositivePrompt, hasPromptContent } from '@shared/prompt'
import { createCharacter, type Workspace } from '@shared/workspace'
import { estimateT5Tokens, tokenLimitFor } from '@renderer/prompt/t5'
import BlockRow from '../components/BlockRow'
import EditSheet from '../components/EditSheet'

interface Props {
  workspace: Workspace
  /** 服务端给的字段集（已按 promptOrder 排好）；还没拉到就先用共用默认值把页面撑起来 */
  meta: MobileMeta | null
  onChange: (update: (w: Workspace) => Workspace) => void
}

/**
 * 正在编辑的那一格。
 *
 * 存「怎么读、怎么写」的一对纯函数而不是存值本身：弹层里每敲一个字都要立刻写回工作区，
 * 存值就得在两处之间来回同步，而同步漏一次的表现是「打完字一关弹层内容回退了」。
 * 闭包只捕获角色 id 与字段名这类不会变的东西，捕获不到过期的 workspace。
 */
interface Editing {
  title: string
  input: FieldInput
  options?: readonly string[]
  placeholder?: string
  hint?: string
  read: (w: Workspace) => string
  write: (w: Workspace, v: string) => Workspace
}

const TAGS_HINT = '逗号分隔；1.2::标签:: 是权重写法。'
const TEXT_HINT = '自然语言描述，这里的中文逗号是合法的。'
const POSITION_HINT = '自由坐标 0.3,0.5 或 5×5 网格 B3；留空即居中。'

function hintFor(input: FieldInput): string {
  return input === 'tags' ? TAGS_HINT : TEXT_HINT
}

/** 改一个角色，其余原样带过。整份工作区都按不可变方式更新，React 才认得出变化 */
function patchCharacter(w: Workspace, id: string, patch: (c: Workspace['characters'][number]) => Workspace['characters'][number]): Workspace {
  return { ...w, characters: w.characters.map((c) => (c.id === id ? patch(c) : c)) }
}

function mainEditing(spec: FieldSpec): Editing {
  return {
    title: spec.label,
    input: spec.input,
    options: spec.options,
    hint: hintFor(spec.input),
    read: (w) => w.main[spec.name] ?? '',
    write: (w, v) => ({ ...w, main: { ...w.main, [spec.name]: v } }),
  }
}

function charEditing(id: string, index: number, spec: FieldSpec): Editing {
  return {
    // 带上角色序号：十个块长得一样，只写 `tags` 分不清改的是整图还是第几个角色
    title: `角色 ${index + 1} · ${spec.label}`,
    input: spec.input,
    options: spec.options,
    hint: hintFor(spec.input),
    read: (w) => w.characters.find((c) => c.id === id)?.fields[spec.name] ?? '',
    write: (w, v) => patchCharacter(w, id, (c) => ({ ...c, fields: { ...c.fields, [spec.name]: v } })),
  }
}

/** 顶部那行 token 估算。先拼接再整篇估算，不是各块估算之和——后者漏掉了连接用的 " , " */
function TokenLine({ workspace, specs, charSpecs }: { workspace: Workspace; specs: readonly FieldSpec[]; charSpecs: readonly FieldSpec[] }): JSX.Element {
  const positive = buildPositivePrompt(workspace.main, workspace.text, specs)
  // 角色提示词一起算：V5 的上限是「base 与全部角色提示词合计」（见 t5.ts）。
  // 没参与本轮生成的角色不发出去，也就不占额度
  const charTokens = workspace.characters
    .filter((c) => c.enabled)
    .reduce((n, c) => n + estimateT5Tokens(buildPrompt(c.fields, charSpecs)), 0)
  const total = estimateT5Tokens(positive) + charTokens
  const limit = tokenLimitFor(workspace.params.model)

  if (!hasPromptContent(workspace.main, specs) && total === 0) {
    return <p className="hint">还没写提示词，点下面任意一块开始。</p>
  }
  return (
    <p className={total > limit ? 'tokens over' : 'tokens'}>
      约 {total} token{total > limit && ` · 超出 ${workspace.params.model} 的上限 ${limit}`}
    </p>
  )
}

export default function Workbench({ workspace, meta, onChange }: Props): JSX.Element {
  const [editing, setEditing] = useState<Editing | null>(null)
  /** 当前看的是第几个角色。删到只剩前面几个时下面会夹一次，不单独同步 */
  const [active, setActive] = useState(0)

  const specs = meta?.mainFields ?? MAIN_FIELDS
  const charSpecs = meta?.charFields ?? CHARACTER_FIELDS
  // meta 没拉到时按配置项 naiMaxCharacters 的默认值兜底：宁可先让人加，也不要因为一次
  // 请求没回来就把「添加」锁死
  const maxCharacters = meta?.maxCharacters ?? 22

  const characters = workspace.characters
  const index = Math.min(active, Math.max(0, characters.length - 1))
  const current = characters[index]

  const addCharacter = (): void => {
    // 在更新函数外面造：StrictMode 下更新函数会被跑两遍，写在里面会白白发掉一个 id
    const created = createCharacter()
    onChange((w) => (w.characters.length >= maxCharacters ? w : { ...w, characters: [...w.characters, created] }))
    // 新加的那个一定在末尾，直接切过去——加完还停在旧角色上，人会以为没加上
    setActive(characters.length)
  }

  const removeCurrent = (): void => {
    if (current === undefined) return
    onChange((w) => ({ ...w, characters: w.characters.filter((c) => c.id !== current.id) }))
    setActive(Math.max(0, index - 1))
  }

  return (
    <>
      <TokenLine workspace={workspace} specs={specs} charSpecs={charSpecs} />

      {specs.map((spec) => (
        <BlockRow
          key={spec.name}
          label={spec.label}
          hue={spec.hue}
          value={workspace.main[spec.name] ?? ''}
          onClick={() => setEditing(mainEditing(spec))}
        />
      ))}

      {/* 画面文字不在字段顺序里：它在提示词拼完之后才接到末尾（见 shared/prompt.ts） */}
      <BlockRow
        label="画面文字"
        hue={null}
        value={workspace.text}
        onClick={() =>
          setEditing({
            title: '画面文字',
            input: 'text',
            hint: '图里要出现的文字，留空则自动补 no text。',
            read: (w) => w.text,
            write: (w, v) => ({ ...w, text: v }),
          })
        }
      />
      <BlockRow
        label="负面词"
        hue={null}
        value={workspace.negative}
        onClick={() =>
          setEditing({
            title: '负面词',
            input: 'tags',
            hint: TAGS_HINT,
            read: (w) => w.negative,
            write: (w, v) => ({ ...w, negative: v }),
          })
        }
      />

      <div className="sect">
        <span className="sect-name">角色</span>
        <span className="grow" />
        {current !== undefined && (
          <button type="button" className="btn sm" onClick={removeCurrent}>
            删除本角色
          </button>
        )}
        <button type="button" className="btn sm" disabled={characters.length >= maxCharacters} onClick={addCharacter}>
          + 添加
        </button>
      </div>

      {characters.length === 0 ? (
        <p className="hint">还没有角色。不加角色也能出图，整图提示词里写几个人就是几个人。</p>
      ) : (
        <>
          {/* 角色多了会超出一屏宽：横向滚动的一条页签，比纵向堆十份字段块省得多 */}
          <div className="chips">
            {characters.map((c, i) => (
              <button type="button" key={c.id} className={i === index ? 'chip on' : 'chip'} onClick={() => setActive(i)}>
                角色 {i + 1}
                {c.fields.count !== '' && ` · ${c.fields.count}`}
              </button>
            ))}
          </div>
          {current !== undefined && (
            <>
              {charSpecs.map((spec) => (
                <BlockRow
                  key={spec.name}
                  label={spec.label}
                  hue={spec.hue}
                  value={current.fields[spec.name] ?? ''}
                  onClick={() => setEditing(charEditing(current.id, index, spec))}
                />
              ))}
              <BlockRow
                label="负面词"
                hue={null}
                value={current.negative}
                onClick={() =>
                  setEditing({
                    title: `角色 ${index + 1} · 负面词`,
                    input: 'tags',
                    hint: TAGS_HINT,
                    read: (w) => w.characters.find((c) => c.id === current.id)?.negative ?? '',
                    write: (w, v) => patchCharacter(w, current.id, (c) => ({ ...c, negative: v })),
                  })
                }
              />
              <BlockRow
                label="坐标"
                hue={null}
                value={current.position}
                emptyText="居中"
                onClick={() =>
                  setEditing({
                    title: `角色 ${index + 1} · 坐标`,
                    input: 'text',
                    placeholder: 'B3',
                    hint: POSITION_HINT,
                    read: (w) => w.characters.find((c) => c.id === current.id)?.position ?? '',
                    write: (w, v) => patchCharacter(w, current.id, (c) => ({ ...c, position: v })),
                  })
                }
              />
            </>
          )}
        </>
      )}

      {editing !== null && (
        <EditSheet
          title={editing.title}
          value={editing.read(workspace)}
          input={editing.input}
          options={editing.options}
          placeholder={editing.placeholder}
          hint={editing.hint}
          onChange={(v) => onChange((w) => editing.write(w, v))}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  )
}
