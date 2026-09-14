// 由 build/icon.png 生成多尺寸的 build/icon.ico（用 Electron 自带的图像缩放，不引入依赖）。
// 用法：node_modules/electron/dist/electron.exe scripts/make-icon.js
//
// 为什么要自己生成：electron-builder 把 PNG 转 ICO 时只放了一个 256×256 的 PNG 条目，
// 任务栏（24/32px）、资源管理器小图标（16px）、安装包与便携包的窗口图标都要系统临时缩放，
// 实测显示不完整。这里把 Windows 10 常用的尺寸都放进去：小尺寸存成 32 位位图（兼容性最好），
// 256 存 PNG（ICO 规范允许，体积小）。
const fs = require('fs')
const path = require('path')
const { app, nativeImage } = require('electron')

const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
const SRC = path.join(__dirname, '..', 'build', 'icon.png')
const OUT = path.join(__dirname, '..', 'build', 'icon.ico')

/** 32 位 DIB 图标条目：BITMAPINFOHEADER（高度写两倍）+ 自下而上的 BGRA 像素 + 全 0 的 AND 掩码 */
function dibEntry(image, size) {
  const bgra = image.toBitmap() // 自上而下、预乘 alpha 的 BGRA
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const src = y * size * 4
    const dst = (size - 1 - y) * size * 4
    for (let x = 0; x < size * 4; x += 4) {
      const a = bgra[src + x + 3]
      // 图标的 32 位位图用直通 alpha：半透明像素要反预乘，否则边缘发暗
      const k = a > 0 && a < 255 ? 255 / a : 1
      pixels[dst + x] = Math.min(255, Math.round(bgra[src + x] * k))
      pixels[dst + x + 1] = Math.min(255, Math.round(bgra[src + x + 1] * k))
      pixels[dst + x + 2] = Math.min(255, Math.round(bgra[src + x + 2] * k))
      pixels[dst + x + 3] = a
    }
  }
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size)
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(pixels.length + mask.length, 20)
  return Buffer.concat([header, pixels, mask])
}

app.whenReady().then(() => {
  const src = nativeImage.createFromPath(SRC)
  const { width, height } = src.getSize()
  if (width !== height || width < 256) throw new Error(`build/icon.png 必须是边长 ≥256 的正方形，现在是 ${width}×${height}`)

  const entries = SIZES.map((size) => {
    const img = src.resize({ width: size, height: size, quality: 'best' })
    return { size, data: size >= 256 ? img.toPNG() : dibEntry(img, size) }
  })

  const dir = Buffer.alloc(6 + 16 * entries.length)
  dir.writeUInt16LE(0, 0)
  dir.writeUInt16LE(1, 2)
  dir.writeUInt16LE(entries.length, 4)
  let offset = dir.length
  entries.forEach((e, i) => {
    const p = 6 + i * 16
    dir[p] = e.size >= 256 ? 0 : e.size
    dir[p + 1] = e.size >= 256 ? 0 : e.size
    dir.writeUInt16LE(1, p + 4)
    dir.writeUInt16LE(32, p + 6)
    dir.writeUInt32LE(e.data.length, p + 8)
    dir.writeUInt32LE(offset, p + 12)
    offset += e.data.length
  })
  fs.writeFileSync(OUT, Buffer.concat([dir, ...entries.map((e) => e.data)]))
  console.log(`wrote ${OUT}: ${SIZES.join(', ')}`)
  app.quit()
})
