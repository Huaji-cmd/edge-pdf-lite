import { pdfjsLib, installPdfWorker, describePdfError } from '@/pdfjs'
import type { PageSize } from './types'
import type { OutlineNode } from './outline'
import { parseOutline } from './outline'

installPdfWorker()

/**
 * 文档封装。
 *
 * 只做三件事：装载、按需给页、缓存页尺寸。
 * **不负责销毁** —— 见 close()：必须销毁 loadingTask 而不是 PDFDocumentProxy，
 * 否则 worker 不会被回收（pdf.js 6 的 PDFDocumentProxy 上只有 cleanup()）。
 */
export class PdfDocument {
  readonly name: string
  readonly numPages: number
  /**
   * 原始文件字节。
   *
   * 为什么要留一份：`getDocument()` 会 **transfer** `ArrayBuffer` 的所有权，
   * 调用之后传进去的那个 buffer 就是 detached 状态、读不出来了。
   * 而导出批注必须基于**原始文件**（要走增量保存），所以这里先复制一份。
   * 代价是多占一份文件大小的内存 —— 对 20–50MB 的文件可接受，
   * 若将来要再省，可以改成"只在用户真的点了导出时才重新读一次文件"。
   */
  readonly originalBytes: Uint8Array

  private readonly task: pdfjsLib.PDFDocumentLoadingTask
  private readonly doc: pdfjsLib.PDFDocumentProxy
  private readonly pagePromises = new Map<number, Promise<pdfjsLib.PDFPageProxy>>()
  private readonly sizes = new Map<number, PageSize>()
  /** 大纲只解析一次。缓存的是 **Promise 本身**，见 getOutline */
  private outline: Promise<OutlineNode[]> | null = null

  private constructor(
    task: pdfjsLib.PDFDocumentLoadingTask,
    doc: pdfjsLib.PDFDocumentProxy,
    name: string,
    originalBytes: Uint8Array,
  ) {
    this.task = task
    this.doc = doc
    this.name = name
    this.numPages = doc.numPages
    this.originalBytes = originalBytes
  }

  static async open(bytes: Uint8Array, name: string): Promise<PdfDocument> {
    const original = bytes.slice()
    const task = pdfjsLib.getDocument({
      data: bytes,
      // 中文 PDF 必需，由 postinstall 脚本拷进 public/
      cMapUrl: '/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/standard_fonts/',
    })
    try {
      const doc = await task.promise
      return new PdfDocument(task, doc, name, original)
    } catch (e) {
      // 失败时也要把 worker 收掉，不然反复开错文件会攒一堆 worker
      await task.destroy().catch(() => {})
      throw new Error(describePdfError(e))
    }
  }

  /** 取 PDFPageProxy，同一页只解析一次 */
  getPage(pageNumber: number): Promise<pdfjsLib.PDFPageProxy> {
    const cached = this.pagePromises.get(pageNumber)
    if (cached) return cached
    const p = this.doc.getPage(pageNumber)
    this.pagePromises.set(pageNumber, p)
    return p
  }

  /**
   * 文档指纹（pdf.js 按文件内容算的）。
   * 拿它当"阅读位置记忆"的键 —— 比文件名可靠，重命名/移动目录都还认得出来。
   */
  get fingerprint(): string {
    return this.doc.fingerprints?.[0] ?? `${this.name}:${this.numPages}`
  }

  /** 取页面尺寸，缓存（页面尺寸不会变，算一次就够） */
  async getPageSize(pageNumber: number): Promise<PageSize> {
    const cached = this.sizes.get(pageNumber)
    if (cached) return cached
    const page = await this.getPage(pageNumber)
    // scale=1 的 viewport 已经处理了 /Rotate
    const vp = page.getViewport({ scale: 1 })
    const size: PageSize = { width: vp.width, height: vp.height }
    this.sizes.set(pageNumber, size)
    return size
  }

  /** 批量取尺寸（先填满版面才能算出正确的滚动高度） */
  async getPageSizes(pageNumbers: number[]): Promise<PageSize[]> {
    return Promise.all(pageNumbers.map((n) => this.getPageSize(n)))
  }

  /**
   * 大纲（书签 / 目录）。没有书签的文档返回空数组。
   *
   * ⚠️ 缓存的是 **Promise 本身**而不是结果：并发调用只会解析一次；
   * 而且解析失败也会被记住，不会每次打开面板都重试一遍。
   *
   * ⚠️ 很多 PDF **根本没有书签** —— 尤其是扫描件（我那本《现代操作系统教程》
   *    就是）。这不是错误，UI 要给一句清楚的空状态说明，别让人以为工具坏了。
   */
  getOutline(): Promise<OutlineNode[]> {
    if (!this.outline) this.outline = parseOutline(this.doc)
    return this.outline
  }

  async close(): Promise<void> {
    this.pagePromises.clear()
    this.sizes.clear()
    this.outline = null
    await this.task.destroy().catch(() => {})
  }
}
