import { Annotation, EditorState, type Extension, type Transaction } from '@codemirror/state'
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
import { changeTouchesSeparator, clampToBlock, resolveBackspace, resolveDelete } from '@shared/blockNav'
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

/**
 * 空段的可点占位。空段没有任何字符，mark 无从附着，只能用 widget 占位。
 *
 * 视觉上它是「徽章 + 框」这个整体的右半边：与徽章边缘相接、共用一圈圆角，
 * 详见 index.css 里 .blk-badge / .blk-run / .blk-blank 的注释。
 *
 * active 由它自己画：空段的 active 是零长度 mark，构造不出来。
 */
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

  // 必须放行事件：这个 widget 存在的唯一理由就是让零宽度的空段可点。
  // WidgetType.ignoreEvent 默认为 true，而 eventBelongsToEditor 遇到它为真
  // 就直接 return false，CodeMirror 自己的 pointer 逻辑根本不跑。
  ignoreEvent(): boolean {
    return false
  }
}

/**
 * 段落装饰。
 *
 * ── 为什么徽章在框外，而不是被框裹住 ────────────────────────
 * 定稿示意稿里徽章是包在框里的，实现上做不到：徽章是分隔符上的
 * `Decoration.replace`，而 `Decoration.mark` **不会**把一段被 replace
 * 完全覆盖的范围裹起来——空段的 mark 范围恰好等于 replace 的范围，
 * 于是 mark 被整个吞掉，框压根不渲染（实测空状态下 .blk-run 数量为 0）。
 *
 * 所以改由 CSS 达到同样的视觉：徽章与框**边缘相接、共用一圈圆角**，
 * 读起来是一个整体色块。间距加在框的右侧而不是徽章右侧——加在徽章右侧
 * 会让框紧贴下一个徽章、被视觉上归进下一组。
 */
function decorationsFor(specs: readonly FieldSpec[], view: EditorView): DecorationSet {
  const doc = view.state.doc.toString()
  // 万一还有漏网的破绽，宁可「装饰暂时不画」，也不要让 parseDocument 抛错
  // 把整个 ViewPlugin 打成永久失活（CodeMirror 捕获后 deactivate 且永不重试）。
  if (!isWellFormed(doc, specs)) return Decoration.none
  const cursor = view.state.selection.main.head
  const decos = buildBlockDecorations(doc, specs, cursor)
  // 空段的 active 是零长度 mark，根本构造不出来；先把区间记下来交给 BlankWidget 自己画
  const activeAt = new Set(
    decos.filter((d) => d.kind === 'active').map((d) => `${d.from}:${d.to}`),
  )
  const ranges = decos
    // 零长度的 mark 必须在 .range() **调用之前**滤掉。
    // Decoration.mark(...).range(from, to) 在 from >= to 时当场抛 RangeError，
    // 不是留到 Decoration.set() 阶段再筛——事后过滤是死代码。
    // 而 ViewPlugin 崩一次就被 deactivate 且永不重试，整个装饰系统永久失效。
    .filter((d) => !(d.from === d.to && (d.kind === 'block' || d.kind === 'active')))
    .map((d) => {
      switch (d.kind) {
        case 'badge':
          return Decoration.replace({ widget: new BadgeWidget(d.label, d.hue) }).range(d.from, d.to)
        case 'block':
          return Decoration.mark({
            class: 'blk-run',
            attributes: { style: `--h:${d.hue}`, 'data-field': d.field },
          }).range(d.from, d.to)
        case 'blank':
          return Decoration.widget({
            widget: new BlankWidget(d.hue, activeAt.has(`${d.from}:${d.to}`)),
            side: 1,
          }).range(d.from)
        case 'active':
          // 带上 --h：.blk-active 自己没有这个变量，靠继承会在装饰顺序变动时静默失效
          return Decoration.mark({
            class: 'blk-active',
            attributes: { style: `--h:${d.hue}` },
          }).range(d.from, d.to)
        case 'comma':
          return Decoration.mark({ class: 'blk-comma' }).range(d.from, d.to)
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
    guardFilter(specs),
    selectionGuard(specs),
    // 放在 defaultKeymap 之前才能截住 Backspace/Delete；
    // PromptEditor 里的展开顺序保证了这一点
    blockKeymap(specs),
    decoPlugin,
    EditorView.lineWrapping,
  ]
}
