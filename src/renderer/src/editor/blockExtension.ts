import {
  Annotation,
  EditorSelection,
  EditorState,
  type Extension,
  type Transaction,
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  keymap,
} from '@codemirror/view'
import { WEIGHT_STEP } from '@renderer/prompt/weight'
import { buildBlockDecorations } from '@shared/blockDecorations'
import { BLOCK_SEP, isWellFormed, stripSeparators } from '@shared/blockDoc'
import {
  changeTouchesSeparator,
  clampToBlock,
  prefersBackwardAssoc,
  resolveBackspace,
  resolveDelete,
} from '@shared/blockNav'
import { adjustWeightInBlock } from '@shared/blockWeight'
import type { FieldSpec } from '@shared/fields'

/**
 * 标记「这一笔是程序化的整篇回灌」，例如 LLM 把字段写回编辑器。
 *
 * 回灌必然覆盖全部分隔符，会被 guardFilter 的跨段规则判为非法并整笔吞掉——
 * 不报错也不提示，表现是「store 里 values 变了，编辑器画面不动」。
 * 用注解显式放行：回灌写进去的是 serializeFields 的产物，段结构天然合法，
 * 与「用户手动跨段编辑」不是一回事，不该共用同一条禁令。
 */
export const externalSync = Annotation.define<boolean>()

/**
 * 空段的整块。空段一个字符都没有，零长度无法附着 mark，只能整块由 widget 占位。
 * 它只提供带 `data-field` 的外框，徽章由 `.blk-run::before` 画 —— 与非空段
 * 共用同一条 CSS 规则，两条渲染路径只有一种视觉。
 */
class EmptyPillWidget extends WidgetType {
  constructor(
    private readonly field: string,
    private readonly hue: number,
    private readonly active: boolean,
  ) {
    super()
  }

  eq(other: EmptyPillWidget): boolean {
    return other.field === this.field && other.hue === this.hue && other.active === this.active
  }

  toDOM(): HTMLElement {
    const pill = document.createElement('span')
    pill.className = this.active
      ? 'blk-run blk-run-empty blk-active'
      : 'blk-run blk-run-empty'
    pill.setAttribute('data-field', this.field)
    pill.style.setProperty('--h', String(this.hue))
    return pill
  }

  ignoreEvent(): boolean {
    return false
  }
}

/**
 * 段落装饰：一个段渲染成一个框，徽章是框内的 `::before` 伪元素。
 *
 * ── 为什么徽章只能是伪元素 ──────────────────────────────────
 * **widget 在 CodeMirror 里进不了 mark 内部**，两种都实测过：
 *  · 分隔符上的 `Decoration.replace({widget})` → 渲染成 mark 的兄弟节点；
 *  · 段起点、`side: 1` 的 `Decoration.widget` → 同样在 mark 外（实测
 *    `.blk-run` 里查不到 `.blk-badge`，且出现游离徽章）。
 * 伪元素天生在元素内部，是唯一能让框裹住徽章的机制。
 * 代价是它没有 DOM 节点、`getBoundingClientRect` 量不到，所以对齐不能靠调参，
 * 必须靠**构造**保证 —— 见 index.css 里把 line-height 全部写死成像素的理由。
 *
 * 分隔符本身用不带 widget 的 `Decoration.replace({})` 藏掉。
 * active 直接加在 block mark 的 class 上，不另开一层 mark。
 */
function decorationsFor(specs: readonly FieldSpec[], view: EditorView): DecorationSet {
  const doc = view.state.doc.toString()
  // 万一还有漏网的破绽，宁可「装饰暂时不画」，也不要让 parseDocument 抛错
  // 把整个 ViewPlugin 打成永久失活（CodeMirror 捕获后 deactivate 且永不重试）。
  if (!isWellFormed(doc, specs)) return Decoration.none
  const cursor = view.state.selection.main.head
  const decos = buildBlockDecorations(doc, specs, cursor)
  const emptyFields = new Set(decos.filter((d) => d.kind === 'blank').map((d) => d.field))
  const activeFields = new Set(decos.filter((d) => d.kind === 'active').map((d) => d.field))

  const ranges = decos.flatMap((d) => {
    switch (d.kind) {
      case 'badge':
        return [
          emptyFields.has(d.field)
            ? Decoration.replace({
                widget: new EmptyPillWidget(d.field, d.hue, activeFields.has(d.field)),
              }).range(d.from, d.to)
            // 非空段：只把分隔符藏掉，徽章由 .blk-run::before 画在框内
            : Decoration.replace({}).range(d.from, d.to),
        ]
      case 'block':
        // 空段整块由 EmptyPillWidget 画；它的范围是零长度，mark 也构造不出来
        if (emptyFields.has(d.field)) return []
        return [
          Decoration.mark({
            class: activeFields.has(d.field) ? 'blk-run blk-active' : 'blk-run',
            attributes: { style: `--h:${d.hue}`, 'data-field': d.field },
          }).range(d.from, d.to),
        ]
      case 'comma':
        return [Decoration.mark({ class: 'blk-comma' }).range(d.from, d.to)]
      default:
        // 'blank' 与 'active' 只当信号用
        return []
    }
  })
  return Decoration.set(ranges, true)
}

/**
 * 段结构守卫。
 *
 * 两条规则，处理方式**故意不同**：
 *
 * - 改动范围**跨越分隔符** → 整笔拒绝。裁剪的语义（保留哪一段？）没有
 *   唯一正确答案，猜错就是静默改坏用户的内容。「起点为 0」的改动并入这一条：
 *   见 blockDoc.ts 的「位置的几何」，0 不属于任何段，任何从 0 开始的插入
 *   都会把 parts[0] 弄成非空。
 * - 插入的**文本里含分隔符**（从别处粘来的） → 剥掉再插入。这里语义唯一，
 *   拒绝反而是「粘贴毫无反应」这种莫名其妙的表现。
 *
 * 最后无论走哪条路径都要对**最终会写进文档的内容**验一遍 isWellFormed
 * 再放行，当总闸：前两条规则是已知漏洞的针对性修补，未必穷尽了所有能
 * 构造出非法文档的路径（例如 CodeMirror 的 dropText 用 posAtCoords 的
 * 结果直接插入、不做夹逼）。宁可在这里多验一遍，也不要指望「规则列全了」。
 *
 * undo/redo 带 `filter: false` 会绕过这道闸（已核实），但 undo 只会
 * 还原到曾经合法过的文档，不构成缺口。
 */
function guardFilter(specs: readonly FieldSpec[]): Extension {
  return EditorState.transactionFilter.of((tr: Transaction) => {
    if (!tr.docChanged) return tr
    // 程序化回灌显式放行，理由见 externalSync 的说明
    if (tr.annotation(externalSync) === true) return tr

    const doc = tr.startState.doc.toString()
    let crossesBlock = false
    let insertsSep = false
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      // 见 blockDoc.ts 的「位置的几何」：0 在第 0 段徽章之前、不属于任何段，
      // 任何起点为 0 的改动都会把 parts[0] 弄成非空，一律按跨段拒绝。
      // 拖放是唯一能构造出它的路径（dropText 用 posAtCoords 的结果直接插入、不夹逼）。
      if (fromA === 0) crossesBlock = true
      if (changeTouchesSeparator(doc, fromA, toA)) crossesBlock = true
      if (inserted.toString().includes(BLOCK_SEP)) insertsSep = true
    })

    if (crossesBlock) return []

    if (!insertsSep) {
      if (!isWellFormed(tr.newDoc.toString(), specs)) return []
      return tr
    }

    // 重建这笔改动，插入文本剥掉分隔符。不带 selection——长度变了，
    // 原来的选区位置已经对不上，交给 CodeMirror 按新内容自行落点
    const rebuilt: { from: number; to: number; insert: string }[] = []
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      rebuilt.push({ from: fromA, to: toA, insert: stripSeparators(inserted.toString()) })
    })
    // 总闸验的必须是剥离之后的结果——tr.newDoc 是未剥离的版本，验它对不上
    // 真正会写进去的内容。
    const finalDoc = tr.startState.changes(rebuilt).apply(tr.startState.doc).toString()
    if (!isWellFormed(finalDoc, specs)) return []
    return { changes: rebuilt, scrollIntoView: true }
  })
}

/**
 * 光标落在分隔符上时推进段内。
 *
 * 鼠标点在徽章上时 CodeMirror 给出的位置就是分隔符本身，不推的话
 * 接下来第一个字符会插在分隔符前面，落进上一段。
 */
function selectionGuard(specs: readonly FieldSpec[]): Extension {
  return EditorState.transactionFilter.of((tr: Transaction) => {
    if (tr.docChanged || tr.selection === undefined) return tr
    const doc = tr.startState.doc.toString()
    const sel = tr.selection.main
    const anchor = clampToBlock(doc, specs, sel.anchor)
    const head = clampToBlock(doc, specs, sel.head)

    // 光标停在非空段末尾时，显式关联到**前一个**字符。不这么做，CodeMirror 会
    // 向后解析（分隔符被 replace 藏掉、零宽度），把光标画在后一段框的左边缘 ——
    // 表现为「光标从后一个标签往前移，却显示在后一个标签的头部」。
    // 那个位置只有「上一段末尾」一种合理解释，详见 prefersBackwardAssoc。
    if (anchor === head && prefersBackwardAssoc(doc, specs, head)) {
      if (head === sel.head && sel.assoc < 0) return tr
      return [tr, { selection: EditorSelection.cursor(head, -1) }]
    }

    if (anchor === sel.anchor && head === sel.head) return tr
    // 返回 [tr, 修正] 而不是只返回 { selection }：后者会丢掉原事务的
    // effects、annotations 与 userEvent。Plan 2 接上补全之后，被吞掉的
    // 正是补全的 effect，表现是「补全面板莫名其妙不开」。
    // anchor 与 head 分别夹、不塌成单点，否则 Shift 选区会在 clamp 点消失。
    return [tr, { selection: { anchor, head } }]
  })
}

function applyWeight(view: EditorView, specs: readonly FieldSpec[], delta: number): boolean {
  const sel = view.state.selection.main
  const edit = adjustWeightInBlock(view.state.doc.toString(), specs, sel.from, sel.to, delta)
  // 即使没改动也返回 true：按键已被本扩展消费，不该再冒泡去移动光标
  if (edit === null) return true
  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: { anchor: edit.anchor, head: edit.head },
  })
  return true
}

function blockKeymap(specs: readonly FieldSpec[]): Extension {
  return keymap.of([
    {
      key: 'Backspace',
      run: (view) => {
        const doc = view.state.doc.toString()
        const sel = view.state.selection.main
        if (!sel.empty) return false
        const guard = resolveBackspace(doc, sel.head)
        if (guard === null) return false
        if (guard.kind === 'block') return true
        // assoc = -1：落点是上一段的末尾，要画在那一段框内而不是本段框的左边缘
        view.dispatch({ selection: EditorSelection.cursor(guard.to, -1) })
        return true
      },
    },
    {
      key: 'Delete',
      run: (view) => {
        const doc = view.state.doc.toString()
        const sel = view.state.selection.main
        if (!sel.empty) return false
        const guard = resolveDelete(doc, sel.head)
        if (guard === null) return false
        if (guard.kind === 'block') return true
        view.dispatch({ selection: { anchor: guard.to } })
        return true
      },
    },
    // Ctrl 与 Mod 各绑一遍：Mod 在 macOS 上是 Command，Windows 上与 Ctrl 重合，
    // 只绑 Mod 会让 macOS 的 Ctrl+↑ 落空
    { key: 'Ctrl-ArrowUp', run: (v) => applyWeight(v, specs, WEIGHT_STEP), preventDefault: true },
    { key: 'Ctrl-ArrowDown', run: (v) => applyWeight(v, specs, -WEIGHT_STEP), preventDefault: true },
    { key: 'Mod-ArrowUp', run: (v) => applyWeight(v, specs, WEIGHT_STEP), preventDefault: true },
    { key: 'Mod-ArrowDown', run: (v) => applyWeight(v, specs, -WEIGHT_STEP), preventDefault: true },
  ])
}

export function blockExtensions(specs: readonly FieldSpec[]): Extension[] {
  const decoPlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = decorationsFor(specs, view)
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = decorationsFor(specs, update.view)
        }
      }
    },
    { decorations: (v) => v.decorations },
  )

  return [
    guardFilter(specs),
    selectionGuard(specs),
    // 放在 defaultKeymap 之前才能截住 Backspace/Delete；
    // PromptEditor 里的展开顺序保证了这一点
    blockKeymap(specs),
    decoPlugin,
    EditorView.lineWrapping,
  ]
}
