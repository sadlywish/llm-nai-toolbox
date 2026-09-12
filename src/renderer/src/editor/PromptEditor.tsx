import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands'
import { keymap } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import { parseDocument, serializeFields, type FieldValues } from '@shared/blockDoc'
import type { FieldSpec } from '@shared/fields'
import { blockExtensions } from './blockExtension'

interface Props {
  /** 字段集。整图传 MAIN_FIELDS，角色传 CHARACTER_FIELDS——组件本身不认识任何一套 */
  specs: readonly FieldSpec[]
  values: FieldValues
  onChange: (values: FieldValues) => void
}

export default function PromptEditor({ specs, values, onChange }: Props): JSX.Element {
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)
  // onChange 每次渲染都是新函数，存进 ref 免得重建整个 EditorView
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

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
          if (!update.docChanged) return
          onChangeRef.current(parseDocument(update.state.doc.toString(), specs))
        }),
        EditorView.theme({ '&': { fontFamily: 'var(--mono)', fontSize: '12.5px' } }),
      ],
    })

    const instance = new EditorView({ state, parent: host.current })
    view.current = instance
    return () => {
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
    })
  }, [values, specs])

  return <div className="prompt-editor" ref={host} />
}
