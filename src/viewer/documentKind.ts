/**
 * 文档类型识别 —— 全应用**唯一**判断"这是什么文档"的地方。
 *
 * ## 为什么按扩展名而不是 MIME
 * 浏览器给的 `File.type` 对 `.md` 极不稳定：Windows 上常是 `text/plain`，
 * 有些环境甚至是空串。按 MIME 分流会出现"同一个文件在这台机器能开、在另一台打不开"。
 * 扩展名至少是**用户和磁盘说话时用的那个东西**，也跟 Rust 侧的闸门完全一致。
 *
 * ## 为什么单独成文件
 * 类型判断散落过：`fileList.ts` 的 `isPdf`、`App.vue` 拖放里的 `/\.pdf$/i`、
 * Rust 的 `ensure_pdf_ext`、`FilesPanel` 的 `accept`。加一种格式要改四处，
 * 漏一处就是"文件能打开但列表里看不见"这种半坏状态。现在前端只从这里取。
 */

export type DocKind = 'pdf' | 'markdown'

/** 支持的扩展名（小写，带点）。顺序即提示里的顺序 */
export const DOC_EXTENSIONS = ['.pdf', '.md', '.markdown'] as const

/** `<input accept>` / 对话框过滤器共用的一份清单 */
export const OPEN_ACCEPT = '.pdf,.md,.markdown,application/pdf,text/markdown'

/** 给用户看的类型名 */
export const DOC_KIND_LABEL: Record<DocKind, string> = {
  pdf: 'PDF',
  markdown: 'Markdown',
}

/**
 * Markdown 的**软上限**：16 MiB。
 *
 * 低配机（8 GB，目标是这个）上，一个 16 MiB 的纯文本已经是十几万行；
 * 再大就不是"阅读"而是"考验渲染器"了。PDF 那边仍然是 2 GiB —— 那是二进制，
 * 页是按需渲染的，和一次性建 DOM 的 Markdown 不是同一类成本。
 */
export const MD_MAX_BYTES = 16 * 1024 * 1024

/** 从文件名判断类型；不认识的返回 `null`（调用方负责给提示，别静默当 PDF 试） */
export function docKindOf(name: string): DocKind | null {
  const n = name.toLowerCase()
  if (n.endsWith('.pdf')) return 'pdf'
  if (n.endsWith('.md') || n.endsWith('.markdown')) return 'markdown'
  return null
}

export function isSupportedDocument(name: string): boolean {
  return docKindOf(name) !== null
}

/** 类型徽标（文件列表 / 标题栏用得到） */
export function docKindBadge(name: string): string {
  const k = docKindOf(name)
  return k ? DOC_KIND_LABEL[k] : ''
}

/**
 * 徽标的**短标签**：PDF / MD。
 * 和 DOC_KIND_LABEL 分开是因为文件列表的行宽有限 —— "Markdown" 8 个字符
 * 会把文件名挤掉一截，"MD" 两个字符刚刚好。
 */
export function docKindTag(name: string): 'PDF' | 'MD' | '' {
  const k = docKindOf(name)
  if (k === 'pdf') return 'PDF'
  if (k === 'markdown') return 'MD'
  return ''
}

/** 拒绝时的统一说法 —— 别让用户猜"到底支持什么" */
export const UNSUPPORTED_HINT = '只支持 PDF（.pdf）和 Markdown（.md / .markdown）文件'
