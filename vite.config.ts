import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

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
  build: {
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
    port: 5173,
  },
})
