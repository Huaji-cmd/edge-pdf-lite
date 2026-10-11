/**
 * 自定义 pdf.js worker 入口。
 *
 * 为什么需要它：pdf.js 自带的 worker 不能改，而它缺 ES2025 补丁。
 * 这个文件做的事只有两件 —— 先补 Polyfill，再加载真正的 worker。
 *
 * 顺序很重要：ES 模块按 import 书写顺序求值，polyfills 必须排在前面，
 * 否则 pdf.js 在模块求值阶段就可能踩到缺失的 API。
 *
 * pdf.js 的 worker 在被 import 时会自我初始化
 * （见 build/pdf.worker.mjs 里 WorkerMessageHandler 的 static 块会调用
 * initializeFromPort(self)），所以这里不需要手动初始化。
 */
import './polyfills'
import 'pdfjs-dist/build/pdf.worker.min.mjs'
