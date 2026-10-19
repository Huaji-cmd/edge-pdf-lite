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
  /** 自增 id —— 诊断时用来区分"同一个 slot 还是重挂过的新 slot" */
  id: number
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
      id: ++this.slotSeq,
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
  /** 每页最后一次 render 走到了哪条分支（诊断用） */
  private lastPath = new Map<number, string>()
  /** render 的全局调用序号 —— 让"看起来一样"的两次记录能区分开 */
  private seq = 0
  private slotSeq = 0

  async render(pageNumber: number, scale: number, force = false): Promise<void> {
    const n = ++this.seq
    const slot = this.slots.get(pageNumber)
    if (!slot) {
      this.lastPath.set(pageNumber, `#${n} no-slot`)
      return
    }

    const list = [...this.getData(pageNumber), ...this.draftList(pageNumber)]
    const draftId = this.drafts.get(pageNumber)?.id ?? '-'
    this.lastPath.set(
      pageNumber,
      `#${n} enter list=${list.length} force=${force} draft=${draftId}`,
    )

    if (!list.length) {
      /*
       * 🔴 没东西可画 → 两层都收掉。**这里必须 `++slot.token`**。
       *
       * 这条分支原来直接 return，没动 token —— 于是"删除前已经出发、还在
       * `await transformFor()` 里排队"的那个 render 手里的 token 依然是最新的，
       * 它下面那句 `token !== slot.token` 闸门会**放行**，然后在几百毫秒后把
       * **删除之前抓到的旧快照**（list=1）画回画布上。
       *
       * 用户看到的就是：删掉页面上最后一条批注，字还在原地；再画任何一笔
       * （触发一次新的 render）它才消失 —— 因为新 render 带的是空快照。
       *
       * 判据见 scripts/test-interact.mjs 的 [12b]。
       */
      ++slot.token
      const hadOver = !!slot.over
      this.drop(slot, 'under')
      this.drop(slot, 'over')
      slot.renderedScale = 0
      this.lastPath.set(pageNumber, `#${n} drop list=0 hadOver=${hadOver}`)
      return
    }
    if (!force && slot.renderedScale === scale) {
      this.lastPath.set(pageNumber, `#${n} skip same-scale list=${list.length}`)
      return
    }

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
      this.lastPath.set(pageNumber, `#${n} abort tf=${!!tf} stale=${token !== slot.token}`)
      return
    }
    if (!slot.el.isConnected) {
      this.lastPath.set(pageNumber, `#${n} abort detached`)
      return
    }

    /*
     * 🔴 **落笔前再取一次数据**。
     *
     * 上面那份 `list` 是 `await` 之前抓的：等 transform 的这段时间里用户完全
     * 可能已经把这条批注删掉了（点删除到真正重绘之间隔了事件循环）。
     * 拿旧快照去画，等于"画了一条已经不存在的批注"。
     * token 闸门挡不住这种情况 —— 删除时的 render 走的是空列表分支，压根没抢 token。
     */
    const fresh = [...this.getData(pageNumber), ...this.draftList(pageNumber)]
    if (!fresh.length) {
      this.drop(slot, 'under')
      this.drop(slot, 'over')
      slot.renderedScale = 0
      this.lastPath.set(pageNumber, `#${n} stale-empty list=0 scale=${scale}`)
      return
    }

    this.paint(slot, 'under', fresh.filter((a) => blendGroupOf(a) === 'under'), tf)
    this.paint(slot, 'over', fresh.filter((a) => blendGroupOf(a) === 'over'), tf)
    slot.renderedScale = scale
    this.lastPath.set(pageNumber, `#${n} paint list=${fresh.length} scale=${scale}`)
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
    // 诊断用：测试要区分 under（高亮）/ over（其余）两层
    canvas.dataset.eplLayer = layer
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

  /**
   * 只读诊断：每页的 slot 状态。
   *
   * 存在的理由：出现过「最后一条批注删掉后，画布上的字还在」——
   * 那条分支（`list` 为空 → drop 两层）只在**这一页还有 slot** 时才会执行，
   * 光看 DOM 分不清是"没重绘"还是"slot 根本不在了"。测试直接读这里。
   */
  debugState(): Array<{
    page: number
    slotId: number
    overConnected: boolean
    underConnected: boolean
    hasUnder: boolean
    hasOver: boolean
    renderedScale: number
    token: number
    connected: boolean
    /** 这一页现在有几条要画（含 draft）—— 空的话下次 render 会直接 drop */
    listLen: number
    hasDraft: boolean
    lastPath: string
  }> {
    return [...this.slots.entries()].map(([pn, s]) => ({
      page: pn,
      slotId: s.id,
      overConnected: !!s.over?.isConnected,
      underConnected: !!s.under?.isConnected,
      hasUnder: !!s.under,
      hasOver: !!s.over,
      renderedScale: s.renderedScale,
      token: s.token,
      connected: s.el.isConnected,
      listLen: this.getData(pn).length,
      hasDraft: this.drafts.has(pn),
      lastPath: this.lastPath.get(pn) ?? '', 
    }))
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
