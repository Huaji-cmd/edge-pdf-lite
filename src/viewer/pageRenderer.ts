import { AnnotationMode, RenderingCancelledException, TextLayer } from '@/pdfjs'
import type { RenderTask, PDFPageProxy, PageViewport } from '@/pdfjs'
import type { PdfDocument } from './pdfDocument'

/**
 * 渲染调度器。
 *
 * 三条设计约束全部来自 M0 实测（见 docs/M0-裁剪渲染实验结论.md）：
 *
 * 1. **同一页同一 key 最多只渲染一次。**
 *    pdf.js 的缓存是按"页 + 渲染意图"键的，反复发起渲染会白跑甚至把缓存绕过去。
 *    所以这里用 `doneKey` 记状态，`doneKey === wantKey` 就直接不动。
 *
 * 2. **缩放期间不下发渲染。**
 *    真实阅读路径（display intent）下，图片解码结果是被 pdf.js 缓存住的：
 *    首次渲染 171ms，之后只要 14ms。但"取消 → 重试"的循环仍然要避免 ——
 *    调用方在缩放过程中只改 `--scale` 做视觉预览，落定后才调用 request()。
 *
 * 3. **重渲染时保留旧位图。**
 *    新 canvas 先画好、挂上去，再移除旧的。绝不清空当前 canvas，
 *    否则用户会看到白闪。
 */

export const PRIORITY_VISIBLE = 0
export const PRIORITY_NEAR = 1
export const PRIORITY_FAR = 2

interface SlotState {
  pageNumber: number
  el: HTMLElement | null
  wantKey: string
  wantPriority: number
  doneKey: string
  runningKey: string
  task: RenderTask | null
  canvas: HTMLCanvasElement | null
  /** 文本层容器（可选中文字的那一层） */
  textEl: HTMLDivElement | null
  /** 当前文本层对应的渲染 key */
  textKey: string
  /** 文本层异步构建的令牌，用来丢弃过期的结果 */
  textToken: number
}

export interface RendererStats {
  /** 已渲染完成的页数（当前 key 下） */
  rendered: number
  /** 正在渲染的任务数 */
  running: number
  /** 排队等待的页数 */
  queued: number
  /** 最近一次渲染耗时（ms） */
  lastRenderMs: number
  /** 首屏是否已就绪 */
  ready: boolean
}

const round = (v: number) => Math.round(v * 1000) / 1000
const makeKey = (scale: number, dpr: number) => `${round(scale)}@${round(dpr)}`

function isCancelled(e: unknown): boolean {
  return (
    e instanceof RenderingCancelledException ||
    (e instanceof Error && /cancel/i.test(e.message))
  )
}

export class PageRenderer {
  private readonly slots = new Map<number, SlotState>()
  private running = 0
  private destroyed = false
  private lastRenderMs = 0
  private everRendered = false

  constructor(
    private readonly doc: PdfDocument,
    private readonly dpr: number,
    /** M0 实测：并发 2 在目标机上效果最好（避免多页首次渲染互相争抢） */
    private readonly concurrency = 2,
    private readonly onStats?: (s: RendererStats) => void,
    /** 是否构建文本层（选中/复制文字）。关掉它就是"lite 模式" */
    private readonly textLayerEnabled = true,
  ) {}

  // ---------------------------------------------------------------- 生命周期

  attach(pageNumber: number, el: HTMLElement): void {
    const slot = this.ensure(pageNumber)
    slot.el = el
  }

  detach(pageNumber: number): void {
    const slot = this.slots.get(pageNumber)
    if (!slot) return
    slot.el = null
    this.release(pageNumber)
  }

  /** 丢弃位图（保留状态），用于回收离屏页面的内存 —— 624 页的书不回收会爆 */
  release(pageNumber: number): void {
    const slot = this.slots.get(pageNumber)
    if (!slot) return
    if (slot.runningKey) {
      slot.task?.cancel()
    }
    if (slot.canvas) {
      slot.canvas.remove()
      slot.canvas.width = slot.canvas.height = 0
      slot.canvas = null
    }
    // 文本层同样要收掉 —— 每页几百个 span，不留着占内存和 DOM
    slot.textToken++
    slot.textEl?.remove()
    slot.textEl = null
    slot.textKey = ''
    slot.doneKey = ''
    // ⚠️ 必须把需求也清掉。
    // 之前这里只清 doneKey，导致这个 bug：
    //   位图被回收 → 页面再次可见 → request() 发现 wantKey/wantPriority 没变
    //   → 提前 return → **渲染永远排不上** → 那一页一直是空的。
    //   而一改缩放，key 变了、提前 return 失效，它就"突然好了" —— 症状极具迷惑性。
    slot.wantKey = ''
    slot.wantPriority = PRIORITY_FAR
  }

  /** 声明"这一页现在想要这个 scale 的画面" */
  request(pageNumber: number, scale: number, priority: number): void {
    if (this.destroyed) return
    const slot = this.ensure(pageNumber)
    if (!slot.el) return

    const key = makeKey(scale, this.dpr)
    const unchanged = slot.wantKey === key && slot.wantPriority === priority
    slot.wantKey = key
    slot.wantPriority = priority

    if (unchanged) {
      // 需求没变，但**只有结果确实还在（或正在渲）才能跳过**。
      // 只比 wantKey 是不够的 —— 位图可能已经被回收掉了。
      if (slot.doneKey === key || slot.runningKey === key) return
      this.pump()
      return
    }

    // 正在渲染的是别的 key → 取消它，别浪费一次完整渲染
    if (slot.runningKey && slot.runningKey !== key) {
      slot.task?.cancel()
    }
    this.pump()
  }

  /**
   * 当前"有画布 / 在排队 / 正在渲"的页号。
   * 回收时只需要遍历这一小撮（正比于视口），不用扫全部几百页。
   */
  activePages(): number[] {
    const out: number[] = []
    for (const s of this.slots.values()) {
      if (s.canvas || s.wantKey || s.runningKey) out.push(s.pageNumber)
    }
    return out
  }

  /** 某页是否已按当前需求渲染完成 */
  isReady(pageNumber: number): boolean {
    const slot = this.slots.get(pageNumber)
    return !!slot && slot.doneKey !== '' && slot.doneKey === slot.wantKey
  }

  /**
   * 诊断用：导出每一页的状态快照。
   * "某页一直空白"这类问题光看现象根本猜不出来，必须能直接看到状态机。
   * scripts/test-viewer.mjs 会读这个。
   */
  debugState(): Array<{
    p: number
    el: boolean
    want: string
    done: string
    run: string
    canvas: boolean
  }> {
    return [...this.slots.values()].map((s) => ({
      p: s.pageNumber,
      el: !!s.el,
      want: s.wantKey,
      done: s.doneKey,
      run: s.runningKey,
      canvas: !!s.canvas,
    }))
  }

  destroy(): void {
    this.destroyed = true
    for (const slot of this.slots.values()) {
      slot.task?.cancel()
      slot.textToken++
      slot.textEl?.remove()
      if (slot.canvas) {
        slot.canvas.remove()
        slot.canvas.width = slot.canvas.height = 0
      }
    }
    this.slots.clear()
  }

  // ---------------------------------------------------------------- 内部

  private ensure(pageNumber: number): SlotState {
    let slot = this.slots.get(pageNumber)
    if (!slot) {
      slot = {
        pageNumber,
        el: null,
        wantKey: '',
        wantPriority: PRIORITY_FAR,
        doneKey: '',
        runningKey: '',
        task: null,
        canvas: null,
        textEl: null,
        textKey: '',
        textToken: 0,
      }
      this.slots.set(pageNumber, slot)
    }
    return slot
  }

  private pickNext(): { slot: SlotState; key: string } | null {
    let best: SlotState | null = null
    for (const s of this.slots.values()) {
      if (!s.el || !s.wantKey) continue
      if (s.doneKey === s.wantKey) continue
      if (s.runningKey) continue
      if (!best || s.wantPriority < best.wantPriority) best = s
    }
    return best ? { slot: best, key: best.wantKey } : null
  }

  private pump(): void {
    if (this.destroyed) return
    while (this.running < this.concurrency) {
      const next = this.pickNext()
      if (!next) break
      void this.run(next.slot, next.key)
    }
  }

  private async run(slot: SlotState, key: string): Promise<void> {
    slot.runningKey = key
    this.running++
    let canvas: HTMLCanvasElement | null = null

    try {
      const [scaleStr, dprStr] = key.split('@')
      const scale = Number(scaleStr)
      const dpr = Number(dprStr)

      const page = await this.doc.getPage(slot.pageNumber)
      const size = await this.doc.getPageSize(slot.pageNumber)
      const viewport = page.getViewport({ scale })

      canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(size.width * scale * dpr))
      canvas.height = Math.max(1, Math.round(size.height * scale * dpr))
      canvas.className = 'pdf-page-canvas'
      canvas.style.width = '100%'
      canvas.style.height = '100%'

      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) throw new Error('拿不到 2d context')

      const t0 = performance.now()
      const task = page.render({
        canvas,
        canvasContext: ctx,
        viewport,
        // 真实阅读路径。不要用 print —— 它对图片页会走 putImageData 慢路径
        intent: 'display',
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        // ⚠️ 必须是 ENABLE。用 DISABLE 会把 PDF 里的批注（高亮、下划线、手写、
        // 图章……）整片不画 —— 用户会以为"我的笔记丢了"。
        // （M0 的性能实验里用 DISABLE 是为了让两边对比公平，那是一次性代码，
        //   不要把它带进阅读器。）
        annotationMode: AnnotationMode.ENABLE,
      })
      slot.task = task
      await task.promise
      this.lastRenderMs = performance.now() - t0

      // 渲染期间需求变了 → 丢弃这次结果，别挂上去
      if (slot.wantKey !== key) return

      this.commit(slot, canvas, key)
      canvas = null // 所有权已交给 DOM

      // 文本层**不阻塞画布**：画布先上屏，文本层建好再挂。
      // 用户先看到页面内容，几百毫秒后就能选中文字 —— 比"两样都等"体验好。
      if (this.textLayerEnabled) {
        void this.buildTextLayer(slot, page, viewport, key)
      }
    } catch (e) {
      if (!isCancelled(e)) {
        console.error(`[viewer] 第 ${slot.pageNumber} 页渲染失败`, e)
      }
    } finally {
      // 没被挂上去的 canvas 尽快释放显存/内存
      if (canvas) canvas.width = canvas.height = 0
      slot.task = null
      slot.runningKey = ''
      this.running--
      this.everRendered = true
      this.emitStats()
      this.pump()
    }
  }

  /** 新 canvas 先挂上，再摘旧的 —— 顺序反了会白闪 */
  private commit(slot: SlotState, canvas: HTMLCanvasElement, key: string): void {
    const old = slot.canvas
    slot.el?.appendChild(canvas)
    slot.canvas = canvas
    slot.doneKey = key
    if (old && old !== canvas) {
      old.remove()
      old.width = old.height = 0
    }
  }

  /**
   * 构建文本层 —— 让文字可以选中 / 复制 / 被浏览器查找。
   *
   * 用 pdf.js 的 `TextLayer` 类（6.x 是类，不是老的 `renderTextLayer` 函数）。
   * 它把每个文本片段渲染成绝对定位的透明 `<span>`，叠在画布上方；
   * 位置用百分比表示，字号用 `calc(Npx * var(--total-scale-factor))` ——
   * 所以调用方必须在容器上定义 `--total-scale-factor`（= 当前 scale）
   * 以及 `--scale-round-x/y`，否则 span 会全部挤在左上角。
   */
  private async buildTextLayer(
    slot: SlotState,
    page: PDFPageProxy,
    viewport: PageViewport,
    key: string,
  ): Promise<void> {
    if (slot.textKey === key) return
    const token = ++slot.textToken
    try {
      const div = document.createElement('div')
      div.className = 'text-layer'
      const layer = new TextLayer({
        textContentSource: page.streamTextContent({
          includeMarkedContent: true,
          disableNormalization: true,
        }),
        container: div,
        viewport,
      })
      await layer.render()

      // 期间需求变了（换了缩放 / 被回收）→ 丢弃这次结果
      if (slot.textToken !== token || slot.wantKey !== key) return

      const old = slot.textEl
      slot.el?.appendChild(div)
      slot.textEl = div
      slot.textKey = key
      old?.remove()
    } catch (e) {
      if (!isCancelled(e)) {
        // 文本层失败不该影响阅读 —— 记一下就好，画布还在
        console.warn(`[viewer] 第 ${slot.pageNumber} 页文本层构建失败`, e)
      }
    }
  }

  private emitStats(): void {
    if (!this.onStats) return
    let rendered = 0
    let queued = 0
    for (const s of this.slots.values()) {
      if (s.doneKey && s.doneKey === s.wantKey) rendered++
      else if (s.el && s.wantKey && !s.runningKey) queued++
    }
    this.onStats({
      rendered,
      running: this.running,
      queued,
      lastRenderMs: this.lastRenderMs,
      ready: this.everRendered && this.running === 0 && queued === 0,
    })
  }
}
