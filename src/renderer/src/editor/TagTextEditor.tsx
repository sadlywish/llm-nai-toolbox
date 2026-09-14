import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { EditorSelection, EditorState } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  placeholder as cmPlaceholder,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { useEffect, useRef } from 'react'
import { completionTargetInText, type CompletionPrefer } from '@shared/blockCompletion'
import { findFullWidthCommas, fullWidthCommaMessage } from '@renderer/prompt/fullWidthComma'
import { WEIGHT_STEP, adjustWeight } from '@renderer/prompt/weight'
import { tagCompletion } from './completion'

interface Props {
  value: string
  onChange: (value: string) => void
  /** 只在创建编辑器时读取一次 */
  placeholder?: string
  /** 补全偏好，只在创建编辑器时读取一次。负面词里写的是通用标签 */
  prefer?: CompletionPrefer
  /** 标红全角逗号与顿号，只在创建编辑器时读取一次。标签串用；自然语言内容不要开 */
  flagFullWidthComma?: boolean
}

/** Ctrl+↑/↓ 调权重。算法与分块编辑器共用 prompt/weight.ts，只是不需要换算段内坐标 */
function weightCommand(delta: number) {
  return (view: EditorView): boolean => {
    const sel = view.state.selection.main
    const r = adjustWeight(view.state.doc.toString(), sel.from, sel.to, delta)
    // 即使没改动也返回 true：按键已被消费，不该再冒泡去移动光标
    if (!r.changed) return true
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: r.text },
      selection: EditorSelection.single(r.selectionStart, r.selectionEnd),
    })
    return true
  }
}

function commaMarks(view: EditorView): DecorationSet {
  return Decoration.set(
    findFullWidthCommas(view.state.doc.toString()).map((hit) =>
      Decoration.mark({ class: 'blk-comma', attributes: { title: fullWidthCommaMessage(hit.char) } }).range(hit.from, hit.to),
    ),
  )
}

/** 全角逗号标红，外观与分块编辑器同一个 .blk-comma 样式 */
const fullWidthCommaPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = commaMarks(view)
    }
    update(update: ViewUpdate): void {
      if (update.docChanged) this.decorations = commaMarks(update.view)
    }
  },
  { decorations: (v) => v.decorations },
)

/**
 * 纯文本的标签编辑器：本地标签补全 + Ctrl+↑/↓ 调权重。
 *
 * 用于整图负面词与角色负面词——对应画师串工具箱里负面词用的那个编辑器。
 * 不是分块文档，没有段结构与守卫。
 */
export default function TagTextEditor({
  value,
  onChange,
  placeholder = '',
  prefer = 'general',
  flagFullWidthComma = false,
}: Props): JSX.Element {
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (host.current === null) return
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        // 排在 defaultKeymap 之前：数组靠前的优先级更高
        keymap.of([
          { key: 'Ctrl-ArrowUp', run: weightCommand(WEIGHT_STEP), preventDefault: true },
          { key: 'Ctrl-ArrowDown', run: weightCommand(-WEIGHT_STEP), preventDefault: true },
          { key: 'Mod-ArrowUp', run: weightCommand(WEIGHT_STEP), preventDefault: true },
          { key: 'Mod-ArrowDown', run: weightCommand(-WEIGHT_STEP), preventDefault: true },
        ]),
        tagCompletion((doc, pos) => completionTargetInText(doc, pos, prefer)),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        ...(flagFullWidthComma ? [fullWidthCommaPlugin] : []),
        cmPlaceholder(placeholder),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString())
        }),
        EditorView.theme({ '&': { fontFamily: 'var(--mono)', fontSize: '14px' } }, { dark: true }),
      ],
    })
    const instance = new EditorView({ state, parent: host.current })
    view.current = instance
    return () => {
      instance.destroy()
      view.current = null
    }
    // 只建一次：value 的后续变化由下面的 effect 同步，prefer 与 placeholder 按约定只读一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 外部改了 value（比如 LLM 回填）时同步进编辑器；自己敲出来的不回灌
  useEffect(() => {
    const instance = view.current
    if (instance === null) return
    if (value === instance.state.doc.toString()) return
    instance.dispatch({ changes: { from: 0, to: instance.state.doc.length, insert: value } })
  }, [value])

  return <div className="prompt-editor tag-text-editor" ref={host} />
}
