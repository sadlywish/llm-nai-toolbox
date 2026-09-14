/**
 * 「生成副本」时给副本起名。
 *
 * 命名成 `<原名> 副本 N` 而不是 `<原名> 的副本`：后者连续复制会长成
 * 「的副本的副本的副本」。这里先把原名末尾已有的「副本 N」剥掉再重新编号，
 * 所以从 `画师串 1 副本 1` 再复制得到的是 `画师串 1 副本 2`，而不是嵌套一层。
 *
 * 编号取**第一个没被占用的**，不是「已有个数 + 1」：用户删掉中间某个副本
 * 之后，后者会撞上仍然存在的名字。
 */
export function duplicateName(sourceName: string, existing: readonly string[]): string {
  const base = sourceName.replace(/\s*副本\s*\d+\s*$/, '').trim()
  const used = new Set(existing)
  for (let n = 1; ; n++) {
    const candidate = base === '' ? `副本 ${n}` : `${base} 副本 ${n}`
    if (!used.has(candidate)) return candidate
  }
}
