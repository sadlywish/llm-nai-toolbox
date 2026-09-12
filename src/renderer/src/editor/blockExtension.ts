import { EditorState, type Extension, type Transaction } from '@codemirror/state'
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
import { BLOCK_SEP, stripSeparators } from '@shared/blockDoc'
import { changeTouchesSeparator, clampToBlock, resolveBackspace, resolveDelete } from '@shared/blockNav'
import { adjustWeightInBlock } from '@shared/blockWeight'
import type { FieldSpec } from '@shared/fields'

/** 字段徽章。整块替换掉分隔符那一个字符，所以分隔符本身永远不可见 */
class BadgeWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly hue: number,
  ) {
    super()
  }

  // CodeMirror 会拿它决定能否复用已有 DOM。不实现的话每次更新都重建全部徽章
  eq(other: BadgeWidget): boolean {
    return other.label === this.label && other.hue === this.hue
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'blk-badge'
    el.textContent = this.label
    el.style.setProperty('--h', String(this.hue))
    return el
  }

  ignoreEvent(): boolean {
    return false
  }
}

/** 空段的可点占位。没有它，空段在屏幕上是零宽度，点不中。
 *  active 由它自己画——空段的 active 是零长度 mark，会被 decorationsFor 的
 *  过滤丢掉，不在这里补就没有任何聚焦反馈 */
class BlankWidget extends WidgetType {
  constructor(
    private readonly hue: number,
    private readonly active: boolean,
  ) {
    super()
  }

  eq(other: BlankWidget): boolean {
    return other.hue === this.hue && other.active === this.active
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = this.active ? 'blk-blank blk-blank-active' : 'blk-blank'
    el.style.setProperty('--h', String(this.hue))
    return el
  }
}

function decorationsFor(specs: readonly FieldSpec[], view: EditorView): DecorationSet {
  const doc = view.state.doc.toString()
  const cursor = view.state.selection.main.head
  const decos = buildBlockDecorations(doc, specs, cursor)
  // 空段的 active 是零长度 mark，会被下面的过滤丢掉；先把区间记下来交给 BlankWidget
  const activeAt = new Set(
    decos.filter((d) => d.kind === 'active').map((d) => `${d.from}:${d.to}`),
  )
  const ranges = decos.map((d) => {
    switch (d.kind) {
      case 'badge':
        return Decoration.replace({ widget: new BadgeWidget(d.label, d.hue) }).range(d.from, d.to)
      case 'block':
        return Decoration.mark({
          class: 'blk-run',
          attributes: { style: `--h:${d.hue}`, 'data-field': d.field },
        }).range(d.from, d.to)
      case 'blank':
        // 空段没有字符可 mark，只能用 widget 占一个可点的空位
        return Decoration.widget({
          widget: new BlankWidget(d.hue, activeAt.has(`${d.from}:${d.to}`)),
          side: 1,
        }).range(d.from)
      case 'active':
        return Decoration.mark({ class: 'blk-active' }).range(d.from, d.to)
      case 'comma':
        return Decoration.mark({ class: 'blk-comma' }).range(d.from, d.to)
    }
  })
  // 零长度的 mark 会被 CodeMirror 拒绝，先滤掉
  return Decoration.set(
    ranges.filter((r) => r.from !== r.to || r.value.spec.widget !== undefined),
    true,
  )
}

/**
 * 段结构守卫。
 *
 * 两条规则，处理方式**故意不同**：
 *
 * - 改动范围**跨越分隔符** → 整笔拒绝。裁剪的语义（保留哪一段？）没有
 *   唯一正确答案，猜错就是静默改坏用户的内容。
 * - 插入的**文本里含分隔符**（从别处粘来的） → 剥掉再插入。这里语义唯一，
 *   拒绝反而是「粘贴毫无反应」这种莫名其妙的表现。
 */
function guardFilter(): Extension {
  return EditorState.transactionFilter.of((tr: Transaction) => {
    if (!tr.docChanged) return tr

    const doc = tr.startState.doc.toString()
    let crossesBlock = false
    let insertsSep = false
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      if (changeTouchesSeparator(doc, fromA, toA)) crossesBlock = true
      if (inserted.toString().includes(BLOCK_SEP)) insertsSep = true
    })

    if (crossesBlock) return []
    if (!insertsSep) return tr

    // 重建这笔改动，插入文本剥掉分隔符。不带 selection——长度变了，
    // 原来的选区位置已经对不上，交给 CodeMirror 按新内容自行落点
    const rebuilt: { from: number; to: number; insert: string }[] = []
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      rebuilt.push({ from: fromA, to: toA, insert: stripSeparators(inserted.toString()) })
    })
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
    const head = tr.selection.main.head
    const clamped = clampToBlock(doc, specs, head)
    if (clamped === head) return tr
    // 这笔事务只改选区（上面已排除 docChanged），整笔换成落点修正后的版本
    return { selection: { anchor: clamped }, scrollIntoView: true }
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
        view.dispatch({ selection: { anchor: guard.to } })
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
    guardFilter(),
    selectionGuard(specs),
    // 放在 defaultKeymap 之前才能截住 Backspace/Delete；
    // PromptEditor 里的展开顺序保证了这一点
    blockKeymap(specs),
    decoPlugin,
    EditorView.lineWrapping,
  ]
}
