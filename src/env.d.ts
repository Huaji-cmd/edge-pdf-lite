/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

/**
 * `markdown-it-task-lists` 没有类型声明（只有 CommonJS 的 index.js）。
 * 这里给最小可用的形状 —— 它唯一的用法就是 `md.use(taskLists, {…})`，
 * 写成 `unknown` 也行，但那样 `md.use()` 的参数检查就白丢了。
 */
declare module 'markdown-it-task-lists' {
  import type MarkdownIt from 'markdown-it'
  interface TaskListOptions {
    enabled?: boolean
    label?: boolean
    labelAfter?: boolean
  }
  const plugin: MarkdownIt.PluginWithOptions<TaskListOptions>
  export default plugin
}

/**
 * `highlight.js/lib/common` 的子路径导出没带 `types` 字段，
 * bundler 解析下 TS 找不到声明 —— 自己给最小可用的形状。
 * 我们只用到两个方法（高亮一个元素、查语言认不认识），不必引入完整类型面。
 */
declare module 'highlight.js/lib/common' {
  interface HljsApi {
    highlightElement(el: HTMLElement): void
    getLanguage(name: string): unknown
  }
  const hljs: HljsApi
  export default hljs
}
