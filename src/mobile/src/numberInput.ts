/**
 * 手机上数字输入框的取值规则。
 *
 * 直接拿 `input.valueAsNumber` 判 `NaN` 就 return 是不行的：受控框会被立刻按回原值，
 * 于是「1」这种一位数的框按退格删不掉，要改成 2 得先打成 12 再删掉 1（用户 2026-09-17 实机反馈）。
 * 所以输入过程中一律先接受文本，只有解析得出合法数字时才写进工作区，失焦时再把半截文本收干净。
 */

export interface NumberRange {
  min?: number
  max?: number
  /** 只收整数（跑图次数、步数、宽高这些） */
  integer?: boolean
}

/** 能写进工作区的值；半截输入（空、`-`、`1.`、越界）返回 null，调用方原样留着文本不写 */
export function parseNumberInput(raw: string, range: NumberRange = {}): number | null {
  const text = raw.trim()
  if (text === '') return null
  // 允许中途出现的写法：-、1.、.5、-.5；它们解析得出数但还没写完，交给 Number 判定
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(text)) return null
  const value = Number(text)
  if (!Number.isFinite(value)) return null
  if (range.integer === true && !Number.isInteger(value)) return null
  if (range.min !== undefined && value < range.min) return null
  if (range.max !== undefined && value > range.max) return null
  return value
}

/** 失焦时用：文本合法就用它，否则退回原值（框里不留半截内容） */
export function settleNumberInput(raw: string, current: number, range: NumberRange = {}): number {
  return parseNumberInput(raw, range) ?? current
}
