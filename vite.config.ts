import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

/**
 * Tauri dev 时 `TAURI_DEV_HOST` 是本机对外的地址（手机/其他设备连过来调试用），
 * `TAURI_ENV_PLATFORM` 只要跑在 Tauri 里就有值 —— 用它分流，是为了
 * **不影响平时 `npm run dev` 的习惯**（仍然是 5173，不是 Tauri 要求的 1420）。
 */
const tauriHost = process.env.TAURI_DEV_HOST
const isTauri = !!process.env.TAURI_ENV_PLATFORM

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  worker: {
    format: 'es',
  },
  // Tauri CLI 要解析自己的构建输出，清屏会把它的进度提示冲掉
  clearScreen: false,
  build: {
    // 打包后跑在 WebView2（Chromium 105+）里。目标比浏览器保守一档，
    // 免得用到 WebView2 还不支持的语法 —— 尤其是 worker 里那些 ES2025 调用。
    target: isTauri ? 'chrome105' : undefined,
    /*
     * ⚠️ 别写 `minify: 'esbuild'` —— 这个项目用的是 rolldown 版 vite，
     *    压根没装 esbuild 包，写了会直接构建失败
     *    （"Cannot find package 'esbuild'"，而且报错指向 worker 打包，很误导）。
     *    `true` = 用它自带的默认压缩器。
     */
    minify: process.env.TAURI_ENV_DEBUG ? false : true,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        // spike.html 也要进构建 —— 否则 npm run build 之后
        // 拷到另一台机器上没有实验页可跑
        spike: fileURLToPath(new URL('./spike.html', import.meta.url)),
        // 批注兼容性自检页：要拿到目标机上去跨查看器核对，同样必须进构建
        annotCheck: fileURLToPath(new URL('./annot-check.html', import.meta.url)),
        // 批注「写回 PDF」自检页：同样要能拿到目标机上跑
        writeCheck: fileURLToPath(new URL('./write-check.html', import.meta.url)),
      },
    },
  },
  // pdfjs-dist 自带预构建产物，交给 Vite 预打包反而会破坏 worker 的 URL 解析
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
  server: {
    port: isTauri ? 1420 : 5173,
    strictPort: isTauri,
    host: tauriHost || false,
    hmr: tauriHost ? { protocol: 'ws', host: tauriHost, port: 1421 } : undefined,
    watch: {
      // src-tauri 里的变动由 cargo 自己管，别让 vite 也跟着重启
      ignored: ['**/src-tauri/**'],
    },
  },
  // 让 `import.meta.env.TAURI_*` 能读到（platform.ts 的运行时检测之外的补充）
  envPrefix: ['VITE_', 'TAURI_'],
})
