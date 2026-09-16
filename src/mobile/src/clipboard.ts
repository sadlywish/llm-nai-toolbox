// 手机端的「复制到剪贴板」。
//
// 不能直接用 `navigator.clipboard`：这个页面是桌面端用**明文 HTTP** 发出来的
// （局域网，没有证书可用），而浏览器只在安全上下文里暴露 Clipboard API——
// 安卓 Chrome 上 `navigator.clipboard` 直接是 undefined，照着 MDN 写会当场抛。
// 所以主路径反而是那个「过时」的 execCommand('copy')，Clipboard API 只在拿得到时优先用
// （Capacitor 壳里是 https/file，那时它可用且不需要造临时节点）。

/** 造一个看不见但仍能被选中的 textarea：display:none / visibility:hidden 的节点选不中，复制会静默失败 */
function copyByExecCommand(text: string): boolean {
  const host = document.createElement('textarea')
  host.value = text
  host.setAttribute('readonly', '')
  host.style.position = 'fixed'
  host.style.top = '0'
  host.style.left = '0'
  host.style.opacity = '0'
  // iOS Safari 会把 0 尺寸的元素当作不可选中
  host.style.width = '1px'
  host.style.height = '1px'
  document.body.appendChild(host)
  try {
    host.select()
    host.setSelectionRange(0, text.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    host.remove()
  }
}

/** 复制成功返回 true。调用方据此决定按钮上显示「已复制」还是「复制失败」 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 权限被拒、页面没聚焦：还有 execCommand 这条路可试
  }
  return copyByExecCommand(text)
}
