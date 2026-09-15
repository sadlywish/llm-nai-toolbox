import { newId } from './ids'

/**
 * 画风预设：名称 + 一串画风标签。画风维护里「选为预设画风」的那条，在指令区画风档位是
 * 「用预设画风覆盖」时收口后覆盖 artist（规格 §8）。存 styles.json（数组顺序即列表顺序），
 * 在画风维护视图里改动即保存。
 */
export interface StylePreset {
  id: string
  name: string
  tags: string
}

export const UNNAMED_STYLE = '未命名画风'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function cleanName(v: unknown): string {
  const name = typeof v === 'string' ? v.replace(/[\r\n]+/g, '').trim() : ''
  return name === '' ? UNNAMED_STYLE : name
}

/**
 * 读回的 styles.json 自愈。任何来源都先过这里。
 * 重复或缺失的 id 补新的：重复 id 会让两个页签共用一个编辑器实例与撤销栈。
 * 重名不在这里处理——那是手改文件造成的，界面上改名时会拦下，不在读取时悄悄改名字。
 */
export function normalizeStyles(raw: unknown): StylePreset[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: StylePreset[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    let id = typeof item.id === 'string' && item.id !== '' ? item.id : newId('st')
    if (seen.has(id)) id = newId('st')
    seen.add(id)
    out.push({ id, name: cleanName(item.name), tags: typeof item.tags === 'string' ? item.tags : '' })
  }
  return out
}

/** 改名时的校验；合法时返回 null。selfId 是正在改名的那一条，和自己同名不算重名 */
export function styleNameError(name: string, presets: readonly StylePreset[], selfId: string): string | null {
  const n = name.trim()
  if (n === '') return '名称不能为空'
  if (presets.some((p) => p.id !== selfId && p.name.trim() === n)) return '已经有同名的画风'
  return null
}

/** 新建预设的默认名：「未命名画风」，被占用时取第一个没占用的「未命名画风 N」（N 从 2 起） */
export function nextStyleName(presets: readonly StylePreset[]): string {
  const used = new Set(presets.map((p) => p.name))
  if (!used.has(UNNAMED_STYLE)) return UNNAMED_STYLE
  for (let n = 2; ; n++) {
    const candidate = `${UNNAMED_STYLE} ${n}`
    if (!used.has(candidate)) return candidate
  }
}

/** 能当预设画风用的：标签非空 */
export function usableStyles(presets: readonly StylePreset[]): StylePreset[] {
  return presets.filter((p) => p.tags.trim() !== '')
}

/**
 * 列表拖动排序：把 from 处那条挪到插入位 to（0..length，按挪动前的下标算，
 * 即「插在原来第 to 条前面」，length 表示放到最后）。原地改，给 store 的 update 草稿用。
 * 插回原位（to 等于 from 或 from + 1）不改动。
 */
export function moveStyle(presets: StylePreset[], from: number, to: number): void {
  if (from < 0 || from >= presets.length || to < 0 || to > presets.length) return
  if (to === from || to === from + 1) return
  const [item] = presets.splice(from, 1)
  presets.splice(to > from ? to - 1 : to, 0, item)
}
