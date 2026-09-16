import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * 手机前端（`src/mobile/`）的构建：与桌面端三份（main/preload/renderer）分开走一次 vite，
 * 产物是纯静态页面，由主进程的 HTTP 服务托管（`ServerDeps.staticDir`）。
 *
 * `npm run build` 里跟在 electron-vite 后面跑；单独调页面用 `npm run dev:mobile`。
 */
export default defineConfig({
  root: resolve(__dirname, 'src/mobile'),
  // 相对路径：页面是从 `http://<电脑 IP>:<端口>/` 发出来的，绝对路径 `/assets/...` 在
  // Capacitor 的 file:// 壳里会直接 404（规格 §2：之后同一套页面要包成 APK）
  base: './',
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      // shared/ 里的 blockMetrics/blockWeight import 了 @renderer/prompt/*，
      // 而 shared/ 是两端共用的。真正的解法是后续计划把 prompt/ 挪进
      // src/shared/prompt/，在那之前这条别名必须三段齐备。
      '@renderer': resolve(__dirname, 'src/renderer/src'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'out/mobile'),
    // outDir 在 root 外面，Vite 要求显式表态才肯清空
    emptyOutDir: true,
  },
  plugins: [react()],
})
