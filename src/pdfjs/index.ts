/**
 * pdf.js 装载入口。所有用到 pdf.js 的地方都应该从这里 import，
 * 而不是直接 `import * as pdfjsLib from 'pdfjs-dist'` ——
 * 否则会漏掉 Polyfill 和自定义 worker 的装配。
 */
import './polyfills'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from './pdfWorker.ts?worker&url'

let installed = false

/**
 * 装配 worker。必须在使用 getDocument 之前调用一次。
 *
 * 用 `workerSrc` 而不是 `workerPort`：让 pdf.js 自己管理 worker 的生命周期
 * （创建、销毁、destroy 后重建）。用 workerPort 会有"一个 port 只能配一个
 * PDFWorker"的限制，多文档场景容易踩坑。
 */
export function installPdfWorker(): void {
  if (installed) return
  installed = true
  // 注意：这里必须补成**绝对 URL**，不能用 Vite 给的 `/assets/xxx.js` 这种根路径。
  // pdf.js 内部会做 `URL.parse(workerSrc)` 判断是否同源；根路径会被解析成 null，
  // 于是它认定"跨域"，绕道 blob 包装器（`await import(...)`）去加载 worker。
  // 多一层包装 = 多一个失败点。补成绝对 URL 后走直连，路径最短。
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(workerUrl, window.location.href).href
}

/** 当前环境被补了哪些 Polyfill（诊断用） */
export function pdfPolyfillsApplied(): readonly string[] {
  return (globalThis as unknown as { __pdfjsPolyfillsApplied?: string[] })
    .__pdfjsPolyfillsApplied ?? []
}

/**
 * 把 pdf.js 抛出的英文错误翻译成能直接指导排查的中文提示。
 * 这些错误在"局域网测试 + 低配机"这个场景里出现频率不低，
 * 原始报错（比如 `Failed to fetch dynamically imported module`）对使用者几乎没有信息量。
 */
export function describePdfError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)

  if (/Failed to fetch dynamically imported module|Setting up fake worker failed/i.test(raw)) {
    return (
      `${raw}\n\n` +
      '→ pdf.js 的 worker 脚本没能下载下来，整个 PDF 就都打不开了。\n' +
      '   常见原因（按概率排）：\n' +
      '   1. 提供页面的那个服务已经停了（后台跑的服务容易被关掉/回收）\n' +
      '   2. 网络断了，或访问地址变了（换了 IP / 换了端口）\n' +
      '   3. 静态服务器没把 .js 以 text/javascript 返回，浏览器拒绝执行模块\n' +
      '   排查：把报错里那个 .js 链接直接粘到浏览器地址栏，能打开就不是这里的问题。'
    )
  }

  if (/toHex|toBase64|fromBase64|setFromBase64|sumPrecise|Promise\.try|withResolvers/i.test(raw)) {
    return (
      `${raw}\n\n` +
      '→ 浏览器缺少 pdf.js 需要的新 API（ES2025）。\n' +
      '   正常情况已由 src/pdfjs/polyfills.ts 兜住；出现这个说明补丁没有加载，\n' +
      '   检查是不是有人直接 import 了 "pdfjs-dist" 而绕过了 @/pdfjs 装载入口。'
    )
  }

  if (/PasswordException|No password given|Incorrect Password/i.test(raw)) {
    return `${raw}\n\n→ 这个 PDF 有密码保护。`
  }
  if (/InvalidPDF|Invalid PDF structure/i.test(raw)) {
    return `${raw}\n\n→ 文件不是有效的 PDF，或已损坏。`
  }
  return raw
}

export { pdfjsLib }
export * from 'pdfjs-dist'
