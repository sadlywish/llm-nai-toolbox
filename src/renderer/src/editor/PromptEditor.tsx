import { EditorState } from '@codemirror/state'
import { EditorView, drawSelection } from '@codemirror/view'
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands'
import { keymap } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import { parseDocument, serializeFields, type FieldValues } from '@shared/blockDoc'
import type { FieldSpec } from '@shared/fields'
import { blockExtensions, externalSync } from './blockExtension'
import { cursorBus } from './cursorBus'
import { noteEditorFocus, registerEditor, unregisterEditor } from './editorRegistry'

interface Props {
  /** 字段集。整图传 MAIN_FIELDS，角色传 CHARACTER_FIELDS —— 组件本身不认识任何一套。
   *  ⚠️ 必须引用稳定（模块常量或 useMemo 结果）：它是第一个 useEffect 的唯一依赖，
   *  每次渲染换新引用会重建整个 EditorView，光标当场跳回开头。 */
  specs: readonly FieldSpec[]
  values: FieldValues
  onChange: (values: FieldValues) => void
  /** WIKI 栏跟随光标与「加入」用的身份（只给正向提示词编辑器传）；不传 = 不参与 */
  editorId?: string
}

export default function PromptEditor({ specs, values, onChange, editorId }: Props): JSX.Element {
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)
  // onChange 每次渲染都是新函数，存进 ref 免得重建整个 EditorView
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const editorIdRef = useRef(editorId)
  editorIdRef.current = editorId

  useEffect(() => {
    if (host.current === null) return

    const state = EditorState.create({
      doc: serializeFields(values, specs),
      extensions: [
        history(),
        // 分块守卫必须排在 defaultKeymap **之前**。CodeMirror 里数组靠前的
        // 扩展优先级更高，排在后面的话 Backspace 会先被默认处理掉，
        // 分隔符当场被删，段结构破了
        ...blockExtensions(specs),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((update) => {
          const id = editorIdRef.current
          if (id !== undefined) {
            if (update.focusChanged && update.view.hasFocus) noteEditorFocus(id)
            // 先问有没有订阅者：WIKI 栏收起或跟随关闭时这里只是一次布尔判断，不取文档（规格 R2）
            if ((update.selectionSet || update.docChanged) && update.view.hasFocus && cursorBus.active()) {
              cursorBus.emit({ editorId: id, doc: update.state.doc.toString(), specs, head: update.state.selection.main.head })
            }
          }
          if (!update.docChanged) return
          onChangeRef.current(parseDocument(update.state.doc.toString(), specs))
        }),
        // drawSelection() 让 CodeMirror 自己画光标与选区，而不是用浏览器原生的。
        // 这不是锦上添花 —— 本编辑器里分隔符被 replace 藏掉、空段没有任何字符，
        // 那些位置**没有文本节点**可锚定，实测 getSelection().anchorNode 是
        // .cm-content 这个 DIV 本身、光标矩形为 {0,0,0}，于是原生光标会画到
        // 不可预测的地方（实机表现为「跑到最右侧」「有时看不见」）。
        // CodeMirror 用自己的坐标计算定位 .cm-cursor，widget 之间也算得准。
        drawSelection(),
        // 不要再设 .cm-content 的 caret-color：drawSelection 已把原生光标设为
        // 透明，再上色会出现两个光标。
        EditorView.theme(
          {
            '&': { fontFamily: 'var(--mono)', fontSize: '15px' },
            '.cm-cursor, .cm-dropCursor': {
              borderLeftColor: 'var(--accent)',
              borderLeftWidth: '2px',
            },
            '.cm-selectionBackground': { background: 'hsl(212 55% 48% / .38)' },
            '&.cm-focused .cm-selectionBackground': { background: 'hsl(212 60% 52% / .5)' },
          },
          { dark: true },
        ),
      ],
    })

    const instance = new EditorView({ state, parent: host.current })
    view.current = instance
    const id = editorIdRef.current
    if (id !== undefined) registerEditor(id, instance, specs)
    return () => {
      if (id !== undefined) unregisterEditor(id, instance)
      instance.destroy()
      view.current = null
    }
    // 依赖只列 specs：字段集换了要整个重建，而 values 的后续变化由下面那个
    // effect 增量同步。把 values 列进来会让每敲一个字就重建整个 EditorView，
    // 光标当场跳回开头
  }, [specs])

  // 外部改了 values（比如 LLM 回填）时同步进编辑器；自己敲出来的不回灌
  useEffect(() => {
    const instance = view.current
    if (instance === null) return
    const next = serializeFields(values, specs)
    if (next === instance.state.doc.toString()) return
    instance.dispatch({
      changes: { from: 0, to: instance.state.doc.length, insert: next },
      annotations: externalSync.of(true),
    })
  }, [values, specs])

  return <div className="prompt-editor" ref={host} />
}
