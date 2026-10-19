/**
 * 每页一个批注浮层的管理。
 *
 * 三条硬约束（都是踩过坑才定下来的）：
 *
 * 1. **浮层必须 `pointer-events: none`。**
 *    它盖在文本层上面，如果不透传事件，"选中文字→高亮"这条主路径直接废掉。
 *    所有交互统一在页元素上处理。
 *
 * 2. **只有真的有东西要画才创建 canvas。**
 *    600 页的文档、每页一个 2× 位图 canvas，光内存就爆了。没批注的页不建。
 *
 * 3. **尺寸按当前 scale 重算，缩放后必须重绘。**
 *    批注数据存的是页面坐标（与缩放无关），但画出来的位图与 scale 绑定 ——
 *    所以 scale 落定后要重画，而不是让浏览器拉伸旧位图（那会糊）。
 *
 * 4. **每页两层 canvas，不能合成一层。**
 *    `under` 层带 `mix-blend-mode: multiply`（只有高亮），`over` 层正常合成。
 *    合成一层的话，要么高亮盖住文字、要么删除线/手写被 multiply 吃成黑的。
 *    两层都遵守第 2 条：没东西可画就不建。
 */

import type { Annotation } from './types'
import { PageTransform } from './coords'
import { drawPage, blendGroupOf } from './draw'
import type { PdfDocument } from '@/viewer/pdfDocument'

/** 一页的两个批注层。分别建、分别收 —— 只有高亮的页不会多出一张空 canvas */
type Layer = 'under' | 'over'

interface Slot {
  el: HTMLElement
  /** 高亮（multiply 混合，染背景） */
  under: HTMLCanvasElement | null
  /** 其余批注（正常合成，压在内容之上） */
  over: HTMLCanvasElement | null
  /** 当前 canvas 对应的 scale —— 不一致就得重建位图 */
  renderedScale: number
  /** 防止异步竞态：只有最新一次请求可以提交结果 */
  token: number
}

const LAYER_CLASS: Record<Layer, string> = {
  under: 'annot-layer annot-layer-under',
  over: 'annot-layer annot-layer-over',
}

export class AnnotLayer {
  private slots = new Map<number, Slot>()
  private transforms = new Map<string, PageTransform>()
  private getData: (pageNumber: number) => readonly Annotation[]
  /** 正在编辑、还没落库的临时批注（每页最多一个） */
  private drafts = new Map<number, Annotation>()

  constructor(
    private readonly doc: PdfDocument,
    private readonly dpr: number,
    getData: (pageNumber: number) => readonly Annotation[],
  ) {
    this.getData = getData
  }

  attach(pageNumber: number, el: HTMLElement): void {
    const prev = this.slots.get(pageNumber)
    if (prev && prev.el === el) return
    this.slots.set(pageNumber, {
      el,
      under: prev?.under ?? null,
      over: prev?.over ?? null,
      renderedScale: 0,
      token: 0,
    })
  }

  detach(pageNumber: number): void {
    const s = this.slots.get(pageNumber)
    if (!s) return
    this.drop(s, 'under')
    this.drop(s, 'over')
    this.slots.delete(pageNumber)
  }

  /** 收掉一层：从 DOM 摘除并把位图尺寸归零，让浏览器真的释放显存 */
  private drop(s: Slot, layer: Layer): void {
    const c = s[layer]
    if (!c) return
    c.remove()
    c.width = c.height = 0
    s[layer] = null
  }

  /**
   * 数据变了：把某页标记为待重绘。
   *
   * `clearNow` 给**删除**用：同步把画布清空，不等异步重绘。
   *
   * 🔴 为什么需要这个 —— 重绘是 async 的（要先拿 PageTransform），中间有**三处**
   *    静默 return（拿不到 transform / 被更新的请求顶掉 / slot 已脱离 DOM）。
   *    只要撞上其中一条，被删掉的那条就会**留在屏幕上**，而 store 里已经没有了：
   *    用户看到的是「删了还在、点不着、刷新才消失」。
   *    删除是"只会变少"的确定性事件，先清空再重画是安全的（画布本来就要重画），
   *    而且用户点下去立刻见效，不用等几十毫秒。
   */
  invalidate(pageNumber: number, clearNow = false): void {
    const s = this.slots.get(pageNumber)
    if (!s) return
    s.renderedScale = 0
    if (!clearNow) return
    for (const layer of ['under', 'over'] as const) {
      const c = s[layer]
      if (!c) continue
      const ctx = c.getContext('2d')
      if (!ctx) continue
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, c.width, c.height)
    }
  }

  invalidateAll(): void {
    for (const s of this.slots.values()) s.renderedScale = 0
  }

  /** 设置/清除"正在编辑"的临时图形 */
  setDraft(pageNumber: number, a: Annotation | null): void {
    if (a) this.drafts.set(pageNumber, a)
    else this.drafts.delete(pageNumber)
  }

  clearDrafts(): void {
    this.drafts.clear()
  }

  private draftList(pageNumber: number): Annotation[] {
    const d = this.drafts.get(pageNumber)
    return d ? [d] : []
  }

  private async transformFor(pageNumber: number, scale: number): Promise<PageTransform | null> {
    const key = `${pageNumber}@${scale}`
    const hit = this.transforms.get(key)
    if (hit) return hit
    try {
      const page = await this.doc.getPage(pageNumber)
      const vp = page.getViewport({ scale })
      const tf = new PageTransform(vp)
      // 只留最近几十个，避免 600 页 × 多个 scale 把缓存撑爆
      if (this.transforms.size > 80) this.transforms.clear()
      this.transforms.set(key, tf)
      return tf
    } catch {
      return null
    }
  }

  /**
   * 重绘一页。
   *
   * `force` 跳过 `renderedScale === scale` 的早退。**删除**时一定要传 ——
   * 早退本来是省一次重复绘制的优化，但在删除语义下它会变成"该重画却没重画"。
   */
  async render(pageNumber: number, scale: number, force = false): Promise<void> {
    const slot = this.slots.get(pageNumber)
    if (!slot) return

    const list = [...this.getData(pageNumber), ...this.draftList(pageNumber)]

    if (!list.length) {
      // 没东西可画 → 两层都收掉
      this.drop(slot, 'under')
      this.drop(slot, 'over')
      slot.renderedScale = 0
      return
    }
    if (!force && slot.renderedScale === scale) return

    const token = ++slot.token
    const tf = await this.transformFor(pageNumber, scale)
    if (!tf || token !== slot.token) {
      /*
       * ⚠️ 拿不到 transform（页面正在回收 / 换缩放）或这次请求已被更新的顶掉时，
       * **旧图不能就这么留着** —— 数据可能已经变了（尤其是删除）。
       * 清掉比"继续显示一份过期内容"安全：下一次 render 会补回来。
       * 只在"自己还是最新请求"时清，避免把新请求刚画好的图擦掉。
       */
      if (token === slot.token) {
        this.drop(slot, 'under')
        this.drop(slot, 'over')
        slot.renderedScale = 0
      }
      return
    }
    if (!slot.el.isConnected) return

    this.paint(slot, 'under', list.filter((a) => blendGroupOf(a) === 'under'), tf)
    this.paint(slot, 'over', list.filter((a) => blendGroupOf(a) === 'over'), tf)
    slot.renderedScale = scale
  }

  /** 把一组批注画进指定层；这一层没内容就把 canvas 收掉 */
  private paint(slot: Slot, layer: Layer, list: Annotation[], tf: PageTransform): void {
    if (!list.length) {
      this.drop(slot, layer)
      return
    }
    let canvas = slot[layer]
    const pw = Math.max(1, Math.round(tf.cssWidth * this.dpr))
    const ph = Math.max(1, Math.round(tf.cssHeight * this.dpr))
    if (!canvas) {
      canvas = document.createElement('canvas')
      canvas.className = LAYER_CLASS[layer]
      slot[layer] = canvas
      slot.el.appendChild(canvas)
    }
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw
      canvas.height = ph
    }
    drawPage(canvas, tf, list, this.dpr)
  }

  /** 重绘所有已挂载的页（缩放落定 / 数据批量变化时用） */
  async renderAll(scale: number): Promise<void> {
    const pns = [...this.slots.keys()]
    await Promise.all(pns.map((pn) => this.render(pn, scale)))
  }

  destroy(): void {
    for (const s of this.slots.values()) {
      this.drop(s, 'under')
      this.drop(s, 'over')
    }
    this.slots.clear()
    this.transforms.clear()
    this.drafts.clear()
  }
}
