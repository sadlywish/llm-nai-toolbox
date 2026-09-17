// 由 build/icon.png 生成手机端 APK 的启动器图标，与桌面端用同一张图（同 make-icon.js，用 Electron 自带缩放，不引入依赖）。
// 用法：node_modules/electron/dist/electron.exe scripts/make-android-icon.js
//
// 生成三样，覆盖 android/app/src/main/res/mipmap-{m,h,xh,xxh,xxxh}dpi/ 里 Capacitor 模板留下的默认图标：
// - ic_launcher_foreground.png：Android 8+ 自适应图标的前景层（108dp 见方）。
//   整张图缩到层边长的一半（54dp）放正中。启动器会把 108dp 的层裁成圆形、圆角方形、水滴等形状，
//   只保证中间直径 66dp 的圆不被裁；图底部那行「蜘蛛子的玩具箱」离中心最远处约是半边长的 1.2 倍，
//   54dp 时落在直径约 65dp 的圆内，任何形状的遮罩都切不到字。背景层是纯黑（图本身四周就是黑边），
//   缩小后多出来的地方和图的黑边连成一片，看起来仍是整张图标。
// - ic_launcher.png：Android 7 及以下的方形图标，整张图直接缩放。
// - ic_launcher_round.png：Android 7.1 的圆形图标，黑色圆底，图缩到直径的 75%，同样保证字在圆内。
// 背景色在 res/values/ic_launcher_background.xml，改图时若四周不再是黑边要一起改。
const fs = require('fs')
const path = require('path')
const { app, nativeImage } = require('electron')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'build', 'icon.png')
const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res')

/** 各密度相对 mdpi 的倍数 */
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
/** 旧式图标边长 48dp；自适应图标的层边长 108dp */
const LEGACY_DP = 48
const LAYER_DP = 108
/** 自适应前景里图占层边长的比例（54dp / 108dp） */
const FOREGROUND_FILL = 0.5
/** 圆形旧式图标里图占直径的比例 */
const ROUND_FILL = 0.75
/** 源图各边先裁掉的像素（见下方说明） */
const EDGE_CROP = 2

/** 把一张缩好的图（预乘 BGRA）盖到画布的 (left, top) 处，画布同为预乘 BGRA */
function drawOver(canvas, canvasSize, image, imageSize, left, top) {
  const px = image.toBitmap()
  for (let y = 0; y < imageSize; y++) {
    const cy = top + y
    if (cy < 0 || cy >= canvasSize) continue
    for (let x = 0; x < imageSize; x++) {
      const cx = left + x
      if (cx < 0 || cx >= canvasSize) continue
      const s = (y * imageSize + x) * 4
      const d = (cy * canvasSize + cx) * 4
      const keep = 1 - px[s + 3] / 255
      for (let c = 0; c < 4; c++) canvas[d + c] = Math.round(px[s + c] + canvas[d + c] * keep)
    }
  }
}

/** 画布按圆形裁剪：边缘一像素宽做抗锯齿（预乘格式，四个通道同乘覆盖率） */
function clipCircle(canvas, size) {
  const r = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = Math.hypot(x + 0.5 - r, y + 0.5 - r)
      const cover = Math.max(0, Math.min(1, r - dist + 0.5))
      if (cover >= 1) continue
      const d = (y * size + x) * 4
      for (let c = 0; c < 4; c++) canvas[d + c] = Math.round(canvas[d + c] * cover)
    }
  }
}

function fromCanvas(canvas, size) {
  return nativeImage.createFromBitmap(canvas, { width: size, height: size }).toPNG()
}

app.whenReady().then(() => {
  const original = nativeImage.createFromPath(SRC)
  const { width, height } = original.getSize()
  if (width !== height || width < 512) throw new Error(`build/icon.png 必须是边长 ≥512 的正方形，现在是 ${width}×${height}`)
  // 原图最外一圈 1px 是浅色杂边（往里才是纯黑边）。桌面端图标铺满看不出来，
  // 这里缩小后放在黑底上会显出一道淡方框，所以先各边裁掉 EDGE_CROP 像素
  const src = original.crop({ x: EDGE_CROP, y: EDGE_CROP, width: width - EDGE_CROP * 2, height: height - EDGE_CROP * 2 })

  for (const [density, scale] of Object.entries(DENSITIES)) {
    const dir = path.join(RES, `mipmap-${density}`)
    fs.mkdirSync(dir, { recursive: true })

    const legacy = Math.round(LEGACY_DP * scale)
    fs.writeFileSync(path.join(dir, 'ic_launcher.png'), src.resize({ width: legacy, height: legacy, quality: 'best' }).toPNG())

    // 圆形：黑底 → 盖图 → 按圆裁
    const round = Buffer.alloc(legacy * legacy * 4)
    for (let i = 3; i < round.length; i += 4) round[i] = 255
    const roundImage = Math.round(legacy * ROUND_FILL)
    const roundOffset = Math.round((legacy - roundImage) / 2)
    drawOver(round, legacy, src.resize({ width: roundImage, height: roundImage, quality: 'best' }), roundImage, roundOffset, roundOffset)
    clipCircle(round, legacy)
    fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), fromCanvas(round, legacy))

    // 自适应前景：透明层，图放正中
    const layer = Math.round(LAYER_DP * scale)
    const foreground = Buffer.alloc(layer * layer * 4)
    const fgImage = Math.round(layer * FOREGROUND_FILL)
    const fgOffset = Math.round((layer - fgImage) / 2)
    drawOver(foreground, layer, src.resize({ width: fgImage, height: fgImage, quality: 'best' }), fgImage, fgOffset, fgOffset)
    fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), fromCanvas(foreground, layer))

    console.log(`${density}: launcher ${legacy}px, foreground layer ${layer}px`)
  }
  app.quit()
})
