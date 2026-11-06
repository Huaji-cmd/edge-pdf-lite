/**
 * 把 Markdown 渲染结果组装成**自包含**的打印 HTML —— 应用内"转 PDF"的原料。
 *
 * ## 设计要点
 *
 * - **预览看到什么，PDF 就是什么**：原料是 `markdownDocument.ts` 净化后的
 *   `doc.html`（同一个安全管线），在这里把"运行时才落地的东西"静态化：
 *   公式占位 → KaTeX 静态标记；代码块 → highlight.js 静态标记；
 *   图片占位 → `file://` 直链（交给 Edge 无头进程去读）。
 * - **自包含**：KaTeX 的 CSS 连同字体（woff2 → base64 data URI）一起内嵌，
 *   临时 HTML 不引用任何外部资源 —— Edge 进程拉不到我们的静态资源。
 * - **不经过 DOMPurify 的是 KaTeX 输出**（trust:false，理由见 MarkdownViewer）；
 *   本模块不从用户字符串拼任何 HTML —— 所有插值都来自净化后的 DOM 或编码值。
 * - 打印 CSS 是**独立手写**的一份（A4、日间固定色值）：打印本来就该比屏幕
 *   简化（无侧栏交互、纯白纸）。⚠️ 它镜像了 base.css 日间变量与 md-body 的
 *   排版规则 —— 改那两处时记得同步这里（注释里互指了）。
 */

import type { MarkdownDocument } from './markdownDocument'

interface KatexApi {
  renderToString(tex: string, opts?: Record<string, unknown>): string
}

interface HljsApi {
  highlight(code: string, opts: { language: string; ignoreIllegals?: boolean }): { value: string }
  getLanguage(name: string): unknown
}

/* 懒加载：与 MarkdownViewer 的动态 import 指向同一 chunk，这里只是再拿一次引用 */
let katexP: Promise<KatexApi | null> | null = null
function loadKatex(): Promise<KatexApi | null> {
  katexP ??= import('katex')
    .then((m) => (m.default as unknown) as KatexApi)
    .catch(() => null)
  return katexP
}
let hljsP: Promise<HljsApi | null> | null = null
function loadHljs(): Promise<HljsApi | null> {
  hljsP ??= import('highlight.js/lib/common')
    .then((m) => (m.default as unknown) as HljsApi)
    .catch(() => null)
  return hljsP
}

/** Windows 本地路径 → file:// URL（正斜杠 + 非 ASCII 编码） */
function fileUrl(winPath: string): string {
  const p = winPath.replace(/\\/g, '/')
  // UNC（\\server\share → //server/share）用 file://// 前缀；盘符路径用 file:///
  return p.startsWith('//')
    ? `file:${encodeURI(p)}`
    : `file:///${encodeURI(p.replace(/^\/+/, ''))}`
}

/**
 * 把**已加载**的 KaTeX CSS 内嵌成自包含文本（字体转 base64）。
 *
 * 只挑 woff2 内嵌：KaTeX 每个 @font-face 的 src 依次是 woff2 / woff / ttf，
 * 浏览器命中第一个支持的格式（woff2）就不会再拉后面两项 —— 顺带省一半体积。
 * CSS 没加载过（文档没公式）时返回空串。
 */
async function inlineKatexCss(): Promise<string> {
  const href = [...document.styleSheets]
    .map((s) => (s as CSSStyleSheet).href ?? '')
    .find((h) => /katex/i.test(h))
  if (!href) return ''
  let css = await (await fetch(href)).text()
  const jobs: Promise<void>[] = []
  css = css.replace(/url\(([^)]+\.woff2)\)/g, (whole, u: string) => {
    const abs = new URL(u.replace(/^['"]|['"]$/g, ''), href).href
    jobs.push(
      fetch(abs)
        .then((r) => r.arrayBuffer())
        .then((buf) => {
          let bin = ''
          const bytes = new Uint8Array(buf)
          for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
          }
          css = css.replace(whole, `url(data:font/woff2;base64,${btoa(bin)})`)
        }),
    )
    return whole
  })
  if (jobs.length) await Promise.all(jobs)
  return css
}

export interface PrintOptions {
  /** 文档有真实路径时传目录（拼图片的 file:// 直链）；拖入的没有，图片保持占位 */
  docDir?: string
  /** 这篇文档的绝对路径图片**授权过**（fingerprint 在授权清单里）才放行 */
  allowAbsoluteImages: boolean
}

/**
 * 组装打印 HTML。有公式 / 代码块的文档会顺带把 KaTeX / highlight.js 拉进内存
 * （与阅读器共享同一 chunk，不额外下载）。
 */
export async function buildPrintHtml(doc: MarkdownDocument, opts: PrintOptions): Promise<string> {
  const parsed = new DOMParser().parseFromString(doc.html, 'text/html')
  const root = parsed.body

  // ---- 任务列表：打印里 checkbox 没意义，印成字符符号 ----
  for (const t of [...root.querySelectorAll<HTMLElement>('span.md-task')]) {
    t.textContent = t.classList.contains('on') ? '☑ ' : '☐ '
  }

  // ---- 图片：占位 → file:// 直链（预览里怎么拦的，这里就怎么保守） ----
  for (const ph of [...root.querySelectorAll<HTMLElement>('span[data-md-img]')]) {
    const rel = ph.getAttribute('data-md-img') ?? ''
    if (opts.docDir && rel) {
      const img = parsed.createElement('img')
      img.src = fileUrl(`${opts.docDir.replace(/[\\/]+$/, '')}\\${rel}`)
      img.alt = ph.getAttribute('data-md-alt') ?? ''
      const title = ph.getAttribute('data-md-title')
      if (title) img.title = title
      ph.replaceWith(img)
    }
    // 没有 docDir（拖入的文件）：占位原样印出 —— 和预览一致，不说谎
  }
  for (const ph of [...root.querySelectorAll<HTMLElement>('span[data-md-blocked="absolute"]')]) {
    const p = ph.getAttribute('data-md-src') ?? ''
    if (opts.allowAbsoluteImages && p) {
      const img = parsed.createElement('img')
      img.src = fileUrl(p)
      img.alt = ph.getAttribute('data-md-alt') ?? ''
      ph.replaceWith(img)
    }
    // 未授权：保留"为什么被拦"的占位文字 —— 打印出来也一样说理
  }

  // ---- 公式：占位 → KaTeX 静态标记 ----
  const mathSlots = [...root.querySelectorAll<HTMLElement>('[data-md-math]')]
  const katex = mathSlots.length ? await loadKatex() : null
  for (const el of mathSlots) {
    let tex = ''
    try {
      tex = decodeURIComponent(el.dataset.mdMath ?? '')
    } catch {
      tex = el.dataset.mdMath ?? ''
    }
    if (!katex) {
      el.textContent = tex
      el.classList.add('md-math-raw')
      continue
    }
    try {
      el.innerHTML = katex.renderToString(tex, {
        displayMode: el.dataset.mdDisplay === '1',
        throwOnError: false,
        strict: false,
        trust: false, // 🔴 与阅读器同一道闸门：不许 \href 等逃逸构造
      })
      // 静态化后属性就没用了 —— 残留会污染"自包含"判据（data-md-math 不该出现在成品里）
      el.removeAttribute('data-md-math')
      el.removeAttribute('data-md-display')
    } catch {
      el.textContent = tex
      el.classList.add('md-math-raw')
    }
  }

  // ---- 代码高亮：token span 静态化（标了语言的块才做，与阅读器同一取舍） ----
  const codeSlots = [...root.querySelectorAll<HTMLElement>('pre code')]
  const hljs = codeSlots.length ? await loadHljs() : null
  for (const el of codeSlots) {
    const lang = [...el.classList].find((c) => c.startsWith('language-'))?.slice(9) ?? ''
    if (!hljs || !lang || !hljs.getLanguage(lang)) continue
    try {
      el.innerHTML = hljs.highlight(el.textContent ?? '', { language: lang, ignoreIllegals: true }).value
    } catch {
      /* 单块失败保持纯文本 */
    }
  }

  // ---- 表格：滚动容器是屏幕交互用的，打印直接解包 ----
  for (const wrap of [...root.querySelectorAll('.md-table-wrap')]) {
    wrap.replaceWith(...wrap.childNodes)
  }

  // ---- KaTeX CSS 内嵌（有公式才需要；字体 fetch 失败就明确报错，不出烂 PDF） ----
  const katexCss = mathSlots.length ? await inlineKatexCss() : ''
  const body = root.innerHTML

  /*
   * 打印 CSS（日间固定色值）。⚠️ 镜像 base.css 的 light 变量与 md-body 排版，
   * 改那两处时同步这里。@page 出页边距；break-* 防孤行断块。
   */
  const css = `
@page { size: A4; margin: 18mm 16mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: "Microsoft YaHei", "Segoe UI", system-ui, sans-serif;
  font-size: 11pt;
  line-height: 1.75;
  color: #1f2329; /* base.css 日间 --fg */
  background: #fff;
  word-wrap: break-word;
}
h1, h2, h3, h4, h5, h6 { line-height: 1.4; margin: 1.4em 0 0.6em; break-after: avoid; }
h1 { font-size: 1.7em; } h2 { font-size: 1.4em; } h3 { font-size: 1.2em; }
p { margin: 0.6em 0; }
a { color: #1668dc; /* 日间 --accent */ text-decoration: underline; }
ul, ol { padding-left: 1.6em; margin: 0.6em 0; }
blockquote {
  margin: 0.8em 0; padding: 0.2em 1em;
  border-left: 3px solid #c8cdd6; color: #5c6472; /* 日间 --line-strong / --dim */
}
hr { border: 0; border-top: 1px solid #d8dce3; margin: 1.6em 0; }
img { max-width: 100%; height: auto; break-inside: avoid; }
table { border-collapse: collapse; margin: 0.8em 0; width: 100%; break-inside: avoid; }
th, td { border: 1px solid #c8cdd6; padding: 5px 10px; text-align: left; }
th { background: #f6f7f9; }
tr { break-inside: avoid; }
code { font-family: Consolas, "Cascadia Mono", monospace; font-size: 0.88em; }
pre {
  background: #eef0f3; /* 日间 --md-code-bg */
  border: 1px solid #d8dce3; border-radius: 6px;
  padding: 0.8em 1em; margin: 0.9em 0;
  overflow: hidden; white-space: pre-wrap; word-wrap: break-word;
}
pre code { background: none; padding: 0; white-space: inherit; }
/* 代码高亮 token —— 日间固定色，镜像 MarkdownViewer 里映射变量的那份 */
.hljs-comment, .hljs-quote { color: #858d9b; font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-doctag { color: #1668dc; }
.hljs-string, .hljs-regexp, .hljs-addition { color: #16a34a; }
.hljs-number, .hljs-symbol, .hljs-bullet, .hljs-attr, .hljs-attribute,
.hljs-variable, .hljs-template-variable { color: #b45309; }
.hljs-title, .hljs-name, .hljs-selector-id, .hljs-selector-class { color: #1f2329; font-weight: 600; }
.hljs-type, .hljs-built_in, .hljs-class { color: #3d4450; }
.hljs-meta { color: #5c6472; }
.hljs-deletion { color: #c0392b; }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 650; }
/* 图片占位（被拦/找不到的），打印出来照旧说理 */
.md-img-ph {
  display: block; margin: 0.8em 0; padding: 0.6em 0.8em;
  border: 1px dashed #c8cdd6; border-radius: 6px;
  color: #858d9b; font-size: 0.86em; text-align: center;
}
/* 公式：块级居中；没渲染出来的 TeX 原文弱化 */
.md-math[data-md-display] { display: block; margin: 1em 0; text-align: center; }
.md-math-raw { font-family: Consolas, monospace; font-size: 0.88em; color: #858d9b; }
`

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${doc.name.replace(/[<>&"]/g, '')}</title>
<style>${katexCss}</style>
<style>${css}</style>
</head>
<body>
${body}
</body>
</html>`
}
