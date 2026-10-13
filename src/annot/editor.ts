/**
 * 批注工具交互。
 *
 * 把「指针事件」翻译成「批注数据」，其余一概不管（重绘、计数、弹框都由宿主负责）。
 * 单独成类的理由：这段逻辑分支很多（绘画 / 擦除 / 选文 / 弹框 / 选中后拖动改大小），
 * 混在 `PdfViewer.vue` 里会让那个已经很大的组件彻底没法读。
 *
 * 四条交互约定：
 *   · **标记类工具（高亮/下划线/删除线）绝不拦截指针事件** —— 否则浏览器没法选中文字。
 *     它们只在 pointerup 时读一次选区。
 *   · **绘图类工具（手写/矩形）要 preventDefault + 指针捕获** —— 否则拖出页外会丢事件。
 *   · **擦除是"点哪儿擦哪儿"**，不做划过批量擦（误擦风险太高，而且我们有撤销）。
 *   · **选中后的拖动/改大小只在 `select` 模式下生效**，且必须**工具为空**。
 *     这条由上层保证（App.vue 里"选工具→自动回 select""切 pan→自动清工具"），
 *     否则会留下"点下去到底是画还是拖"的歧义状态。
 */

import type {
  Annotation,
  AnnotKind,
  TextMarkupAnnot,
  AreaAnnot,
  InkAnnot,
  RectAnnot,
  FreeTextAnnot,
  ToolKind,
  Rgb,
  Rect,
  PointerMode,
} from './types'
import {
  DEFAULT_LINE_WIDTH,
  newAnnotId,
  isMarkupTool,
  isResizable,
  bboxOfQuads,
  bboxOfPoints,
  normalizeRect,
} from './types'
import type { PageTransform } from './coords'
import { eventToPageCss, simplifyStroke } from './coords'
import type { HandleId } from './geometry'
import { HANDLES, mapAnnotToRect, resizeRect, translateRect } from './geometry'
import type { AnnotationStore } from './store'
import type { AnnotLayer } from './annotLayer'
import { harvestSelection, clearSelection } from './textSelect'

export interface TextRequestResult {
  text: string
  /** 以页内 CSS 为单位的框尺寸 */
  cssWidth: number
  cssHeight: number
}

export interface EditorHost {
  store: AnnotationStore
  layer: AnnotLayer
  scale(): number
  /** 指针落在哪一页；不在任何页上返回 null */
  locate(e: { clientX: number; clientY: number }): { pageNumber: number; slotEl: HTMLElement } | null
  transform(pageNumber: number, scale: number): Promise<PageTransform | null>
  /** 擦除容差（页面空间 pt）—— 由宿主按当前缩放换算，保证屏幕手感一致 */
  eraserTolerance(): number
  /** 当前工具对应的颜色（用户在工具栏色板上选的） */
  colorFor(kind: AnnotKind): Rgb
  /**
   * 当前手写笔尖粗细（pt）—— 工具栏三档之一。
   *
   * 和 `colorFor` 同一个路子：取值来自宿主（App 的响应式状态 + localStorage），
   * 编辑器只负责"用"，不负责"存"。不这么做的话，用户改了粗细要重新选工具才生效。
   */
  inkWidth(): number
  /** 弹文本框；用户取消返回 null */
  requestText(pageNumber: number, cssX: number, cssY: number, initial?: string): Promise<TextRequestResult | null>
  /** 批注增删后通知宿主（重绘 + 更新计数） */
  onChange(pageNumber: number, action: 'add' | 'remove' | 'update'): void
  /** 选中项变化；id 为 null = 取消选中。宿主据此显示/隐藏控制手柄 */
  onSelectionChange(id: string | null): void
  /** 选中项的几何变了（拖动过程中，手柄也要跟着走） */
  onSelectionGeometry(): void
  /** 撤销/重做栈变了 —— 按钮的可用态要跟着更新 */
  onHistoryChange(): void
  /**
   * 当前工具"用完自己退出了"。
   *
   * 只有文本框会触发：它是**一次性**的（弹框 → 得到一个对象），
   * 建完必须把工具交还出去，否则用户想立刻把它拖开时，指针落到框上又被
   * 当成"要新建一个文本框"，于是弹框、拖动无效 —— 实测就是这个症状。
   *
   * 手写/方框/高亮**不退出**：在扫描版教材上连续写十几笔是常态，
   * 每笔都要重新点一次工具会让人崩溃。
   */
  onToolAutoExit(): void
}

/** 一次"正在画"的会话（手写 / 矩形 / 区域高亮） */
interface Session {
  pageNumber: number
  slotEl: HTMLElement
  tf: PageTransform
  kind: 'ink' | 'rect' | 'area'
  /** ink：[x,y,x,y,...]；rect / area：[x0,y0,x1,y1] */
  points: number[]
  moved: boolean
}

/** 一次"拖动 / 改大小"的会话（选中批注之后） */
interface Manip {
  pageNumber: number
  slotEl: HTMLElement
  tf: PageTransform
  /** 按下**之前**的完整快照 —— 松手时用它补一条 `edit` 历史 */
  original: Annotation
  startRect: Rect
  /** 按下时的页面坐标 */
  startPage: [number, number]
  /** 按下时的屏幕坐标（判定"有没有真的拖动"用，避免点一下就挪 1pt） */
  startClient: [number, number]
  kind: 'move' | 'resize'
  handle: HandleId | null
  moved: boolean
}

/** 宿主在 pointerdown 时告诉编辑器的上下文 */
export interface PointerHint {
  mode: PointerMode
  /** 落在哪个手柄上（不在手柄上为 null） */
  handle: HandleId | null
  /** 落在选中框的框体上（可拖动区域） */
  onBody: boolean
}

/** 小于这个屏幕位移（px）不算拖动 —— 否则"想选中结果挪了 1pt" */
const DRAG_THRESHOLD = 3

function nowIso(): string {
  return new Date().toISOString()
}

export class AnnotEditor {
  private tool: ToolKind = 'none'
  private session: Session | null = null
  private manip: Manip | null = null
  private pointerId: number | null = null
  private selectedId: string | null = null
  private manipRaf = 0

  constructor(private readonly host: EditorHost) {}

  getTool(): ToolKind {
    return this.tool
  }

  /** 工具是否在"接管指针"状态 —— 宿主据此切换光标、决定是否拦截事件 */
  isActive(): boolean {
    return this.tool !== 'none'
  }

  setTool(t: ToolKind): void {
    // 同值早退：文本框建完会自己置 none 并通知宿主，宿主回头再 setTool('none') 时
    // 不能顺手把"刚建好、正被选中"的那个框的选中态清掉
    if (this.tool === t) return
    this.cancelSession()
    this.setSelected(null)
    this.tool = t
  }

  // ---------------------------------------------------------------- 选中

  getSelectedId(): string | null {
    return this.selectedId
  }

  setSelected(id: string | null): void {
    if (this.selectedId === id) return
    this.selectedId = id
    this.host.onSelectionChange(id)
  }

  /** 选中的批注是否还能改大小（高亮类只允许平移） */
  canResizeSelected(): boolean {
    const a = this.selectedId ? this.host.store.get(this.selectedId) : null
    return !!a && isResizable(a)
  }

  /** 给选中的批注换颜色（走历史，可撤销） */
  setSelectedColor(color: Rgb): void {
    const a = this.selectedId ? this.host.store.get(this.selectedId) : null
    if (!a || sameColor(a.color, color)) return
    this.host.store.commitEdit(a, { ...a, color, modified: nowIso() })
    this.host.onChange(a.pageNumber, 'update')
    this.host.onHistoryChange()
  }

  /** 删除选中的批注（可撤销） */
  removeSelected(): boolean {
    const a = this.selectedId ? this.host.store.get(this.selectedId) : null
    if (!a) return false
    const pn = a.pageNumber
    this.setSelected(null)
    if (!this.host.store.remove(a.id)) return false
    this.host.onChange(pn, 'remove')
    this.host.onHistoryChange()
    return true
  }

  /** 双击选中项：重新编辑文字（目前只有文本框有文字） */
  async editSelectedText(): Promise<void> {
    const a = this.selectedId ? this.host.store.get(this.selectedId) : null
    if (!a || a.kind !== 'freetext') return
    const r = await this.host.requestText(a.pageNumber, 0, 0, a.text)
    if (!r) return
    const next: FreeTextAnnot = { ...a, text: r.text, contents: r.text, modified: nowIso() }
    this.host.store.commitEdit(a, next)
    this.host.onChange(a.pageNumber, 'update')
    this.host.onHistoryChange()
  }

  // ---------------------------------------------------------------- 指针

  async pointerDown(e: PointerEvent, hint: PointerHint): Promise<void> {
    if (e.button !== 0) return

    // ① 工具优先：选了工具就是要画，不跟"选中拖动"抢
    if (this.tool !== 'none') {
      await this.pointerDownTool(e)
      return
    }

    // ② 没工具 + select 模式：选中 / 拖动 / 改大小
    if (hint.mode === 'select') {
      await this.pointerDownSelect(e, hint)
      return
    }

    // ③ scroll 模式：什么都不做，把事件还给浏览器（文字选择照常）
  }

  pointerMove(e: PointerEvent): void {
    const m = this.manip
    if (m) {
      this.moveManip(e)
      return
    }
    const s = this.session
    if (!s) return
    const [cssX, cssY] = eventToPageCss(e, s.slotEl)
    const [px, py] = s.tf.toPage(cssX, cssY)

    if (s.kind === 'ink') {
      const n = s.points.length
      const dx = px - s.points[n - 2]!
      const dy = py - s.points[n - 1]!
      // 抽稀：太密的点没有信息量，只会让 InkList 和重绘都变笨重
      if (Math.hypot(dx, dy) < 1.0) return
      s.points.push(px, py)
    } else {
      s.points[2] = px
      s.points[3] = py
    }
    s.moved = true
    this.paintDraft()
  }

  pointerUp(e: PointerEvent): void {
    this.releaseCapture()

    if (this.manip) {
      this.endManip()
      return
    }

    // 标记类工具：这一刻读选区
    if (isMarkupTool(this.tool)) {
      void this.commitMarkup(e)
      return
    }

    const s = this.session
    if (!s) return
    this.session = null

    // 清掉临时图形
    this.host.layer.setDraft(s.pageNumber, null)

    if (!s.moved) {
      // 只是点了一下 —— 不生成批注。避免误触留下无意义的空图形。
      void this.host.layer.render(s.pageNumber, this.host.scale())
      return
    }

    let annot: Annotation | null = null
    if (s.kind === 'ink') {
      const pts = simplifyStroke(s.points)
      if (pts.length < 2) {
        void this.host.layer.render(s.pageNumber, this.host.scale())
        return
      }
      annot = {
        kind: 'ink',
        id: newAnnotId(),
        pageNumber: s.pageNumber,
        rect: bboxOfPoints(pts, this.host.inkWidth() / 2 + 0.5),
        color: this.host.colorFor('ink'),
        opacity: 1,
        strokes: [pts],
        lineWidth: this.host.inkWidth(),
        created: nowIso(),
        modified: nowIso(),
      } satisfies InkAnnot
    } else {
      const r = normalizeRect([s.points[0]!, s.points[1]!, s.points[2]!, s.points[3]!])
      // 面积太小视为误触
      if (r[2] - r[0] < 2 || r[3] - r[1] < 2) {
        void this.host.layer.render(s.pageNumber, this.host.scale())
        return
      }
      annot =
        s.kind === 'area'
          ? ({
              kind: 'area',
              id: newAnnotId(),
              pageNumber: s.pageNumber,
              rect: r,
              color: this.host.colorFor('area'),
              // ⚠️ 必须 1：区域高亮靠 multiply 染背景，alpha<1 会把内容冲淡
              opacity: 1,
              created: nowIso(),
              modified: nowIso(),
            } satisfies AreaAnnot)
          : ({
              kind: 'rect',
              id: newAnnotId(),
              pageNumber: s.pageNumber,
              rect: r,
              color: this.host.colorFor('rect'),
              opacity: 1,
              lineWidth: DEFAULT_LINE_WIDTH.rect,
              created: nowIso(),
              modified: nowIso(),
            } satisfies RectAnnot)
    }

    this.host.store.add(annot)
    this.host.onChange(s.pageNumber, 'add')
    this.host.onHistoryChange()
  }

  /** 指针丢失 / 工具切换时兜底清理 */
  cancelSession(): void {
    const s = this.session
    if (!s) return
    this.session = null
    this.host.layer.setDraft(s.pageNumber, null)
    void this.host.layer.render(s.pageNumber, this.host.scale())

    const m = this.manip
    if (m) {
      this.manip = null
      // 取消 = 回到按下之前，不当成一次编辑
      this.host.store.replace(m.original.id, m.original)
      this.host.onChange(m.pageNumber, 'update')
    }
  }

  /** 撤销：交给 store，宿主负责重绘 */
  undo(): boolean {
    const ok = this.host.store.undo()
    if (ok) {
      this.setSelected(null)
      this.host.layer.invalidateAll()
      void this.host.layer.renderAll(this.host.scale())
      this.host.onHistoryChange()
    }
    return ok
  }

  /** 重做：把刚撤销的再走一遍 */
  redo(): boolean {
    const ok = this.host.store.redo()
    if (ok) {
      this.setSelected(null)
      this.host.layer.invalidateAll()
      void this.host.layer.renderAll(this.host.scale())
      this.host.onHistoryChange()
    }
    return ok
  }

  // ---------------------------------------------------------------- 内部：工具

  private async pointerDownTool(e: PointerEvent): Promise<void> {
    if (isMarkupTool(this.tool)) return // 要让浏览器自己去选中文字

    const loc = this.host.locate(e)
    if (!loc) return
    const tf = await this.host.transform(loc.pageNumber, this.host.scale())
    if (!tf) return

    const [cssX, cssY] = eventToPageCss(e, loc.slotEl)
    const [px, py] = tf.toPage(cssX, cssY)

    if (this.tool === 'eraser') {
      e.preventDefault()
      const hit = this.host.store.hitTest(
        loc.pageNumber,
        px,
        py,
        this.host.eraserTolerance(),
      )
      if (hit) {
        if (this.selectedId === hit.id) this.setSelected(null)
        this.host.store.remove(hit.id)
        this.host.onChange(loc.pageNumber, 'remove')
        this.host.onHistoryChange()
      }
      return
    }

    if (this.tool === 'freetext') {
      e.preventDefault()
      const r = await this.host.requestText(loc.pageNumber, cssX, cssY)
      if (r && r.text.trim()) {
        // cssY 是点击位置，文本框往下长（页内 CSS 的 y 向下）
        const w = r.cssWidth / tf.scale
        const h = r.cssHeight / tf.scale
        const annot: FreeTextAnnot = {
          kind: 'freetext',
          id: newAnnotId(),
          pageNumber: loc.pageNumber,
          rect: normalizeRect([px, py - h, px + w, py]),
          color: this.host.colorFor('freetext'),
          opacity: 1,
          contents: r.text,
          text: r.text,
          fontSize: 11,
          created: nowIso(),
          modified: nowIso(),
        }
        this.host.store.add(annot)
        this.host.onChange(loc.pageNumber, 'add')
        this.host.onHistoryChange()
        // 新建的框直接选中，用户接着就能拖动/改大小。
        // 顺序很重要：先置 tool=none（否则下一次 pointerdown 又走"新建"分支），
        // 再通知宿主同步 UI，最后设选中。
        this.tool = 'none'
        this.host.onToolAutoExit()
        this.setSelected(annot.id)
      }
      return
    }

    // 手写 / 矩形：开始一次绘制会话
    e.preventDefault()
    this.capture(e, loc.slotEl)
    this.session = {
      pageNumber: loc.pageNumber,
      slotEl: loc.slotEl,
      tf,
      kind: this.tool === 'ink' ? 'ink' : this.tool === 'area' ? 'area' : 'rect',
      points: [px, py],
      moved: false,
    }
  }

  /**
   * 把当前选区变成标记类批注。
   *
   * ⚠️ 对外开放：触屏上选区是 PdfViewer 自己划出来的（见那里的 markupTouch），
   *    划完要调这个来提交。鼠标仍然走 `pointerUp` 里的原生选区分支。
   */
  async commitMarkup(e: PointerEvent): Promise<void> {
    const tool = this.tool
    if (tool === 'none') return
    const loc = this.host.locate(e)
    if (!loc) return
    const tf = await this.host.transform(loc.pageNumber, this.host.scale())
    if (!tf) return

    const h = harvestSelection(loc.slotEl, tf)
    if (!h) return

    const kind = tool as TextMarkupAnnot['kind']
    const annot: TextMarkupAnnot = {
      kind,
      id: newAnnotId(),
      pageNumber: loc.pageNumber,
      // ⚠️ rect 必须是所有四边形的包围盒，否则查看器按 rect 裁 /AP 会把高亮截断
      rect: bboxOfQuads(h.quads),
      color: this.host.colorFor(kind),
      // ⚠️ 高亮必须 1：它靠 multiply 染背景，alpha<1 会把黑字冲成灰色
      opacity: kind === 'highlight' ? 1 : 0.9,
      quads: h.quads,
      overlaidText: h.text,
      contents: h.text.replace(/\s+/g, ' ').slice(0, 200),
      created: nowIso(),
      modified: nowIso(),
    }
    this.host.store.add(annot)
    clearSelection()
    this.host.onChange(loc.pageNumber, 'add')
    this.host.onHistoryChange()
  }

  // ---------------------------------------------------------------- 内部：选中与拖动

  private async pointerDownSelect(e: PointerEvent, hint: PointerHint): Promise<void> {
    const current = this.selectedId ? this.host.store.get(this.selectedId) : null

    // 手柄 / 框体：直接进入拖动或改大小
    if (current && (hint.handle || hint.onBody)) {
      const canResize = isResizable(current)
      const kind: 'move' | 'resize' = hint.handle && canResize ? 'resize' : 'move'
      await this.beginManip(e, current, kind, hint.handle)
      return
    }

    // 空白：命中检测 → 选中并准备拖动；没命中就取消选中
    const loc = this.host.locate(e)
    if (!loc) {
      this.setSelected(null)
      return
    }
    const tf = await this.host.transform(loc.pageNumber, this.host.scale())
    if (!tf) return
    const [cssX, cssY] = eventToPageCss(e, loc.slotEl)
    const [px, py] = tf.toPage(cssX, cssY)

    // 选中的容差比橡皮擦小：点批注边上 8px 就把"想选文字"变成"拖动批注"会很难受
    const hit = this.host.store.hitTest(loc.pageNumber, px, py, 4 / Math.max(this.host.scale(), 0.01))
    if (!hit) {
      this.setSelected(null)
      return // 不 preventDefault：把事件留给浏览器做文字选择
    }

    e.preventDefault()
    this.setSelected(hit.id)
    await this.beginManip(e, hit, 'move', null)
  }

  private async beginManip(
    e: PointerEvent,
    a: Annotation,
    kind: 'move' | 'resize',
    handle: HandleId | null,
  ): Promise<void> {
    const loc = this.host.locate(e)
    if (!loc) return
    const tf = await this.host.transform(loc.pageNumber, this.host.scale())
    if (!tf) return
    const [cssX, cssY] = eventToPageCss(e, loc.slotEl)
    const [px, py] = tf.toPage(cssX, cssY)

    e.preventDefault()
    this.capture(e, loc.slotEl)
    this.manip = {
      pageNumber: loc.pageNumber,
      slotEl: loc.slotEl,
      tf,
      // ⚠️ 必须存快照。后面 replace 会把数组里的对象换成新对象，
      // 但 **不会改动原对象** —— 所以这份 original 到松手时仍然是"拖动前"的样子。
      original: a,
      startRect: a.rect,
      startPage: [px, py],
      startClient: [e.clientX, e.clientY],
      kind,
      handle,
      moved: false,
    }
  }

  private moveManip(e: PointerEvent): void {
    const m = this.manip
    if (!m) return
    const [cssX, cssY] = eventToPageCss(e, m.slotEl)
    const [px, py] = m.tf.toPage(cssX, cssY)
    const dx = px - m.startPage[0]
    const dy = py - m.startPage[1]

    if (!m.moved) {
      const sx = e.clientX - m.startClient[0]
      const sy = e.clientY - m.startClient[1]
      if (Math.hypot(sx, sy) < DRAG_THRESHOLD) return
      m.moved = true
    }

    const to: Rect =
      m.kind === 'move' ? translateRect(m.startRect, dx, dy) : resizeRect(m.startRect, m.handle!, dx, dy)

    // ⚠️ 走 mapAnnotToRect 而不是只改 rect —— 高亮还有 quads、手写还有 strokes，
    // 只改 rect 会造成"框动了、内容没动"，写回 PDF 后 /Rect 与 /QuadPoints 不一致
    const next = mapAnnotToRect(m.original, m.startRect, to)
    this.host.store.replace(m.original.id, next)
    this.scheduleManipPaint()
  }

  private endManip(): void {
    const m = this.manip
    if (!m) return
    this.manip = null

    if (m.moved) {
      const after = this.host.store.get(m.original.id)
      if (after) {
        // 一次拖动 = 一条历史。过程中那几十次 replace 都不入栈。
        this.host.store.commitEdit(m.original, after)
        this.host.onHistoryChange()
      }
    } else {
      // 没真的拖动：把可能的抖动还原掉（mapAnnotToRect 在无位移时会原样返回，这里只是保险）
      this.host.store.replace(m.original.id, m.original)
    }
    this.host.layer.invalidate(m.pageNumber)
    void this.host.layer.render(m.pageNumber, this.host.scale())
    this.host.onSelectionGeometry()
  }

  /** 拖动过程中的重绘做 rAF 节流：pointermove 一秒能来 100+ 次 */
  private scheduleManipPaint(): void {
    if (this.manipRaf) return
    this.manipRaf = requestAnimationFrame(() => {
      this.manipRaf = 0
      const m = this.manip
      if (!m) return
      this.host.layer.invalidate(m.pageNumber)
      void this.host.layer.render(m.pageNumber, this.host.scale())
      this.host.onSelectionGeometry()
    })
  }

  // ---------------------------------------------------------------- 内部：杂项

  /** 把当前会话画成"临时图形"（不进 store，所以不会污染撤销栈） */
  private paintDraft(): void {
    const s = this.session
    if (!s) return
    let draft: Annotation | null = null
    if (s.kind === 'ink') {
      draft = {
        kind: 'ink',
        id: '__draft__',
        pageNumber: s.pageNumber,
        rect: bboxOfPoints(s.points, 2),
        color: this.host.colorFor('ink'),
        opacity: 1,
        strokes: [s.points.slice()],
        lineWidth: this.host.inkWidth(),
        created: nowIso(),
        modified: nowIso(),
      }
    } else {
      const r = normalizeRect([s.points[0]!, s.points[1]!, s.points[2]!, s.points[3]!])
      draft =
        s.kind === 'area'
          ? {
              kind: 'area',
              id: '__draft__',
              pageNumber: s.pageNumber,
              rect: r,
              color: this.host.colorFor('area'),
              opacity: 1,
              created: nowIso(),
              modified: nowIso(),
            }
          : {
              kind: 'rect',
              id: '__draft__',
              pageNumber: s.pageNumber,
              rect: r,
              color: this.host.colorFor('rect'),
              opacity: 1,
              lineWidth: DEFAULT_LINE_WIDTH.rect,
              created: nowIso(),
              modified: nowIso(),
            }
    }
    this.host.layer.setDraft(s.pageNumber, draft)
    // draft 每次都在变，必须强制重绘（render 内部按 scale 去重，所以要先 invalidate）
    this.host.layer.invalidate(s.pageNumber)
    void this.host.layer.render(s.pageNumber, this.host.scale())
  }

  private capture(e: PointerEvent, el: HTMLElement): void {
    try {
      el.setPointerCapture(e.pointerId)
      this.pointerId = e.pointerId
    } catch {
      /* 某些环境不支持捕获，退化为普通监听 */
    }
  }

  private releaseCapture(): void {
    if (this.pointerId === null) return
    try {
      ;(this.manip?.slotEl ?? this.session?.slotEl)?.releasePointerCapture(this.pointerId)
    } catch {
      /* ignore */
    }
    this.pointerId = null
  }
}

function sameColor(a: Rgb, b: Rgb): boolean {
  return Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3 && Math.abs(a[2] - b[2]) < 1e-3
}

/** 手柄列表（对外暴露，供宿主渲染 DOM） */
export { HANDLES }
