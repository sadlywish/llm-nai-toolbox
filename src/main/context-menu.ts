import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

/**
 * 给窗口装上右键菜单。
 *
 * Electron 默认**没有**任何上下文菜单——不装的话文本框右键什么都不出来，
 * 纯鼠标操作的用户没法剪切/粘贴。
 *
 * 刻意不放「撤销 / 重做」：本应用的提示词框是 CodeMirror，它维护自己的
 * 历史栈，而 Electron 的 undo/redo role 走的是 Chromium 原生 undo，未必
 * 能到它那儿。一个点了没反应的菜单项比没有这一项更糟。
 */
export function installContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const items: MenuItemConstructorOptions[] = []

    // 图片：出图格子、原图查看器、Danbooru 例图缩略图都吃这一条。
    // 用 copyImageAt 而不是自己读字节：它按视口坐标取的是**已渲染的那张图**，
    // file:// 直链与 blob: 对象 URL 一视同仁，不必关心图是从哪来的
    if (params.mediaType === 'image') {
      items.push({
        label: '复制图片',
        click: () => win.webContents.copyImageAt(params.x, params.y),
      })
    }

    if (params.isEditable) {
      if (items.length > 0) items.push({ type: 'separator' })
      items.push(
        { label: '剪切', role: 'cut', enabled: params.editFlags.canCut },
        { label: '复制', role: 'copy', enabled: params.editFlags.canCopy },
        { label: '粘贴', role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { label: '全选', role: 'selectAll', enabled: params.editFlags.canSelectAll },
      )
    } else if (params.selectionText.trim() !== '') {
      // 不可编辑但选中了文字（溯源信息、日志、错误提示等）：至少能复制
      if (items.length > 0) items.push({ type: 'separator' })
      items.push({ label: '复制', role: 'copy' })
    }

    // 没有任何可用项就别弹一个空菜单
    if (items.length === 0) return
    Menu.buildFromTemplate(items).popup({ window: win })
  })
}
