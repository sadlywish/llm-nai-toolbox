import { Annotation, EditorState, type Extension, type Range, type Transaction } from '@codemirror/state'
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
import { type FieldLayout, buildBlockLayout } from '@shared/blockDecorations'
import { BLOCK_SEP, isWellFormed, sanitizeFieldText } from '@shared/blockDoc'
import {
  changeTouchesSeparator,
  clampToBlock,
  resolveBackspace,
  resolveDelete,
} from '@shared/blockNav'
import { adjustWeightInBlock } from '@shared/blockWeight'
import type { FieldSpec } from '@shared/fields'
import { localTagCompletion } from './completion'

/**
 * 标记「这一笔是程序化的整篇回灌」，例如 LLM 把字段写回编辑器。
 *
 * 回灌必然覆盖全部分隔符，会被 guardFilter 的跨段规则判为非法并整笔吞掉——
 * 不报错也不提示，表现是「store 里 values 变了，编辑器画面不动」。
 * 用注解显式放行：这样做是安全的，不是因为段数对得上就够了，而是因为回灌
 * 写进去的内容出自 `serializeFields`——它用 `sanitizeFieldText` 净化过
 * 每个字段值，分隔符与换行都已经被剥掉，与「用户手动跨段编辑」（两者都可能
 * 混进去）不是一回事，不该共用同一条禁令。
 */
export const externalSync = Annotation.define<boolean>()

/*
 * ── 版面 ──────────────────────────────────────────────────────
 * 整个编辑器排成一段连续的文字，折行规则照静态演示稿 docs/block-editor-preview.html：
 * 每行从同一个左缘开始；块内文字折行时续行贴左缘、框在折行处开口；徽章贴着首词，
 * 放不下时一起换行；块与块之间隔一个空格，行首不占位；空块整块不拆。
 * 块的先后与拼接顺序一致，非空块后面画一个不可编辑的 ` ,`，框里看到的与 buildPrompt
 * 的结果逐字对应。tags 形态的字段只在逗号之后折行，一个标签不拆开。
 *
 * 一个非空段渲染成（由外到内）：
 *   .blk-grp        拼接逗号与块间空格，画在 ::after
 *     .blk-run      框与徽章，徽章画在 ::before
 *       .blk-tag    一个标签连同它的逗号，nowrap
 *         .blk-comma  全角逗号标红
 *         .blk-digit  标签末尾数字紧贴 :: 标红，悬停出提示（与 .blk-comma 同一套样式）
 * 空段没有字符可附着 mark，由它前面那个分隔符上的 SeparatorWidget 画空框。
 */

/**
 * 四层装饰，**每层一个独立来源**，嵌套顺序由来源优先级钉死。
 *
 * 不能放进同一个 DecorationSet：同一来源里 CodeMirror 只按范围长短决定内外，
 * **范围相同时谁在外没有保证**。实测「多」+ 空格 + 「m」：打 m 之前标签「多」比框短、
 * 在里层；打 m 之后标签变成整个「多 m」、与框等长，增量更新时旧片段保持框在外、
 * 新片段却建成标签在外，框被拆成两段 —— 每段各画一个 ::before 徽章。
 * 分到不同来源后，按 CodeMirror 文档「优先级高的在里层」排，与范围长短无关。
 *
 * ⚠️ 以后再加任何 mark 装饰（搜索高亮之类），优先级必须高于 run 层，否则框会在它的
 * 边界上被拆开，同样出现重复徽章。
 */
interface Layers {
  grp: DecorationSet
  run: DecorationSet
  tag: DecorationSet
  err: DecorationSet
}

const NO_LAYERS: Layers = {
  grp: Decoration.none,
  run: Decoration.none,
  tag: Decoration.none,
  err: Decoration.none,
}

type Rect = { left: number; right: number; top: number; bottom: number }

/** 跳过 CodeMirror 插在 widget 两侧的零宽 `<img class="cm-widgetBuffer">` */
function neighbor(dom: HTMLElement, dir: -1 | 1): Element | null {
  let n = dir < 0 ? dom.previousElementSibling : dom.nextElementSibling
  while (n !== null && n.classList.contains('cm-widgetBuffer')) {
    n = dir < 0 ? n.previousElementSibling : n.nextElementSibling
  }
  return n
}

/** 空框里的光标位置：徽章之后、右内边距之前 */
function pillCaret(pill: HTMLElement): Rect {
  const r = pill.getBoundingClientRect()
  const x = r.right - parseFloat(getComputedStyle(pill).paddingRight)
  return { left: x, right: x, top: r.top + 3, bottom: r.bottom - 3 }
}

/** 框内第一个字的左缘或最后一个字的右缘 */
function textEdge(run: Element, atEnd: boolean): Rect | null {
  const walker = document.createTreeWalker(run, NodeFilter.SHOW_TEXT)
  let first: Text | null = null
  let last: Text | null = null
  let n: Node | null
  while ((n = walker.nextNode()) !== null) {
    if (!n.textContent) continue
    first ??= n as Text
    last = n as Text
  }
  const node = atEnd ? last : first
  if (node === null) return null
  const len = node.data.length
  const range = document.createRange()
  range.setStart(node, atEnd ? len - 1 : 0)
  range.setEnd(node, atEnd ? len : 1)
  const rects = range.getClientRects()
  const r = atEnd ? rects[rects.length - 1] : rects[0]
  if (r === undefined) return null
  const x = atEnd ? r.right : r.left
  return { left: x, right: x, top: r.top, bottom: r.bottom }
}

interface PillSpec {
  field: string
  hue: number
  active: boolean
}

/**
 * 分隔符上的 widget。该段为空时画空框，空框后面带一个块间空格；非空段时是个空 span，
 * 只为了给光标提供坐标（见 coordsAt）。
 *
 * 非空块的块间空格与拼接逗号**不在这里**，而在外层 `.blk-grp` 的 ::after。
 * 要和前一块粘在一起的东西都不能放进 widget：CodeMirror 在每个 widget 两侧插零宽
 * `<img class="cm-widgetBuffer">`，浏览器允许在图片旁折行。实测放在 widget 里时，
 * 123 档窗口宽度中 24 档把逗号折到行首、9 档把空格折到行首。
 * 同理，空框的空格放在框**后面**、同一元素内，折点才一定在空格之后，空格悬挂在行尾。
 */
class SeparatorWidget extends WidgetType {
  constructor(private readonly pill: PillSpec | null) {
    super()
  }

  eq(other: SeparatorWidget): boolean {
    return (
      other.pill?.field === this.pill?.field &&
      other.pill?.hue === this.pill?.hue &&
      other.pill?.active === this.pill?.active
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'blk-sep'
    if (this.pill === null) return wrap

    const pill = document.createElement('span')
    pill.className = this.pill.active ? 'blk-run blk-run-empty blk-active' : 'blk-run blk-run-empty'
    pill.setAttribute('data-field', this.pill.field)
    pill.style.setProperty('--h', String(this.pill.hue))
    wrap.append(pill, document.createTextNode(' '))

    // 点空框（含它后面的空格）→ 进入这个空段。交给 CodeMirror 的话，它按点在
    // widget 左半还是右半决定落点，点框中间会落到前一段末尾。
    wrap.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      const pos = view.posAtDOM(wrap) + 1
      view.focus()
      view.dispatch({
        selection: { anchor: e.shiftKey ? view.state.selection.main.anchor : pos, head: pos },
      })
    })
    return wrap
  }

  /**
   * 按位置的语义给光标坐标，不让 CodeMirror 自己推。
   *
   * 本 widget 占第 i 段的分隔符，两侧位置的含义是固定的（见 blockDoc.ts「位置的几何」）：
   *   pos 0 = 第 i-1 段内容的末尾；pos 1 = 第 i 段内容的起点。
   * CodeMirror 的默认做法是取 widget 的边缘，光标会落在前一框右内边距之外、
   * 或后一框徽章之前。靠 `selection.assoc` 改不过来：不是每条路径都带得上 assoc，
   * 这里按位置语义直接给坐标，就与 assoc 无关。
   */
  coordsAt(dom: HTMLElement, pos: number): Rect | null {
    if (pos === 0) {
      const prev = neighbor(dom, -1)
      if (prev === null) return null
      if (prev.classList.contains('blk-grp')) {
        const run = prev.querySelector('.blk-run')
        return run === null ? null : textEdge(run, true)
      }
      const pill = prev.querySelector('.blk-run-empty')
      return pill === null ? null : pillCaret(pill as HTMLElement)
    }
    if (this.pill !== null) {
      const pill = dom.querySelector('.blk-run-empty')
      return pill === null ? null : pillCaret(pill as HTMLElement)
    }
    const next = neighbor(dom, 1)
    const run = next?.classList.contains('blk-grp') ? next.querySelector('.blk-run') : null
    return run == null ? null : textEdge(run, false)
  }

  ignoreEvent(e: Event): boolean {
    // 空框的 mousedown 由上面自己的监听处理，编辑器不要再按自己的规则落一次点
    return e.type === 'mousedown' && this.pill !== null
  }
}

/**
 * 点在拼接逗号上 → 落到它前面那一块的末尾。
 *
 * 逗号是 `.blk-grp::after`，伪元素没有节点，点中时事件目标就是 `.blk-grp` 本身
 * （点中框里文字时目标是 `.blk-run` 或更里层）。不处理的话 CodeMirror 按坐标
 * 就近取位置，实测会落在最后一个字**之前**。
 */
const joinCommaClick = EditorView.domEventHandlers({
  mousedown(e, view) {
    const t = e.target
    if (e.button !== 0 || !(t instanceof HTMLElement) || !t.classList.contains('blk-grp')) {
      return false
    }
    e.preventDefault()
    const pos = view.posAtDOM(t, t.childNodes.length)
    view.focus()
    view.dispatch({
      selection: { anchor: e.shiftKey ? view.state.selection.main.anchor : pos, head: pos },
    })
    return true
  },
})

/**
 * 徽章宽度估算，用于判断「首个标签连同徽章放不放得下一行」。
 * 与 index.css 的 `.blk-run::before` 对应：12px 等宽粗体约 7.3px/字（含 .02em 字距），
 * 左右内边距各 6、右外边距 7，加上框的左内边距 4。改那边的数值要跟着改这里。
 */
const BADGE_CHAR_PX = 7.3
const BADGE_EXTRA_PX = 6 + 6 + 7 + 4

/** 一行能放下的内容宽度（px）。编辑器首次构造时 DOM 还没排版，得到 0 */
function lineContentWidth(view: EditorView): number {
  const line = view.contentDOM.querySelector('.cm-line')
  if (line === null) return 0
  const cs = getComputedStyle(line)
  return line.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
}

/**
 * 标签级折行的 mark（切分见 shared/tagWrap.ts）。
 *
 *  · `.blk-tag`（nowrap）包住**整个标签连同它的逗号**。只包标签里的空格不行：CSS 规定
 *    两个字符之间能不能折，由它们的最近公共祖先决定，空格两侧的字还在外面就照样能折。
 *    逗号也要包进去：Chrome 在 nowrap 元素的边界处给折行机会，边界落在逗号之前时，
 *    实测出现过 `upper_body` ⏎ `,from_side`。
 *  · `.blk-brk` 在逗号后面补一个零宽空格，给 `1girl,solo` 这种写法造折行点。当前的
 *    Chromium 在 nowrap 边界上本来就会折，实测去掉也不影响；保留是为了不依赖那条
 *    非标准行为。
 *  · 比一整行还宽的标签不包 nowrap，否则只能横向溢出。首个标签要算上粘在它前面的徽章，
 *    末个标签要算上粘在它后面的拼接逗号 ` ,`。
 *
 * 行宽一变，这里的结论就可能变，所以插件在 geometryChanged 时也要重算。
 */
function tagMarks(field: FieldLayout, view: EditorView, lineWidth: number): Range<Decoration>[] {
  const charPx = view.defaultCharacterWidth
  const badgePx = field.label.length * BADGE_CHAR_PX + BADGE_EXTRA_PX
  const tailPx = 2 * charPx
  const out: Range<Decoration>[] = []
  for (const tag of field.tags) {
    const px =
      tag.units * charPx +
      (tag.from === field.from ? badgePx : 0) +
      (tag.to === field.to ? tailPx : 0)
    const classes = [px <= lineWidth ? 'blk-tag' : '', tag.needsBreak ? 'blk-brk' : '']
      .filter(Boolean)
      .join(' ')
    if (classes !== '') out.push(Decoration.mark({ class: classes }).range(tag.from, tag.to))
  }
  return out
}

function decorationsFor(specs: readonly FieldSpec[], view: EditorView): Layers {
  const doc = view.state.doc.toString()
  // 万一还有漏网的破绽，宁可「装饰暂时不画」，也不要让 parseDocument 抛错
  // 把整个 ViewPlugin 打成永久失活（CodeMirror 捕获后 deactivate 且永不重试）。
  if (!isWellFormed(doc, specs)) return NO_LAYERS
  const layout = buildBlockLayout(doc, specs, view.state.selection.main.head)
  const lineWidth = lineContentWidth(view)

  const grp: Range<Decoration>[] = []
  const run: Range<Decoration>[] = []
  const tag: Range<Decoration>[] = []
  for (const f of layout.fields) {
    if (f.empty) {
      const pill = { field: f.field, hue: f.hue, active: f.active }
      run.push(Decoration.replace({ widget: new SeparatorWidget(pill) }).range(f.sepAt, f.from))
      continue
    }
    // 位置 0 不属于任何段（见 blockDoc.ts），首段的分隔符两侧没有需要特殊处理的光标位置
    run.push(
      f.index === 0
        ? Decoration.replace({}).range(f.sepAt, f.from)
        : Decoration.replace({ widget: new SeparatorWidget(null) }).range(f.sepAt, f.from),
    )
    grp.push(
      Decoration.mark({ class: f.joined ? 'blk-grp blk-grp-joined' : 'blk-grp' }).range(f.from, f.to),
    )
    run.push(
      Decoration.mark({
        class: f.active ? 'blk-run blk-active' : 'blk-run',
        attributes: { style: `--h:${f.hue}`, 'data-field': f.field },
      }).range(f.from, f.to),
    )
    tag.push(...tagMarks(f, view, lineWidth))
  }
  const err = [
    ...layout.commaHits.map((hit) => Decoration.mark({ class: 'blk-comma' }).range(hit.from, hit.to)),
    ...layout.digitHits.map((hit) =>
      Decoration.mark({ class: 'blk-digit', attributes: { title: hit.message } }).range(hit.from, hit.to),
    ),
  ]
  return {
    grp: Decoration.set(grp, true),
    run: Decoration.set(run, true),
    tag: Decoration.set(tag, true),
    err: Decoration.set(err, true),
  }
}

/**
 * 段结构守卫。
 *
 * 三条规则，处理方式**故意不同**：
 *
 * - 改动范围**跨越分隔符** → 整笔拒绝。裁剪的语义（保留哪一段？）没有
 *   唯一正确答案，猜错就是静默改坏用户的内容。「起点为 0」的改动并入这一条：
 *   见 blockDoc.ts 的「位置的几何」，0 不属于任何段，任何从 0 开始的插入
 *   都会把 parts[0] 弄成非空。
 * - 插入的**文本里含分隔符**（从别处粘来的） → 剥掉再插入。这里语义唯一，
 *   拒绝反而是「粘贴毫无反应」这种莫名其妙的表现。
 * - 插入的**文本里含换行**（Enter、多行粘贴/拖放/程序化插入） → 同上一条
 *   一起走剥离分支。Enter 走 defaultKeymap 的 insertNewlineAndIndent，
 *   产生的仍是一笔普通事务，会照样经过这里；多行粘贴此前会落进「不含分
 *   隔符」分支里被直接放行——`\n` 不影响 isWellFormed（分段计数不看换行），
 *   于是换行被无声吞进段内容，这是本函数曾经的一个漏洞。
 *
 * 最后无论走哪条路径都要对**最终会写进文档的内容**验一遍 isWellFormed
 * 再放行，当总闸：前面的规则是已知漏洞的针对性修补，未必穷尽了所有能
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
    let needsStrip = false
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      // 见 blockDoc.ts 的「位置的几何」：0 在第 0 段徽章之前、不属于任何段，
      // 任何起点为 0 的改动都会把 parts[0] 弄成非空，一律按跨段拒绝。
      // 拖放是唯一能构造出它的路径（dropText 用 posAtCoords 的结果直接插入、不夹逼）。
      if (fromA === 0) crossesBlock = true
      if (changeTouchesSeparator(doc, fromA, toA)) crossesBlock = true
      const text = inserted.toString()
      if (text.includes(BLOCK_SEP) || /[\r\n]/.test(text)) needsStrip = true
    })

    if (crossesBlock) return []

    if (!needsStrip) {
      if (!isWellFormed(tr.newDoc.toString(), specs)) return []
      return tr
    }

    // 重建这笔改动，插入文本剥掉分隔符与换行（sanitizeFieldText，与
    // serializeFields 共用同一把净化函数——见 blockDoc.ts 的说明）。
    // 不带 selection——长度变了，原来的选区位置已经对不上，交给 CodeMirror
    // 按新内容自行落点
    const rebuilt: { from: number; to: number; insert: string }[] = []
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      rebuilt.push({ from: fromA, to: toA, insert: sanitizeFieldText(inserted.toString()) })
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
 *
 * 光标画在哪里不归这里管，见 SeparatorWidget.coordsAt。
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
      layers: Layers

      constructor(view: EditorView) {
        this.layers = decorationsFor(specs, view)
      }

      update(update: ViewUpdate): void {
        // geometryChanged：行宽变了，「哪些标签比一整行还宽」要重算（见 tagMarks）
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          update.geometryChanged
        ) {
          this.layers = decorationsFor(specs, update.view)
        }
      }
    },
  )
  const layer = (name: keyof Layers): Extension =>
    EditorView.decorations.of((view) => view.plugin(decoPlugin)?.layers[name] ?? Decoration.none)

  return [
    guardFilter(specs),
    selectionGuard(specs),
    // 放在 defaultKeymap 之前才能截住 Backspace/Delete；
    // PromptEditor 里的展开顺序保证了这一点
    blockKeymap(specs),
    decoPlugin,
    // ⚠️ 顺序即优先级，**是承重的**：排在前面的优先级高、渲染在里层。见 Layers 的说明
    layer('err'),
    layer('tag'),
    layer('run'),
    layer('grp'),
    joinCommaClick,
    // 补全的键位（方向键/回车/Esc）不靠这里的数组位置：`autocompletion()` 把
    // 自己的 keymap 包在 `Prec.highest` 里，优先级与扩展顺序无关，且那些绑定
    // 只在下拉激活时生效，不会抢走没弹下拉时的按键。放在这里纯粹是为了读起来
    // 顺——挪走也不会改变行为。
    //
    // ⚠️ 别把这条和上面 blockKeymap 的顺序混为一谈：**那一条是承重的**。
    // blockKeymap 必须排在 defaultKeymap 之前才能截住 Backspace/Delete，
    // 靠的是 PromptEditor 里 blockExtensions(specs) 展开在 keymap 之前。
    localTagCompletion(specs),
    EditorView.lineWrapping,
  ]
}
