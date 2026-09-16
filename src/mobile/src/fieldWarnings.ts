// 一个字段值里的「写法问题」清单（计划 Task 12）。
//
// 桌面端把这两类问题做成编辑器里的行内标红（TagTextEditor 的 problemMarks、
// 分块编辑器的 blockCommaHits / blockDigitHits）。手机上没有 CodeMirror，也不该为了
// 标红把整个编辑器搬过来，所以改成「弹层里在输入框下面列一行红字」，判据仍旧复用
// 桌面端那两个纯函数——判据各写一份必然漂移，漂移的表现是「电脑上标红、手机上不标」。
import type { FieldInput } from '@shared/fields'
import { findDigitBeforeClose } from '@renderer/prompt/digitBeforeClose'
import { findFullWidthCommas, fullWidthCommaMessage } from '@renderer/prompt/fullWidthComma'

export interface FieldWarning {
  /** 问题文字在该字段值里的 [from, to)。手机上不画行内高亮，留着是为了将来能定位光标 */
  from: number
  to: number
  /** 能直接显示的中文一句话 */
  message: string
}

/**
 * 列出一个字段值里的全部问题，按出现位置从前往后排。
 *
 * 两类问题的适用范围**不同**，这是这个函数唯一容易写错的地方：
 *   · 数字紧贴 `::`：所有文字字段都查。这个写法在自然语言里同样会被 NAI 误读。
 *   · 全角逗号与顿号：只有 `input === 'tags'` 才查。自然语言字段（nltags、画面文字）
 *     里的中文逗号完全合法，标出来只会变成满屏噪音——与桌面端 `FieldSpec.flagFullWidthComma`
 *     的口径一致（那个字段也正是「input 为 tags 才为 true」）。
 *
 * 这里收 `FieldInput` 而不是整个 `FieldSpec`：角色负面词、整图负面词与画面文字没有
 * 对应的 FieldSpec，但同样要查，调用方直接传 'tags' / 'text' 即可。
 */
export function fieldWarnings(text: string, input: FieldInput): FieldWarning[] {
  const out: FieldWarning[] = [
    ...findDigitBeforeClose(text).map((hit) => ({ from: hit.from, to: hit.to, message: hit.message })),
  ]
  if (input === 'tags') {
    for (const hit of findFullWidthCommas(text)) {
      out.push({ from: hit.from, to: hit.to, message: fullWidthCommaMessage(hit.char) })
    }
  }
  // 两类问题各自有序，合起来就乱了；红字是按行读的，顺序与输入框里从左到右对不上就得让人自己找
  return out.sort((a, b) => a.from - b.from)
}
