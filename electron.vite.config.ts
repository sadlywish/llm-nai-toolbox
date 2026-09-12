import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: { rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') } },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        // shared/ 里的 blockMetrics/blockWeight import 了 @renderer/prompt/*，
        // 而 shared/ 是两端共用的。真正的解法是后续计划把 prompt/ 挪进
        // src/shared/prompt/，在那之前这条别名必须三段齐备。
        '@renderer': resolve(__dirname, 'src/renderer/src'),
      },
    },
  },
  preload: {
    build: { rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') } },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        // shared/ 里的 blockMetrics/blockWeight import 了 @renderer/prompt/*，
        // 而 shared/ 是两端共用的。真正的解法是后续计划把 prompt/ 挪进
        // src/shared/prompt/，在那之前这条别名必须三段齐备。
        '@renderer': resolve(__dirname, 'src/renderer/src'),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer/src'),
      },
    },
    plugins: [react()],
  },
})
