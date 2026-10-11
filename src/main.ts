import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/base.css'

createApp(App).use(createPinia()).mount('#app')

/*
 * 注册 Service Worker —— 注册之后这个页面才能被「安装为应用」（独立窗口、
 * 任务栏图标、离线可用）。
 *
 * ⚠️ 只在生产构建里注册。dev 模式下模块是即时编译的，SW 会把旧模块缓存下来，
 * 改一行代码要手动清缓存才生效，开发体验直接毁掉。
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      // 注册失败不影响功能（只是不能离线/安装），不必打断用户
      console.warn('[sw] 注册失败：', err)
    })
  })
}
