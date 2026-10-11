<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import type { PdfDocument } from './pdfDocument'
import { computeLayout } from './layout'
import {
  PageRenderer,
  PRIORITY_VISIBLE,
  PRIORITY_NEAR,
  type RendererStats,
} from './pageRenderer'
import type { PageSize, ViewMode } from './types'
import { AnnotationStore } from '@/annot/store'
import { AnnotLayer } from '@/annot/annotLayer'
import { AnnotEditor, HANDLES } from '@/annot/editor'
import type { TextRequestResult } from '@/annot/editor'
import type { HandleId } from '@/annot/geometry'
import type { ToolKind, ToolColors, PointerMode, Rgb, SelectedInfo } from '@/annot/types'
import { isResizable, isMarkupTool, sanitizeToolColor } from '@/annot/types'
import { PageTransform } from '@/annot/coords'

const props = defineProps<{
  doc: PdfDocument
  mode: ViewMode
  spreadOffset: 0 | 1
  /** 当前批注工具；`none` 表示纯阅读（不拦截指针） */
  tool: ToolKind
  /** 指针模式：选择 / 滚动 / 拖动。与「工具」正交，互斥由上层的 App.vue 保证 */
  pointerMode: PointerMode
  /** 各工具的当前配色（用户在色板上选的） */
  colors: ToolColors
}>()

/** scale 用 v-model 双向绑定：父组件（工具栏）也能改 */
const scale = defineModel<number>('scale', { required: true })

const emit = defineEmits<{
  'page-change': [pageNumber: number]
  stats: [RendererStats]
  /** 版面就绪（所有页尺寸已拿到）—— 调用方可以在这个时机恢复阅读位置 */
  ready: []
  /** 批注数量变化 */
  'annot-count': [count: number]
  /** 选中项变化（工具条的色板选中态 /「删除所选」按钮据此显示） */
  'sel-change': [sel: SelectedInfo | null]
  /** 撤销/重做栈变化 */
  'history-change': [state: { canUndo: boolean; canRedo: boolean }]
  /** 工具用完自己退出了（目前只有文本框）—— 工具栏的按钮高亮要跟着复位 */
  'tool-auto-exit': []
}>()

const MIN_SCALE = 0.2
const MAX_SCALE = 8
const GAP = 16
const PADDING = 24
/** 缩放落定判定：最后一次滚轮之后多久算"稳了" */
const COMMIT_DELAY = 180

const viewportRef = ref<HTMLDivElement | null>(null)
const contentRef = ref<HTMLDivElement | null>(null)

const baseSizes = shallowRef<PageSize[] | null>(null)
const loadProgress = ref(0)
/** 手势期间的额外缩放倍数（只走合成器，不触发布局重排） */
const previewScale = ref(1)
const currentPage = ref(1)

const slotEls = new Map<number, HTMLElement>()
const visiblePages = new Set<number>()

let renderer: PageRenderer | null = null
let commitTimer: number | null = null
let watchdog = 0

const dpr = Math.min(window.devicePixelRatio || 1, 2)

// ---------------------------------------------------------------- 批注
//
// store / layer / editor 全部是**普通 class 实例**，不进 Vue 响应式。
// 批注是"大数组 + 频繁小改动"，套上深层 Proxy 之后每次命中检测和重绘都要穿代理，
// 600 页文档上会明显变慢。给 UI 的只有 `annotCount` 这一个标量。

const annotStore = new AnnotationStore()
const annotCount = ref(0)
let annotLayer: AnnotLayer | null = null
let annotEditor: AnnotEditor | null = null

/**
 * 选中的批注。
 *
 * 只把 **id / 页码 / 框的位置** 三个标量放进响应式 —— 批注本体仍由非响应式的
 * store 持有（理由见上）。选中框的位置是"页内 CSS"坐标：它已经乘过 scale、
 * 也已经处理过 `/Rotate`，所以旋转页上手柄不会歪。
 */
const selId = ref<string | null>(null)
const selPage = ref(0)
const selBox = ref<{ left: number; top: number; width: number; height: number } | null>(null)
/** 撤销/重做按钮的可用态 —— 必须从 store 实时取，不能靠"上次有没有操作过"猜 */
const canUndo = ref(false)
const canRedo = ref(false)

const selResizable = computed(() => {
  const a = selId.value ? annotStore.get(selId.value) : null
  return !!a && isResizable(a)
})

const selBoxStyle = computed(() => {
  const b = selBox.value
  if (!b) return null
  return { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` }
})

/** 文字工具用的小输入框（居中弹，不做点击处定位 —— 便宜且够用） */
const textModal = ref<{ open: boolean; value: string }>({ open: false, value: '' })
let textResolve: ((r: { text: string; cssWidth: number; cssHeight: number } | null) => void) | null =
  null

// ---------------------------------------------------------------- 版面

const layout = computed(() =>
  baseSizes.value
    ? computeLayout(baseSizes.value, {
        mode: props.mode,
        gap: GAP,
        padding: PADDING,
        spreadOffset: props.spreadOffset,
      })
    : null,
)

const contentStyle = computed(() => {
  const l = layout.value
  return {
    // 这个变量被每页的 calc() 引用 —— 缩放时只写它一个，
    // 600 个页元素不需要各自改 style
    '--scale': String(scale.value),
    // pdf.js 的文本层/注释层按这两个变量算尺寸与字号：
    //   宽高 = --total-scale-factor × 页面原始尺寸
    //   字号 = calc(Npx × --total-scale-factor)
    // 不定义它们，文本层的 span 会全部挤在左上角（这是官方 viewer 里
    // 由外层容器提供的变量，自己接 pdf.js 必须自己给）。
    '--total-scale-factor': String(scale.value),
    '--scale-round-x': '1px',
    '--scale-round-y': '1px',
    width: `${(l?.contentWidth ?? 0) * scale.value}px`,
    height: `${(l?.contentHeight ?? 0) * scale.value}px`,
    // 手势期间只加一层视觉缩放，一行 style 改动搞定，
    // 不重算 600 个页元素的坐标（那才是缩放卡顿的来源）
    transform: previewScale.value === 1 ? undefined : `scale(${previewScale.value})`,
    transformOrigin: '0 0',
  } as Record<string, string>
})

/** 每页的基准坐标（scale=1）。缩放时不重写这些，靠 CSS 变量算 */
function slotStyle(pageNumber: number): Record<string, number> {
  const p = layout.value?.pages.find((x) => x.pageNumber === pageNumber)
  if (!p) return { '--bx': 0, '--by': 0, '--bw': 1, '--bh': 1 }
  return { '--bx': p.x, '--by': p.y, '--bw': p.width, '--bh': p.height }
}

// ---------------------------------------------------------------- 文档装载

let loadToken = 0

async function loadSizes(doc: PdfDocument): Promise<void> {
  const token = ++loadToken
  baseSizes.value = null
  loadProgress.value = 0

  const n = doc.numPages
  // 分批并行：一次性发 600 个请求会把 worker 打满，进度条也不动
  const CHUNK = 32
  const out: PageSize[] = new Array(n)
  for (let i = 0; i < n; i += CHUNK) {
    const nums: number[] = []
    for (let k = i; k < Math.min(i + CHUNK, n); k++) nums.push(k + 1)
    const sizes = await Promise.all(nums.map((x) => doc.getPageSize(x)))
    if (token !== loadToken) return // 期间换了文档
    sizes.forEach((s, k) => {
      out[i + k] = s
    })
    loadProgress.value = (i + nums.length) / n
    // 让出主线程，否则大文档解析期间进度条是死的
    await new Promise((r) => setTimeout(r, 0))
  }
  if (token !== loadToken) return
  baseSizes.value = out
  loadProgress.value = 1
  await nextTick()
  updateVisibility()
  emit('ready')
}

// ---------------------------------------------------------------- 渲染调度

/**
 * 页插槽的 ref 回调。
 *
 * ⚠️ **必须是稳定引用**（定义一次、不写在模板里当内联箭头）。
 * Vue 在 patch 时如果发现 ref 函数变了，会先 `oldRef(null)` 再 `newRef(el)` ——
 * 用内联箭头就等于每次重渲染都 detach + attach 一遍，把已渲染的画布全丢掉。
 *
 * 卸载时 Vue 只会传 null（拿不到页码），所以这里不处理 null；
 * 掉线的元素不在这里处理（updateVisibility 只按版面数组算，不依赖元素）。
 */
function bindSlotEl(el: Element | ComponentPublicInstance | null): void {
  const html = el as HTMLElement | null
  if (!html) return
  const pn = Number(html.dataset.page)
  if (!pn) return
  slotEls.set(pn, html)
  renderer?.attach(pn, html)
  annotLayer?.attach(pn, html)
  // 只有这一页确实有批注才建浮层 —— 600 页每页一个 2× 位图 canvas 会直接把内存撑爆
  if (annotLayer && annotStore.list(pn).length) {
    void annotLayer.render(pn, scale.value)
  }
}

/**
 * 按滚动位置决定"哪些页要渲染、哪些要回收"，并下发请求。
 *
 * ⚠️ 这里**不用 IntersectionObserver**，改用版面数学直接算。
 *
 * 为什么换掉 IO：
 *  IO 只在「跨越阈值」时回调，于是有两个绕不过去的坑 ——
 *   1. 版面变化（切双页/换缩放）后，"本来就在观察范围内、现在变可见"的页不回调，
 *      没人去请求渲染，那一页永远空白；
 *   2. 判定要混用 entry 的（观察时刻的）矩形和视口的（当前时刻的）矩形，
 *      两者采样时刻对不上就会分类错误 —— 结果是该回收的不回收、该渲染的不渲染。
 *
 * 换成算术之后：**零布局读取**（不调 getBoundingClientRect），
 * 只依赖 scrollTop / clientHeight / 版面数组，完全确定，也不会随回调时机漂移。
 */
function updateVisibility(): void {
  const vp = viewportRef.value
  const l = layout.value
  if (!vp || !renderer || !l) return

  const S = scale.value
  const top = vp.scrollTop
  const bottom = top + vp.clientHeight
  const pad = vp.clientHeight * 2 // 上下各预取 2 屏

  visiblePages.clear()
  const near = new Set<number>()
  const wantVisible: number[] = []
  const wantNear: number[] = []

  for (const p of l.pages) {
    const y0 = p.y * S
    const y1 = y0 + p.height * S
    if (y1 <= top - pad || y0 >= bottom + pad) continue // 太远，跳过
    if (y1 > top && y0 < bottom) {
      visiblePages.add(p.pageNumber)
      wantVisible.push(p.pageNumber)
    } else {
      near.add(p.pageNumber)
      wantNear.push(p.pageNumber)
    }
  }

  for (const pn of wantVisible) renderer.request(pn, S, PRIORITY_VISIBLE)
  for (const pn of wantNear) renderer.request(pn, S, PRIORITY_NEAR)

  // 已经占着资源的页里，既不可见也不在预取窗口内的 → 回收
  for (const pn of renderer.activePages()) {
    if (!visiblePages.has(pn) && !near.has(pn)) renderer.release(pn)
  }

  updateCurrentPage()
}

/**
 * 当前页 = 视口顶部所在的页。
 *
 * 纯算术（滚动位置 ÷ scale → 基准坐标 → 版面查表），
 * **不依赖任何回调时机、不读布局**，所以快速滚动也不会错。
 */
function updateCurrentPage(): void {
  const vp = viewportRef.value
  const l = layout.value
  if (!vp || !l || !l.pages.length) return

  const y = vp.scrollTop / Math.max(scale.value, 1e-6)
  let rowY = l.pages[0]!.y
  for (const p of l.pages) {
    if (p.y <= y + 1) rowY = p.y
    else break
  }
  // 双页模式下同一行有两页，取左边那页当"当前页"
  const best = l.pages.find((p) => p.y === rowY)?.pageNumber ?? 1

  if (best !== currentPage.value) {
    currentPage.value = best
    emit('page-change', best)
  }
}

/** 缩放变了（或文档/模式变了）：把当前追踪的页按新 scale 重新声明需求 */
function refreshRequests(): void {
  updateVisibility()
  renderAnnotsIfScaleChanged()
  // 版面/缩放都动过，选中框的页内坐标要跟着重算
  void updateSelBox()
}

/**
 * 批注浮层的位图与 scale 绑定，缩放落定后必须重画 ——
 * 否则浏览器会把旧位图拉伸，高亮/墨迹全变糊。
 * 用 lastScale 去重：滚动也会走到这里，不能每次都遍历所有页。
 */
let annotRenderedScale = 0
function renderAnnotsIfScaleChanged(): void {
  if (!annotLayer) return
  if (annotRenderedScale === scale.value) return
  annotRenderedScale = scale.value
  void annotLayer.renderAll(scale.value)
}

// ---------------------------------------------------------------- 批注交互

const textModalInput = ref<HTMLTextAreaElement | null>(null)

function locatePage(e: { clientX: number; clientY: number }): {
  pageNumber: number
  slotEl: HTMLElement
} | null {
  // 用 elementFromPoint 而不是 e.target：事件可能来自文本层的 span，
  // 也可能来自被捕获后的任意元素，逐个判 parent 不可靠。
  const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
  const slot = el?.closest?.('.page-slot') as HTMLElement | null
  if (!slot) return null
  const pn = Number(slot.dataset.page)
  return pn ? { pageNumber: pn, slotEl: slot } : null
}

/**
 * 判断指针落在选中框的哪个部位。
 *
 * 用手柄/框体自己的 DOM 判定，而不是"再算一遍命中检测"：
 * 手柄有 8 个且带内边距，重复实现一遍坐标判定既啰嗦又容易和渲染不一致。
 */
function selHit(e: PointerEvent): { handle: HandleId | null; onBody: boolean } {
  const t = e.target as HTMLElement | null
  if (!t?.closest) return { handle: null, onBody: false }
  const h = t.closest('[data-handle]') as HTMLElement | null
  if (h?.dataset.handle) return { handle: h.dataset.handle as HandleId, onBody: false }
  return { handle: null, onBody: !!t.closest('.sel-box') }
}

// ---------------------------------------------------------------- 触屏手势
//
// 手指和鼠标最本质的区别：**浏览器会抢手势**。
//
// 没激活工具时我们让浏览器自己滚（原生滚动有惯性、有橡皮筋，手写的比不了）；
// 工具一激活，touch-action 就切成 `none`（见样式段），单指用来画 ——
// 但代价是**手指翻不了页**。所以这里补一套双指手势：拖动平移、捏合缩放。
// 这正是 Edge 绘图模式的行为：单指画，双指移动/缩放。
//
// ⚠️ 只对 `pointerType === 'touch'` 记账。鼠标和触控笔不走这里 ——
//    对它们来说"多指"没有意义，混进来反而会让一次普通的拖拽被判成手势。

const touchPointers = new Map<number, { x: number; y: number }>()

/** 双指手势的参考系 —— 手势开始时测一次，之后每帧都相对它算 */
let gesture: {
  /** 参与手势的两个 pointerId —— 固定住，避免中途抬指后"前两个"换了人导致跳变 */
  a: number
  b: number
  /** 手指中心 */
  cx: number
  cy: number
  /** 手势开始时的指间距 */
  dist: number
  /** 手势开始时的总缩放（scale × previewScale） */
  scale: number
} | null = null

function touchStats(g: { a: number; b: number }): { cx: number; cy: number; dist: number } | null {
  const p = touchPointers.get(g.a)
  const q = touchPointers.get(g.b)
  if (!p || !q) return null
  return {
    cx: (p.x + q.x) / 2,
    cy: (p.y + q.y) / 2,
    dist: Math.hypot(p.x - q.x, p.y - q.y),
  }
}

/**
 * 第二根手指落下 → 从「绘制」切到「平移 / 缩放」。
 *
 * ⚠️ 必须 `cancelSession()`：第一根手指按下时编辑器已经开了一次绘制会话，
 *    不清掉的话手指一抬就提交一条乱线。
 */
function beginGesture(): void {
  annotEditor?.cancelSession()
  annotLayer?.clearDrafts()
  const ids = [...touchPointers.keys()]
  const g = { a: ids[0]!, b: ids[1]! }
  const s = touchStats(g)
  if (!s) return
  gesture = {
    ...g,
    cx: s.cx,
    cy: s.cy,
    dist: s.dist,
    scale: scale.value * previewScale.value,
  }
}

/**
 * 双指手势进行中：平移与缩放共用一个锚点公式 ——
 * 让「手势开始时手指按住的那个内容点」始终跟着手指中心走。
 * 这样捏合时画面也不会往一边漂（分别处理平移和缩放必然打架）。
 *
 * 推导（屏幕 X）：content 元素左上角布局位置记为 L（transform 不改它），
 *   X = (VL − scrollLeft) + L + qx · k
 * 手势开始时测出 qx，之后每帧反解：
 *   scrollLeft' = C + qx · k' − X'     其中 C ≡ VL + L = crect.left + scrollLeft
 * 注意 L 被消掉了，所以不需要知道 content 的实际布局位置。
 */
function updateGesture(): void {
  const g = gesture
  const vp = viewportRef.value
  const content = contentRef.value
  if (!g || !vp || !content) return

  const s = touchStats(g)
  if (!s) {
    endGesture()
    return
  }

  const k0 = previewScale.value
  // 只在确实测到过指间距时才做缩放；否则保持当前缩放
  const wanted = g.dist > 0 && s.dist > 0 ? g.scale * (s.dist / g.dist) : scale.value * k0
  const k1 = Math.min(MAX_SCALE, Math.max(MIN_SCALE, wanted)) / scale.value

  const crect = content.getBoundingClientRect()
  const qx = (g.cx - crect.left) / k0
  const qy = (g.cy - crect.top) / k0

  vp.scrollLeft = crect.left + vp.scrollLeft + qx * k1 - s.cx
  vp.scrollTop = crect.top + vp.scrollTop + qy * k1 - s.cy
  previewScale.value = k1

  g.cx = s.cx
  g.cy = s.cy

  // 手势落定时按「手指中心」锚定提交 —— 用视口中心会让画面明显跳一下
  scheduleCommit({ x: s.cx, y: s.cy })
}

function endGesture(): void {
  if (!gesture) return
  gesture = null
  scheduleCommit()
}

// ---- 抓手平移（pan 模式）

let pan: { x: number; y: number; left: number; top: number; id: number } | null = null
const panning = ref(false)

function startPan(e: PointerEvent): void {
  const vp = viewportRef.value
  if (!vp || e.button !== 0) return
  e.preventDefault()
  panning.value = true
  pan = { x: e.clientX, y: e.clientY, left: vp.scrollLeft, top: vp.scrollTop, id: e.pointerId }
  try {
    vp.setPointerCapture(e.pointerId)
  } catch {
    /* 不支持捕获就退化 */
  }
}

function movePan(e: PointerEvent): void {
  const p = pan
  const vp = viewportRef.value
  if (!p || !vp) return
  // 内容跟着手走 → 滚动位置反向移动
  vp.scrollLeft = p.left - (e.clientX - p.x)
  vp.scrollTop = p.top - (e.clientY - p.y)
}

function endPan(): void {
  panning.value = false
  if (!pan) return
  try {
    viewportRef.value?.releasePointerCapture(pan.id)
  } catch {
    /* ignore */
  }
  pan = null
}

function onPointerDown(e: PointerEvent): void {
  // 触屏的记账必须在**任何分支之前** —— 否则第二根手指落下会被当成一条新笔画
  if (e.pointerType === 'touch') {
    touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (touchPointers.size === 2) {
      beginGesture()
      return
    }
    if (touchPointers.size > 2) return // 三指以上不处理
  }

  const hint = selHit(e)
  const onSelected = hint.handle !== null || hint.onBody

  // pan 模式优先于工具。上层（App.vue）保证"切到拖动时自动清空工具"，
  // 所以这里不会出现"到底画还是拖"的歧义。
  if (props.pointerMode === 'pan' && !onSelected) {
    startPan(e)
    return
  }
  void annotEditor?.pointerDown(e, { mode: props.pointerMode, ...hint })
}

function onPointerMove(e: PointerEvent): void {
  if (e.pointerType === 'touch') {
    const p = touchPointers.get(e.pointerId)
    if (p) {
      p.x = e.clientX
      p.y = e.clientY
    }
    if (gesture) {
      updateGesture()
      return
    }
  }
  if (pan) {
    movePan(e)
    return
  }
  annotEditor?.pointerMove(e)
}

function onPointerUp(e: PointerEvent): void {
  if (e.pointerType === 'touch') {
    touchPointers.delete(e.pointerId)
    // 还剩手指 → 保持手势；全抬起 → 收尾
    if (touchPointers.size >= 2) {
      updateGesture()
      return
    }
    if (gesture) {
      endGesture()
      return
    }
  }
  if (pan) {
    endPan()
    return
  }
  annotEditor?.pointerUp(e)
}

function onPointerCancel(e: PointerEvent): void {
  if (e.pointerType === 'touch') {
    touchPointers.delete(e.pointerId)
    if (touchPointers.size === 0 && gesture) {
      endGesture()
      return
    }
  }
  if (pan) endPan()
  annotEditor?.cancelSession()
}

// ---- 选中框

let selToken = 0

/**
 * 重算选中框的位置。
 *
 * 为什么必须走 `PageTransform` 而不是 `page.height - y`：
 * 旋转页（`/Rotate 90/270`）上，简单的上下翻转会让框跑到完全错误的位置。
 * viewport 已经把旋转 / CropBox 偏移 / scale 全考虑进去了。
 */
async function updateSelBox(): Promise<void> {
  const token = ++selToken
  const id = selId.value
  const a = id ? annotStore.get(id) : null
  if (!a) {
    selBox.value = null
    return
  }
  const page = await props.doc.getPage(a.pageNumber)
  if (token !== selToken) return // 期间换了选中项 / 文档
  const tf = new PageTransform(page.getViewport({ scale: scale.value }))
  const [left, top, width, height] = tf.rectToView(a.rect)
  selBox.value = { left, top, width, height }
}

/** 批注被删掉（擦除 / 撤销）之后，选中态不能还留着 —— 否则手柄画在空气上 */
function validateSelection(): void {
  if (selId.value && !annotStore.get(selId.value)) annotEditor?.setSelected(null)
}

// ---- 文字工具的输入框（居中弹。不做点击处定位：便宜、够用、不出错位）

function openTextModal(initial = ''): Promise<TextRequestResult | null> {
  textModal.value = { open: true, value: initial }
  void nextTick(() => textModalInput.value?.focus())
  return new Promise((resolve) => {
    textResolve = resolve
  })
}

function closeTextModal(result: TextRequestResult | null): void {
  const fn = textResolve
  textResolve = null
  textModal.value = { open: false, value: '' }
  fn?.(result)
}

function confirmTextModal(): void {
  const t = textModal.value.value
  if (!t.trim()) {
    closeTextModal(null)
    return
  }
  const lines = Math.max(1, t.split('\n').length)
  closeTextModal({ text: t, cssWidth: 190, cssHeight: 22 + lines * 18 })
}

// ---- 变更通知

function pushAnnotCount(): void {
  annotCount.value = annotStore.count()
  emit('annot-count', annotCount.value)
}

/** 撤销 / 重做按钮的可用态由 store 实时给，不靠"上次有没有操作过"猜 */
function pushHistory(): void {
  canUndo.value = annotStore.canUndo()
  canRedo.value = annotStore.canRedo()
  emit('history-change', { canUndo: canUndo.value, canRedo: canRedo.value })
}

function onAnnotChanged(pageNumber: number): void {
  pushAnnotCount()
  validateSelection()
  annotLayer?.invalidate(pageNumber)
  void annotLayer?.render(pageNumber, scale.value)
}

function undoAnnot(): void {
  if (annotEditor?.undo()) pushAnnotCount()
}

function redoAnnot(): void {
  if (annotEditor?.redo()) pushAnnotCount()
}

function deleteSelected(): void {
  annotEditor?.removeSelected()
  pushAnnotCount()
}

/** 给选中的批注换颜色（可撤销） */
function applySelColor(color: Rgb): void {
  annotEditor?.setSelectedColor(color)
  pushAnnotCount()
}

function onSelDblClick(): void {
  void annotEditor?.editSelectedText()
}

// ---------------------------------------------------------------- 缩放手势

let scrollRaf = 0

/**
 * 滚动：raf 节流地重算可见性。
 * 现在渲染的启停也由这里驱动（版面数学，零布局读取），不再依赖 IO 回调。
 */
function onScroll(): void {
  if (scrollRaf) return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    updateVisibility()
  })
}

function onWheel(e: WheelEvent): void {
  if (!e.ctrlKey && !e.metaKey) return // 普通滚动交给浏览器
  e.preventDefault()

  const vp = viewportRef.value
  const content = contentRef.value
  if (!vp || !content) return

  const k0 = previewScale.value
  const total0 = scale.value * k0
  const factor = Math.exp(-e.deltaY * 0.0015)
  const total1 = Math.min(MAX_SCALE, Math.max(MIN_SCALE, total0 * factor))
  if (Math.abs(total1 - total0) < 1e-4) return
  const k1 = total1 / scale.value

  const X = e.clientX
  const Y = e.clientY
  const crect = content.getBoundingClientRect()
  // 光标下的点在内容局部坐标里的位置
  const qx = (X - crect.left) / k0
  const qy = (Y - crect.top) / k0

  previewScale.value = k1

  void nextTick(() => {
    // transform 生效后把滚动位置挪回去，保证光标下的内容不动
    const c2 = content.getBoundingClientRect()
    vp.scrollLeft += c2.left + qx * k1 - X
    vp.scrollTop += c2.top + qy * k1 - Y
  })

  scheduleCommit()
}

/**
 * 手势落定时的锚点。
 *
 * 双指缩放传**手指中心**（用户按住的就是那儿），滚轮缩放不传 → 退化成视口中心。
 * 锚点选错的表现是"松手瞬间画面跳一下"。
 */
let commitAnchor: { x: number; y: number } | null = null

function scheduleCommit(anchor?: { x: number; y: number }): void {
  if (anchor) commitAnchor = anchor
  if (commitTimer !== null) clearTimeout(commitTimer)
  commitTimer = window.setTimeout(commitNow, COMMIT_DELAY) as unknown as number
}

/** 手势落定：真正改 scale（这会重排版面），然后才下发渲染 */
function commitNow(): void {
  commitTimer = null
  const anchor = commitAnchor
  commitAnchor = null
  const k = previewScale.value
  if (k === 1) return

  const vp = viewportRef.value
  const content = contentRef.value
  if (!vp || !content) return

  const rect = vp.getBoundingClientRect()
  const X = anchor?.x ?? rect.left + rect.width / 2
  const Y = anchor?.y ?? rect.top + rect.height / 2
  const crect = content.getBoundingClientRect()
  // 记成 scale=1 的基准坐标，换 scale 之后用它还原滚动位置
  const baseX = (X - crect.left) / (scale.value * k)
  const baseY = (Y - crect.top) / (scale.value * k)

  previewScale.value = 1
  scale.value = scale.value * k

  void nextTick(() => {
    const c2 = content.getBoundingClientRect()
    vp.scrollLeft += c2.left + baseX * scale.value - X
    vp.scrollTop += c2.top + baseY * scale.value - Y
    refreshRequests()
  })
}

/** 供工具栏调用：按钮缩放 / 适应宽度，同样保持视口中心 */
async function applyScale(next: number, anchor?: { x: number; y: number }): Promise<void> {
  const vp = viewportRef.value
  const content = contentRef.value
  const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next))
  if (!vp || !content || Math.abs(clamped - scale.value) < 1e-4) return

  const rect = vp.getBoundingClientRect()
  const X = anchor?.x ?? rect.left + rect.width / 2
  const Y = anchor?.y ?? rect.top + rect.height / 2
  const crect = content.getBoundingClientRect()
  const baseX = (X - crect.left) / scale.value
  const baseY = (Y - crect.top) / scale.value

  scale.value = clamped
  await nextTick()
  const c2 = content.getBoundingClientRect()
  vp.scrollLeft += c2.left + baseX * clamped - X
  vp.scrollTop += c2.top + baseY * clamped - Y
  refreshRequests()
}

/** 滚到指定页（双页模式下滚到该页所在行） */
async function goToPage(pageNumber: number): Promise<void> {
  const vp = viewportRef.value
  const l = layout.value
  if (!vp || !l) return
  const target = l.pages.find((p) => p.pageNumber === pageNumber)
  if (!target) return
  // 页可能在更高的一行里，直接按基准 y 乘 scale 定位
  vp.scrollTop = target.y * scale.value - GAP
}

/** 首行的行高（fit-page 用） */
function firstRowHeight(): number {
  const l = layout.value
  if (!l || !l.pages.length) return 1
  const y0 = l.pages[0]!.y
  return l.pages.filter((p) => p.y === y0).reduce((m, p) => Math.max(m, p.height), 1)
}

/** 适应宽度 */
async function fitWidth(): Promise<void> {
  const vp = viewportRef.value
  const l = layout.value
  if (!vp || !l) return
  const rowWidth = l.contentWidth - PADDING * 2
  if (rowWidth <= 0) return
  await applyScale((vp.clientWidth - PADDING * 2) / rowWidth)
}

/** 适应页面（整页可见） */
async function fitPage(): Promise<void> {
  const vp = viewportRef.value
  const l = layout.value
  if (!vp || !l) return
  const rowWidth = l.contentWidth - PADDING * 2
  const rowHeight = firstRowHeight()
  if (rowWidth <= 0 || rowHeight <= 0) return
  await applyScale(
    Math.min((vp.clientWidth - PADDING * 2) / rowWidth, (vp.clientHeight - PADDING * 2) / rowHeight),
  )
}

/**
 * 一次性恢复到指定缩放 + 页码。
 *
 * 为什么单独做一个方法，而不是让调用方自己串 applyScale + goToPage：
 * 那两个方法各自带"保持视口中心"的锚定逻辑，先后调用会互相抵消 ——
 * 实测恢复出来会落到别的页（要求第 10 页，结果停在第 7 页）。
 * 恢复场景下我们要的是**准确定位**，不是保持什么中心，所以直接按版面算。
 */
async function restoreTo(nextScale: number, pageNumber: number): Promise<void> {
  scale.value = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale))
  await nextTick()

  const apply = () => {
    const vp = viewportRef.value
    const l = layout.value
    if (!vp || !l) return
    const target = l.pages.find((p) => p.pageNumber === pageNumber) ?? l.pages[0]
    if (!target) return
    vp.scrollLeft = 0
    vp.scrollTop = Math.max(0, target.y * scale.value - GAP)
  }

  apply()
  updateVisibility()
  // 内容高度是随 scale 变的，滚动位置可能被浏览器夹过，再补一次
  await nextTick()
  apply()
  updateVisibility()
}

defineExpose({
  applyScale,
  goToPage,
  fitWidth,
  fitPage,
  restoreTo,
  currentPage,
  undoAnnot,
  redoAnnot,
  deleteSelected,
  applySelColor,
  clearSelection: () => annotEditor?.setSelected(null),
  annotCount,
  canUndo,
  canRedo,
  selId,
  /** 供导出用：取出全部批注（普通数组，非响应式） */
  getAnnotations: () => annotStore.all(),
  /** 清空批注（换文档/导出后可调） */
  clearAnnotations: () => {
    annotStore.clear()
    annotLayer?.destroy()
    pushAnnotCount()
  },
})

// ---------------------------------------------------------------- 生命周期

/**
 * 建一个编辑器。
 *
 * 抽成函数是因为有**两处**要用（首次挂载 + 换文档）。这两份配置以前是复制粘贴的，
 * 结果"改了交互只改一处"迟早会发生 —— 换文档那条路径平时走不到，错了也测不出来。
 */
function makeEditor(layer: AnnotLayer, doc: PdfDocument): AnnotEditor {
  return new AnnotEditor({
    store: annotStore,
    layer,
    scale: () => scale.value,
    locate: locatePage,
    transform: async (pn, s) => {
      const page = await doc.getPage(pn)
      return new PageTransform(page.getViewport({ scale: s }))
    },
    // 屏幕上 8px 的容差换算到页面空间 —— 这样不论缩放多少，橡皮擦手感一致
    eraserTolerance: () => 8 / Math.max(scale.value, 0.01),
    // 兜一层：localStorage 里可能留着旧版本存的黑/白高亮色
    colorFor: (kind) => sanitizeToolColor(kind, props.colors[kind]),
    requestText: (_pn, _x, _y, initial) => openTextModal(initial ?? ''),
    onChange: (pn) => onAnnotChanged(pn),
    onSelectionChange: (id) => {
      const a = id ? (annotStore.get(id) ?? null) : null
      selId.value = a?.id ?? null
      selPage.value = a?.pageNumber ?? 0
      emit('sel-change', a ? { id: a.id, kind: a.kind, color: a.color } : null)
      void updateSelBox()
    },
    onSelectionGeometry: () => void updateSelBox(),
    onHistoryChange: () => pushHistory(),
    onToolAutoExit: () => emit('tool-auto-exit'),
  })
}

onMounted(() => {
  renderer = new PageRenderer(props.doc, dpr, 2, (s) => emit('stats', s))

  annotLayer = new AnnotLayer(props.doc, dpr, (pn) => annotStore.list(pn))
  annotEditor = makeEditor(annotLayer, props.doc)
  annotEditor.setTool(props.tool)

  // 挂载期已经渲染出的插槽元素在这里补上绑定
  for (const [pn, el] of slotEls) {
    renderer.attach(pn, el)
    annotLayer.attach(pn, el)
  }
  void loadSizes(props.doc)

  // 诊断钩子。渲染状态机出了问题（比如"某页一直空白"）时，
  // 光看现象猜不出来，必须能直接读到 wantKey / doneKey / runningKey。
  // scripts/test-viewer.mjs 用它做断言。
  ;(globalThis as unknown as Record<string, unknown>).__eplViewer = {
    snapshot: () => {
      const a = selId.value ? annotStore.get(selId.value) : null
      return {
        scale: scale.value,
        previewScale: previewScale.value,
        visible: [...visiblePages],
        slotEls: slotEls.size,
        pages: renderer?.debugState() ?? [],
        // 下面这几个是"选中 / 拖动 / 改大小 / 撤销重做"的观察窗口。
        // 这类交互的 bug（框没动、手柄方向反了、重做没生效）光看截图看不出来，
        // 必须能直接读到数据和可用态。
        tool: props.tool,
        pointerMode: props.pointerMode,
        annotCount: annotStore.count(),
        canUndo: annotStore.canUndo(),
        canRedo: annotStore.canRedo(),
        sel: a ? { id: a.id, pageNumber: a.pageNumber, kind: a.kind, color: a.color, rect: [...a.rect] } : null,
        selBox: selBox.value ? { ...selBox.value } : null,
      }
    },
    /**
     * 全部批注的几何快照（拖动/改大小的断言用）。
     *
     * `contentInsideRect` 是个**不变量自检**，不是装饰：
     * 写回 PDF 后查看器会按 `/Rect` 裁 `/AP`，内容一旦跑出 rect 就会被截断。
     * 而"拖动/改大小只改了 rect、没改 quads/strokes"恰好会破坏它 ——
     * 这种错误在界面上只是"框动了内容没动"，很难一眼看出来，必须机器判。
     */
    annots: () =>
      annotStore.all().map((a) => {
        let contentInsideRect = true
        if (a.kind === 'highlight' || a.kind === 'underline' || a.kind === 'strikeout') {
          // markup 的 rect 必须**正好**是 quads 的包围盒（不是"包含"就行）
          const b = AnnotationStore.recomputeRect(a)
          contentInsideRect =
            Math.abs(a.rect[0] - b[0]) < 0.01 &&
            Math.abs(a.rect[1] - b[1]) < 0.01 &&
            Math.abs(a.rect[2] - b[2]) < 0.01 &&
            Math.abs(a.rect[3] - b[3]) < 0.01
        } else if (a.kind === 'ink') {
          const all = a.strokes.flat()
          contentInsideRect = all.every((v, i) =>
            i % 2 === 0
              ? v >= a.rect[0] - 0.51 && v <= a.rect[2] + 0.51
              : v >= a.rect[1] - 0.51 && v <= a.rect[3] + 0.51,
          )
        }
        return {
          id: a.id,
          pageNumber: a.pageNumber,
          kind: a.kind,
          rect: [...a.rect] as number[],
          color: [...a.color] as number[],
          contentInsideRect,
        }
      }),
  }

  /**
   * 看门狗：兜住"可见页却没画出来"的情况。
   *
   * 状态机再小心也可能有漏网路径（取消 / 回收 / IO 回调时机交错），
   * 而这类 bug 的症状是"那一页永远空白"，用户只能靠改缩放碰运气绕过去 —— 不可接受。
   * 与其追求零缺陷，不如每 600ms 对**可见页**（集合很小）核一次账，缺了就补。
   */
  watchdog = window.setInterval(() => {
    if (!renderer || visiblePages.size === 0) return
    for (const pn of visiblePages) {
      if (!renderer.isReady(pn)) renderer.request(pn, scale.value, PRIORITY_VISIBLE)
    }
  }, 600)
})

onBeforeUnmount(() => {
  if (commitTimer !== null) clearTimeout(commitTimer)
  if (watchdog) clearInterval(watchdog)
  renderer?.destroy()
  renderer = null
  annotLayer?.destroy()
  annotLayer = null
  annotEditor = null
  annotStore.clear()
  slotEls.clear()
})

watch(
  () => props.tool,
  (t) => {
    annotEditor?.setTool(t)
    // 工具切走时把落单的临时图形清掉
    if (t === 'none') annotLayer?.clearDrafts()
  },
)

watch(
  () => props.doc,
  (doc) => {
    renderer?.destroy()
    renderer = new PageRenderer(doc, dpr, 2, (s) => emit('stats', s))

    // 换文档 = 批注全部作废（批注是按文档归属的，不能跨文件漂）
    annotEditor?.cancelSession()
    annotLayer?.destroy()
    annotStore.clear()
    annotLayer = new AnnotLayer(doc, dpr, (pn) => annotStore.list(pn))
    // editor 里的 store 引用不变，只换 layer
    annotEditor = makeEditor(annotLayer, doc)
    annotEditor.setTool(props.tool)
    selId.value = null
    selPage.value = 0
    selBox.value = null
    pushAnnotCount()
    pushHistory()

    for (const [pn, el] of slotEls) {
      renderer.attach(pn, el)
      annotLayer.attach(pn, el)
    }
    annotRenderedScale = 0
    void loadSizes(doc)
  },
)

// 外部改了 scale（工具栏按钮）→ 已在 applyScale 里处理；
// 这里兜住直接赋值的情况
watch(scale, () => {
  void nextTick(() => refreshRequests())
  // 选中框的位置是"页内 CSS"（已乘 scale），缩放后必须跟着重算，否则手柄会飘走
  void updateSelBox()
})

/**
 * 切到「拖动」模式时清掉选中。
 * 否则会出现"手柄挡住的那块地方既不能拖批注、也不能平移"的死区。
 */
watch(
  () => props.pointerMode,
  () => {
    annotEditor?.setSelected(null)
  },
)

// 版面变化（切单/双页、封面对齐）之后必须重新评估一次 ——
// 否则"本来就在观察范围内、现在变可见"的页永远不会被请求（IO 不会回调）
watch(
  () => [props.mode, props.spreadOffset] as const,
  () => {
    void nextTick(() => updateVisibility())
  },
)
</script>

<template>
  <div class="viewer">
    <div
      ref="viewportRef"
      class="viewport"
      :class="{
        'tool-active': tool !== 'none',
        'markup-tool': isMarkupTool(tool),
        'tool-drawing': tool !== 'none' && !isMarkupTool(tool),
        'mode-pan': pointerMode === 'pan',
        panning,
      }"
      @wheel="onWheel"
      @scroll="onScroll"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
    >
      <div
        v-if="!layout"
        class="loading"
      >
        正在解析文档… {{ Math.round(loadProgress * 100) }}%
      </div>

      <div v-else ref="contentRef" class="content" :style="contentStyle">
        <div
          v-for="p in layout.pages"
          :key="p.pageNumber"
          class="page-slot"
          :data-page="p.pageNumber"
          :style="slotStyle(p.pageNumber)"
          :ref="bindSlotEl"
        >
          <!--
            选中框。**只挂在选中项所在的那页** —— 600 页的文档里其余 599 页
            一个节点都不多，不参与 v-for 的成本。
            位置是"页内 CSS"（已乘 scale、已处理 /Rotate），所以旋转页上手柄不会歪。
          -->
          <div
            v-if="selId && selPage === p.pageNumber && selBoxStyle"
            class="sel-box"
            :style="selBoxStyle"
            @dblclick.stop="onSelDblClick"
          >
            <template v-if="selResizable">
              <div
                v-for="h in HANDLES"
                :key="h"
                class="sel-handle"
                :class="`h-${h}`"
                :data-handle="h"
              />
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- 文字批注输入框 -->
    <div v-if="textModal.open" class="modal-mask" @pointerdown.self="closeTextModal(null)">
      <div class="modal" @pointerdown.stop>
        <div class="modal-title">批注文字</div>
        <textarea
          ref="textModalInput"
          v-model="textModal.value"
          rows="3"
          placeholder="输入内容（支持中文）· Ctrl+Enter 确定 · Esc 取消"
          @keydown.enter.ctrl.prevent="confirmTextModal"
          @keydown.esc.prevent="closeTextModal(null)"
        />
        <div class="modal-actions">
          <button class="mbtn ghost" @click="closeTextModal(null)">取消</button>
          <button class="mbtn" @click="confirmTextModal">确定</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.viewer {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.viewport {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: #14161a;
  /* 滚动容器自成一个层，避免整页重绘 */
  contain: strict;
  will-change: scroll-position;
  /*
   * 触屏默认：手指用来滚动。
   *
   * 这里**故意不写 pinch-zoom** —— 写了浏览器就会接管捏合、缩放整个页面
   * （连工具栏一起放大），而我们要的是只缩放 PDF 内容。捏合由本组件的
   * 双指手势自己处理。
   */
  touch-action: pan-x pan-y;
  /* 兜底：即便这里滚到头了，也不要把 overscroll 变成「返回上一页」 */
  overscroll-behavior: contain;
}

/*
 * 绘图工具激活 —— **单指归我们**。
 *
 * `touch-action: none` 是 Surface 上「一拖动笔画就没了」的唯一解：
 * 默认情况下浏览器在 touchstart 后会先观察一小段，判定这是 pan 手势 →
 * 自己开始滚动，并给页面发 **pointercancel**。编辑器的 `cancelSession()`
 * 一收到就清掉了正在画的那一笔。touch-action 是**手势开始前**的声明，
 * 所以只能靠"工具激活时提前切换"，等手指落下再改就已经晚了。
 *
 * 代价是：工具激活期间单指无法翻页。所以配套实现了**双指拖动平移** /
 * **双指捏合缩放**（见 onPointerDown），行为对齐 Edge 的绘图模式。
 *
 * ⚠️ 标记类工具（高亮/下划线/删除线）**不能走这里** —— 它们要靠浏览器
 * 原生选区来选中文字，touch-action 一关就选不中了。
 */
.viewport.tool-drawing {
  touch-action: none;
}
/*
 * 拖拽期间禁掉文字选中。
 * 否则手指按下拖动时，浏览器会顺势进入"选词"状态，表现为拖出一堆蓝色高亮，
 * 而笔画本身画不出来（尤其在手写这种连续移动的场景）。
 */
.viewport.tool-drawing,
.viewport.mode-pan {
  -webkit-user-select: none;
  user-select: none;
}

.loading {
  padding: 40px;
  color: #8b93a1;
  font-size: 14px;
}

.content {
  /* 宽度由 JS 给（contentWidth × scale），margin auto 负责水平居中 */
  margin: 0 auto;
  position: relative;
}

.page-slot {
  position: absolute;
  /* 基准坐标 × 当前 scale —— 缩放时只改 --scale 这一个变量 */
  left: calc(var(--bx) * var(--scale, 1) * 1px);
  top: calc(var(--by) * var(--scale, 1) * 1px);
  width: calc(var(--bw) * var(--scale, 1) * 1px);
  height: calc(var(--bh) * var(--scale, 1) * 1px);
  background: #2a2f38;
  outline: 1px solid #333a45;
  overflow: hidden;
  /* ⚠️ 把高亮层的 multiply 限制在本页内 —— 否则它会去跟视口深色背景相乘，
     页面还没渲染出来时高亮会变成一团黑。 */
  isolation: isolate;
}

.page-slot :deep(.pdf-page-canvas) {
  display: block;
  width: 100%;
  height: 100%;
}

/*
 * 批注浮层。
 *
 * ⚠️ **`pointer-events: none` 不能省。**
 * 这层盖在文本层之上，如果它吃事件，"选中文字 → 高亮"这条主路径会彻底失效 ——
 * 而且症状很隐蔽：高亮工具点了没反应，看起来像"工具没实现"。
 * 所有指针交互统一在页元素上处理。
 */
.page-slot :deep(.annot-layer) {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  user-select: none;
}

/*
 * 高亮层：**正片叠底**。
 *
 * 需求是"在字的背景上色，不改字本身的颜色"。multiply 的数学正好是这件事：
 *   白底 (1,1,1) × 黄 (1,.92,.23) → 黄    背景上色
 *   黑字 (0,0,0) × 黄             → 黑    文字一个像素都没变
 * 早先的写法是"盖一层 alpha=.55 的半透明黄板"，结果是把黑字冲成灰橄榄色 ——
 * 高亮反而让正文更难读，本末倒置。
 *
 * ⚠️ 这层必须 alpha=1（见 draw.ts），alpha<1 时浏览器会在"原色"和"乘积"之间插值，
 * 字照样被冲淡。写回 PDF 时 /AP 用同样的 Multiply + ca=1，两边观感才一致。
 */
.page-slot :deep(.annot-layer-under) {
  z-index: 2;
  mix-blend-mode: multiply;
}

/* 其余批注（下划线 / 删除线 / 手写 / 方框 / 文本框）：正常合成，压在内容之上。
   这些不能走 multiply —— 删除线压在黑字上会变成黑色，直接看不见。 */
.page-slot :deep(.annot-layer-over) {
  z-index: 3;
}

/*
 * 选中框。
 *
 * 与批注浮层相反，这一层**必须**接住指针事件 —— 它的全部意义就是拖动和手柄。
 * 但它只覆盖批注自身那块矩形：点框外面依然会取消选中、并可以正常选文字。
 *
 * ⚠️ `z-index: 4` 不能低于批注浮层的 3：浮层 canvas 是后 appendChild 进来的，
 * 不显式抬高层级的话它会盖住选中框，表现为"看得见手柄却点不动"。
 */
.sel-box {
  position: absolute;
  z-index: 4;
  box-sizing: border-box;
  /* 用负 offset 把描边画在框内 —— 页插槽是 overflow:hidden，画在外会被裁掉一半 */
  outline: 1.5px solid #4aa3ff;
  outline-offset: -1px;
  background: rgba(74, 163, 255, 0.09);
  cursor: move;
}

/*
 * 8 个控制手柄。
 *
 * ⚠️ 全部放在框**内部**（不用负 margin 骑在角上）：页插槽 `overflow: hidden`，
 * 骑在角上的手柄会被裁掉一半，出现"西北角的手柄点不中"这种只在一侧复现的怪病。
 */
.sel-handle {
  position: absolute;
  box-sizing: border-box;
  width: 10px;
  height: 10px;
  background: #fff;
  border: 1.5px solid #2b6cb0;
  border-radius: 2px;
}
.sel-handle.h-nw {
  left: 0;
  top: 0;
  cursor: nwse-resize;
}
.sel-handle.h-n {
  left: calc(50% - 5px);
  top: 0;
  cursor: ns-resize;
}
.sel-handle.h-ne {
  left: calc(100% - 10px);
  top: 0;
  cursor: nesw-resize;
}
.sel-handle.h-e {
  left: calc(100% - 10px);
  top: calc(50% - 5px);
  cursor: ew-resize;
}
.sel-handle.h-se {
  left: calc(100% - 10px);
  top: calc(100% - 10px);
  cursor: nwse-resize;
}
.sel-handle.h-s {
  left: calc(50% - 5px);
  top: calc(100% - 10px);
  cursor: ns-resize;
}
.sel-handle.h-sw {
  left: 0;
  top: calc(100% - 10px);
  cursor: nesw-resize;
}
.sel-handle.h-w {
  left: 0;
  top: calc(50% - 5px);
  cursor: ew-resize;
}

/* 批注工具激活时换光标，给用户一个"现在点下去会画东西"的信号 */
.viewport.tool-active {
  cursor: crosshair;
}
/* 但标记类工具要选中文字，光标得是文本 */
.viewport.tool-active.markup-tool {
  cursor: text;
}
/* 抓手模式 */
.viewport.mode-pan {
  cursor: grab;
}
.viewport.mode-pan.panning {
  cursor: grabbing;
}

/* ---- 文字输入框 ---- */

.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(8, 10, 14, 0.62);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.modal {
  width: 380px;
  max-width: calc(100vw - 40px);
  background: #1e2128;
  border: 1px solid #333a45;
  border-radius: 10px;
  padding: 16px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
}

.modal-title {
  font-size: 13px;
  color: #9aa3b2;
  margin-bottom: 10px;
}

.modal textarea {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  background: #14161a;
  color: #e6e8ec;
  border: 1px solid #2e333d;
  border-radius: 7px;
  padding: 9px 10px;
  font: 13px/1.5 "Microsoft YaHei", system-ui, sans-serif;
  outline: none;
}
.modal textarea:focus {
  border-color: #60a5fa;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}

.mbtn {
  padding: 6px 16px;
  border: 0;
  border-radius: 6px;
  background: #2b5fd9;
  color: #fff;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.mbtn.ghost {
  background: #2a2f38;
  color: #c8cfda;
  font-weight: 500;
}

/*
 * 文本层：叠在画布上方的一层透明 span，负责"选中 / 复制 / Ctrl+F 查找"。
 *
 * ⚠️ 下面这几条不能省。pdf.js 只给每个 span 写 `--font-height` / `--scale-x` /
 * `--rotate` 这些**自定义变量**，真正把它们变成字号和变形的是**这层 CSS**
 * （官方 viewer 的 text_layer_builder.css 里那份）。
 * 只写基础定位、不写这段，症状是：字号全变成一个值、需要横向压缩的 span 会溢出页框 ——
 * 看起来"大致对齐"，但其实是错的。
 */
.page-slot :deep(.text-layer) {
  position: absolute;
  text-align: initial;
  inset: 0;
  overflow: clip;
  opacity: 1;
  line-height: 1;
  text-size-adjust: none;
  forced-color-adjust: none;
  transform-origin: 0 0;
  caret-color: CanvasText;
  z-index: 2;
}
.page-slot :deep(.text-layer :is(span, br)) {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0% 0%;
}
.page-slot :deep(.text-layer > :not(.markedContent)),
.page-slot :deep(.text-layer .markedContent span:not(.markedContent)) {
  z-index: 1;
  --font-height: 0;
  --scale-x: 1;
  --rotate: 0deg;
  font-size: calc(var(--total-scale-factor) * var(--font-height));
  transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv, 1));
}
.page-slot :deep(.text-layer .markedContent) {
  display: contents;
}
.page-slot :deep(.text-layer ::selection) {
  background: rgba(64, 140, 255, 0.45);
}
</style>
