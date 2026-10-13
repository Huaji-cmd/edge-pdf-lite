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
import type { HandleId } from '@/annot/geometry'
import type {
  ToolKind,
  ToolColors,
  PointerMode,
  Rgb,
  SelectedInfo,
  Annotation,
  FreeTextAnnot,
  Rect,
} from '@/annot/types'
import {
  isResizable,
  isMarkupTool,
  sanitizeToolColor,
  normalizeRect,
  FONT_SIZES,
  FONT_SIZE_LABELS,
  FREETEXT_SWATCHES,
  FREETEXT_FONT_FAMILY,
  nearestFontSize,
} from '@/annot/types'
import { lineHeightOf, textPad, wrapText } from '@/annot/textWrap'
import { rgbCss } from '@/annot/draw'
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
  /** 手写笔尖粗细（pt）—— 工具栏三档之一，改了立刻对下一笔生效 */
  inkWidth: number
  /** 新建文本框的默认字号（pt）—— 工具栏三档之一 */
  fontSize: number
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
  /** 用户在文本框里改了字号 —— 上层把它记成"下一个新框的默认字号" */
  'font-size-change': [size: number]
}>()

const MIN_SCALE = 0.2
const MAX_SCALE = 8
const GAP = 16
const PADDING = 24
/**
 * 翻页定位时，页上方留出的空隙（CSS px）。
 *
 * ⚠️ 这个值**成对出现在两处，改一处必须改另一处**：
 *   · `goToPage`           `scrollTop = rowY · scale − ANCHOR_GAP`
 *   · `updateCurrentPage`  `y = (scrollTop + ANCHOR_GAP) / scale`
 *
 * 不成对的后果（实测）：翻到某页后，由 scrollTop 反算出来的"当前行"会落到
 * **上一行** —— `page-change` 于是把页码 emit 回去。表现为点「下一页」
 * 页码反而倒退：单页模式退 1 页、双页模式**每次退 2 页**，一路退到第 1 页。
 */
const ANCHOR_GAP = GAP
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

/**
 * 要不要画那 8 个改大小的手柄。
 *
 * ⚠️ 文本框**排除在外**：它有自己的 Chrome（左实心条 + 右圆圈 + 三边虚线，见
 *    `.text-edit`），再叠一层 8 手柄会两边打架 —— 而且用户在文本框上要做的是
 *    "改字、调宽度"，不是"四角拉伸"。
 */
const selHandlesVisible = computed(() => {
  const a = selId.value ? annotStore.get(selId.value) : null
  return !!a && isResizable(a) && a.kind !== 'freetext'
})

/** 选中框本体：文本框不画（编辑态自己有框） */
const selBoxVisible = computed(() => {
  const a = selId.value ? annotStore.get(selId.value) : null
  return !!a && a.kind !== 'freetext'
})

const selBoxStyle = computed(() => {
  const b = selBox.value
  if (!b) return null
  return { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` }
})

// ---------------------------------------------------------------- 文本框：就地编辑

/**
 * 就地文本编辑（复刻 Edge 的文本框）。
 *
 * 交互：点页面就地出现一个框 —— **左边实心条**拖动位置、**右边圆圈**调宽度、
 * 其余三边虚线；输入到框宽**自动换行**；点空白处收起，盒子消失、文字与 PDF 融为一体。
 *
 * 两条不写下来就会踩的规则：
 *
 * ⚠️ **编辑中的那条批注要从画布上排除掉**（见 annotLayer 的取数回调）。
 *    画布画一遍、DOM 又画一遍同样的字 → 看起来像被人描了粗体，而且选区位置对不上。
 *
 * ⚠️ **`textEditBox` 必须跟着缩放/滚动重算**（refreshTextEditBox）。
 *    它存的是"页内 CSS"坐标，缩放一变就不对了；不重算的话编辑框会飘到别处。
 */
const textEditId = ref<string | null>(null)
const textEditBox = ref<{ left: number; top: number; width: number; height: number } | null>(null)
const textEditEl = ref<HTMLElement | null>(null)
/** 字号/颜色工具条是否展开 */
const textMenuOpen = ref(false)
/** 每次进入编辑态 +1，用来丢弃过期的异步定位结果 */
let textEditToken = 0

/**
 * 等编辑框渲染出来之后要把光标放进去。
 *
 * ⚠️ 不能直接在 beginTextEdit 里 `nextTick(focus)`：编辑框的位置是**异步**算出来的
 *（要 `await doc.getPage()`），那一刻元素还不存在，focus 会静默失败 ——
 * 症状是"框出来了但打不了字"，而且控制台一声不吭。
 */
let textPendingFocus = false
/** 进入编辑时的快照；null = 这次是**新建**的框（新建已经进过一次历史，收尾不再记） */
let textEditBefore: Annotation | null = null

/**
 * 正在编辑的那条批注。
 *
 * 🔴 **必须是一个由我们显式同步的 shallowRef，不能写成「computed 里调 store.get()」**。
 *    `AnnotationStore` 是**普通类、不是响应式对象** —— 放进 computed 会被**永久缓存**：
 *    第一次取到的那份对象之后再也不更新。踩过的两个症状都由此而来：
 *      · 改字号时读到的 `contents` 还是「新建时的空串」→ 文本被清空
 *      · 拖动时读到的 `rect` 还是旧值 → 编辑框不跟随（数据其实早就对了）
 *    取值一律走 `currentFreeText()`（每次都从 store 拉最新）；
 *    渲染用的 `textEditFree` 依赖这个 ref，所以才有响应性。
 */
const textEditAnnotRef = shallowRef<Annotation | null>(null)

function syncTextEditAnnot(): void {
  const id = textEditId.value
  textEditAnnotRef.value = id ? ((annotStore.get(id) as Annotation | null) ?? null) : null
}

/** 取当前编辑中的文本框（**总是先从 store 同步一次**，避免拿到过期对象） */
function currentFreeText(): FreeTextAnnot | null {
  syncTextEditAnnot()
  const a = textEditAnnotRef.value
  return a && a.kind === 'freetext' ? a : null
}

/**
 * 同上，但收窄成 `FreeTextAnnot`。
 *
 * 单独一个 computed 是为了让模板里的类型检查能干净地通过 ——
 * 否则每个用到 `fontSize` 的地方都要写断言，还容易写漏。
 */
const textEditFree = computed<FreeTextAnnot | null>(() => {
  const a = textEditAnnotRef.value
  return a && a.kind === 'freetext' ? a : null
})

const textEditStyle = computed(() => {
  const b = textEditBox.value
  if (!b || !textEditFree.value) return null
  return { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` }
})

/** 可编辑区自己的样式：字体、行高、颜色、内边距必须与绘制/写回三处一致 */
const textEditInnerStyle = computed(() => {
  const a = textEditFree.value
  if (!a) return null
  const s = scale.value
  const pad = textPad(a.fontSize) * s
  return {
    fontFamily: FREETEXT_FONT_FAMILY,
    fontSize: `${a.fontSize * s}px`,
    lineHeight: `${lineHeightOf(a.fontSize) * s}px`,
    color: rgbCss(a.color),
    padding: `${pad}px`,
  }
})

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

  // ⚠️ 必须 **+ ANCHOR_GAP**，与 `goToPage` 里那个 `− ANCHOR_GAP` 严格配对。
  //    少了这一项，翻页后反算出的行会落到上一行（详见 ANCHOR_GAP 的注释）。
  const y = (vp.scrollTop + ANCHOR_GAP) / Math.max(scale.value, 1e-6)
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

/*
 * 触屏上的标记类工具（高亮 / 下划线 / 删除线）：**自己划选区**。
 *
 * 为什么必须自己做 ——
 * 这类工具原本靠浏览器原生选区：手指按下拖动，浏览器自己去选词。
 * 但在 Surface 上这条路径根本走不通：viewport 是个可滚动容器，浏览器会先把
 * 这一下判成 pan 手势 → 自己开始滚动，并给页面发一个 `pointercancel`，
 * 选区压根建立不起来。表现就是用户报的那个现象：**单指一拖，页面跟着动**。
 *
 * 解法两步，缺一不可：
 *   ① `touch-action: none`（见样式段 `.viewport.markup-tool`）——
 *      在手势开始前声明"这片区域归我"。等手指落下再改就晚了（这是声明不是拦截）。
 *   ② 原生选区没了，就得自己算：用 `caretRangeFromPoint` 把屏幕坐标换算成
 *      文本层里的字符位置，再用 Range 拼出选区。
 *
 * ⚠️ 只对 `pointerType === 'touch'` 生效。鼠标继续走原生选区 ——
 *    那条路径本来就顺，改了反而会破坏已有的鼠标划选行为。
 */
let markupTouch: { startX: number; startY: number; moved: boolean } | null = null

/** 屏幕坐标 → 文本层里的字符位置。没命中文本层返回 null */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const d = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }
  let node: Node | null = null
  let offset = 0
  if (typeof d.caretRangeFromPoint === 'function') {
    // Chromium（含 WebView2）的非标准但唯一可靠的实现
    const r = d.caretRangeFromPoint(x, y)
    if (!r) return null
    node = r.startContainer
    offset = r.startOffset
  } else if (typeof d.caretPositionFromPoint === 'function') {
    const p = d.caretPositionFromPoint(x, y) // 标准写法（Firefox）
    if (!p) return null
    node = p.offsetNode
    offset = p.offset
  } else {
    return null
  }
  // ⚠️ 必须落在文本层里：命中画布的话选区会横跨整页，出来的高亮是整块错的
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)
  if (!el?.closest?.('.text-layer')) return null
  return { node, offset }
}

/** 把「起点 → 终点」设成当前选区（手指划到哪，蓝底就跟到哪） */
function applyTouchRange(x0: number, y0: number, x1: number, y1: number): void {
  const a = caretAt(x0, y0)
  const b = caretAt(x1, y1)
  if (!a || !b) return
  const range = document.createRange()
  const pos = a.node.compareDocumentPosition(b.node)
  // 同节点时 compareDocumentPosition 返回 0，这时只能比 offset
  const bAfter = pos === 0 ? b.offset >= a.offset : (pos & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  if (bAfter) {
    range.setStart(a.node, a.offset)
    range.setEnd(b.node, b.offset)
  } else {
    range.setStart(b.node, b.offset)
    range.setEnd(a.node, a.offset)
  }
  const sel = window.getSelection()
  if (!sel) return
  sel.removeAllRanges()
  sel.addRange(range)
}

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
      // 第二根手指落下 → 转入手势，正在划的选区作废
      markupTouch = null
      beginGesture()
      return
    }
    if (touchPointers.size > 2) return // 三指以上不处理

    // 标记类工具：单指归我们（原生选区在触屏上建立不起来，见 markupTouch 的说明）
    if (isMarkupTool(props.tool)) {
      markupTouch = { startX: e.clientX, startY: e.clientY, moved: false }
      window.getSelection()?.removeAllRanges()
      e.preventDefault()
      return
    }
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
    if (markupTouch) {
      markupTouch.moved = true
      applyTouchRange(markupTouch.startX, markupTouch.startY, e.clientX, e.clientY)
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
  // 触屏划选：选区已经建好了，交回编辑器去生成批注
  if (markupTouch) {
    const m = markupTouch
    markupTouch = null
    if (m.moved) void annotEditor?.commitMarkup(e)
    return
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
    // 被系统抢走手势（比如边缘滑动）→ 放弃这次划选，别留下半个选区
    if (touchPointers.size === 0) markupTouch = null
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
  /*
   * ⚠️ 正在编辑的那条被删掉时（`Delete` / 工具栏的「删除所选」/ 撤销），
   *    编辑态必须一起清 —— 否则会留下"编辑框开着、但批注已经不存在"的幽灵：
   *    `currentFreeText()` 返回 null，框看不见了，可 `textEditId` 还指着空气，
   *    下一次点空白也不会走"结束编辑"那条路。
   */
  if (textEditId.value && !annotStore.get(textEditId.value)) {
    textEditId.value = null
    textEditBox.value = null
    textEditAnnotRef.value = null
    textEditBefore = null
  }
}

// ---- 文本框：就地编辑（复刻 Edge）

/**
 * 进入编辑态。宿主接口 `beginTextEdit` 与"选中文本框"两条路都来这里。
 *
 * @param isNew 这次是**新建**的框。新建时 store 已经 `add` 过一次（那条就是历史），
 *              所以收尾时不再补一条 edit 记录 —— 否则 Ctrl+Z 要按两下才见效。
 */
function beginTextEdit(annotId: string, isNew?: boolean): void {
  const a = annotStore.get(annotId)
  if (!a || a.kind !== 'freetext') return
  if (textEditId.value === annotId) return // 已经在编辑它了，别重入（会重置快照）
  /*
   * ⚠️ 从**另一个**文本框切过来时，先把上一个的编辑会话收尾（提交历史）。
   *    不收的话：那一段编辑既没进历史、`textEditBefore` 也被覆盖 —— 用户点来点去
   *    就会丢掉中间那些改动。
   */
  if (textEditId.value) endTextEdit()
  textEditId.value = annotId
  syncTextEditAnnot()
  /*
   * `isNew` 没显式给出来时按"内容为空"推断。
   *
   * 这条兜底是有用的：编辑会话有**两个**入口（工具点出来的新建、以及"选中即进编辑"），
   * 后者拿不到这个标志。而空文本的框只可能是刚建出来的 —— 收尾时 `endTextEdit`
   * 会把没打字的框直接删掉，所以能存下来的框一定非空。
   */
  const fresh = isNew ?? String(a.contents ?? '').trim() === ''
  textEditBefore = fresh ? null : ({ ...a, rect: [...a.rect] as Rect } as Annotation)
  textMenuOpen.value = false
  // 焦点要等**编辑框真的渲染出来**才能给 —— 而它依赖异步算出来的位置。
  // 所以这里只挂个标记，由 refreshTextEditBox 在定位完成后收尾（见那里的注释）。
  textPendingFocus = true
  void refreshTextEditBox()
}

/** 把光标放到可编辑区末尾（重新编辑时用户多半是接着改） */
function focusTextEditor(): void {
  const el = textEditEl.value
  if (!el) return
  el.focus()
  const r = document.createRange()
  r.selectNodeContents(el)
  r.collapse(false)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(r)
}

/**
 * 把批注里的**原文**灌进可编辑区。进编辑态时调一次。
 *
 * 🔴 这个函数是必须的，别以为"编辑区会自己带上文字"：
 *    模板里的 `.te-input` 是个**空 div**（`contenteditable` 且没有子节点，
 *    Vue 不管它的内容），谁都没有往里面写过字。于是点一个**已有**的文本框：
 *    编辑区是**空的** —— 用户看到的是"原文被清除了"，接着一打字，
 *    整段原文就被新内容顶掉了（数据丢失级）。
 *    ⚠️ 之前测试没抓到，是因为测的路径全是"新建 + 打字"（新建时本来就该是空的）。
 *
 * 用 `textContent` 而不是 `innerText` 写入：后者会按当前排版做一次往返，
 * 在元素还没布局好时可能把换行吃掉；前者是逐字节的。
 * ⚠️ 但**读**回来仍然用 `innerText`（见 `onTextInput`）—— 两者对
 * `white-space: pre-wrap` 的文本是一一对应的。
 */
function fillTextEditor(a: FreeTextAnnot): void {
  const el = textEditEl.value
  if (!el) return
  // `text` 存的是**断行后**的文本（\n 分隔），正对着 pre-wrap 的渲染结果
  el.textContent = a.text
}

/**
 * 重算编辑框位置。缩放 / 版面变化后必须调，否则框会飘。
 *
 * ⚠️ 坐标是**相对 `.content`** 的，不是相对页槽：页槽是 `overflow: hidden` 的
 *（为了裁批注手柄），而编辑框的工具条要浮在框**上方**、右圆圈还会探出右边 ——
 * 挂在页槽里会被裁掉。所以这里额外加上该页在 `.content` 里的偏移。
 */
async function refreshTextEditBox(): Promise<void> {
  const token = ++textEditToken
  const a = currentFreeText()
  if (!a) {
    textEditBox.value = null
    return
  }
  const slot = layout.value?.pages.find((p) => p.pageNumber === a.pageNumber)
  if (!slot) {
    textEditBox.value = null
    return
  }
  const page = await props.doc.getPage(a.pageNumber)
  if (token !== textEditToken || textEditId.value !== a.id) return
  const tf = new PageTransform(page.getViewport({ scale: scale.value }))
  const [left, top, width, height] = tf.rectToView(a.rect)
  const s = scale.value
  textEditBox.value = { left: slot.x * s + left, top: slot.y * s + top, width, height }

  // 位置就绪 → 元素才真的挂上去了，这时候给焦点才有效
  if (textPendingFocus) {
    textPendingFocus = false
    await nextTick()
    // 顺序不能颠倒：先灌原文，再把光标放到末尾（"在原文本基础上改"）
    fillTextEditor(a)
    focusTextEditor()
  }
}

/**
 * 按当前框宽断行、写回批注，并把框高调成"正好放下这些行"。
 *
 * ⚠️ `text` 存**断行后**的文本（`\n` 分隔），`contents` 存**原始**文本：
 *    · `text` 给绘制与写回用（PDF 内容流没有自动换行，只能吃显式换行）
 *    · `contents` 是 /Contents，也是用户再次编辑时看到的原文 —— 不带我们插进去的换行
 */
function rewrap(a: FreeTextAnnot, raw: string): FreeTextAnnot {
  const wPt = a.rect[2] - a.rect[0]
  const pad = textPad(a.fontSize)
  const avail = Math.max(8, wPt - pad * 2)
  const lines = wrapText(raw, avail, a.fontSize)
  const lh = lineHeightOf(a.fontSize)
  const hPt = Math.max(lh + pad * 2, lines.length * lh + pad * 2)
  // 框**上边固定、往下长**（页面空间 y 向上，所以是 top - h）
  const top = a.rect[3]
  return {
    ...a,
    text: lines.join('\n'),
    contents: raw,
    rect: normalizeRect([a.rect[0], top - hPt, a.rect[2], top]),
  }
}

/**
 * 把改动写回正在编辑的那条批注，**并让界面立刻跟上**。
 *
 * ⚠️ 只调 `annotStore.replace` 是不够的，这一点很反直觉：
 *    `textEditFree` 是 computed，依赖的是 `textEditAnnotRef` 这个 shallowRef；
 *    而 `replace` 换掉的是 **store 里的对象**，ref 还指着**旧的那一份** ——
 *    computed 的依赖没变，于是缓存不失效，工具条（字号高亮 / 色板勾选 / A 按钮颜色）
 *    统统慢一拍。用户的观感就是"**选颜色要按两下**"：第一下真的改了色（画布已经变了），
 *    按钮却还是旧色，他以为没选中，又点一次 —— 第二下之所以"生效"，是因为
 *    `currentFreeText()` 里那次同步终于把 ref 追上了。
 *
 * 所以**所有**改编辑中批注的地方都必须走这里，不要直接 replace。
 */
function applyTextEdit(next: Annotation): void {
  annotStore.replace(next.id, next)
  syncTextEditAnnot() // ← 就是这一行让界面跟上（别删）
  onAnnotChanged(next.pageNumber)
}

/** 输入时：断行 + 回写 + 重绘（走 replace，不进历史 —— 整个编辑过程只记一条） */
function onTextInput(): void {
  const a = currentFreeText()
  const el = textEditEl.value
  if (!a || a.kind !== 'freetext' || !el) return
  const raw = el.innerText.replace(/\n$/, '')
  const next = rewrap(a as FreeTextAnnot, raw)
  applyTextEdit(next)
  emit('annot-count', annotStore.count())
  void refreshTextEditBox()
}

/**
 * Enter 自己插 `\n`，不用浏览器的默认行为。
 *
 * 默认行为会插入 `<div>` / `<br>`，取回的 `innerText` 里换行数不一定对得上
 * （空行尤其容易丢），而我们是按 `\n` 断行、按 `\n` 写回 PDF 的 —— 对齐不了就是
 * "编辑时看到的行数"和"写回后的行数"不一致。配合 `white-space: pre-wrap`，
 * 文本节点里的 `\n` 就是硬换行。
 */
function onTextKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    annotEditor?.setSelected(null) // 走统一出口 → onSelectionChange → endTextEdit
    return
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) return
    const r = sel.getRangeAt(0)
    r.deleteContents()
    const tn = document.createTextNode('\n')
    r.insertNode(tn)
    r.setStartAfter(tn)
    r.collapse(true)
    sel.removeAllRanges()
    sel.addRange(r)
    onTextInput()
    return
  }
  // 其它键（含 Ctrl+Z）留在编辑框里，别冒泡去触发全局快捷键
  e.stopPropagation()
}

/** 结束编辑：空文本的框直接删掉（"随手点一下"不该在文档里留个空框） */
/**
 * 两个文本框批注是不是"看起来完全一样"（进编辑态前后没改过东西）。
 *
 * 用来避免**空操作进历史**：点进一个文本框看看、再点走 —— 什么都没改，
 * 不该在撤销栈里多出一条"编辑"。多出来的那一下，用户按 Ctrl+Z 会觉得"没反应"。
 *
 * 只比对会影响观感与写回的字段：文字、框、颜色、字号。
 */
function sameFreeText(x: Annotation, y: Annotation): boolean {
  if (x.kind !== 'freetext' || y.kind !== 'freetext') return false
  const r = (a: FreeTextAnnot): string => a.rect.map((n) => n.toFixed(3)).join(',')
  const c = (a: FreeTextAnnot): string => a.color.map((n) => n.toFixed(3)).join(',')
  return (
    x.text === y.text && x.contents === y.contents && r(x) === r(y) && c(x) === c(y) &&
    x.fontSize === y.fontSize && x.opacity === y.opacity
  )
}

function endTextEdit(): void {
  const id = textEditId.value
  if (!id) return
  textEditId.value = null
  textEditBox.value = null
  textMenuOpen.value = false
  textEditAnnotRef.value = null
  const a = annotStore.get(id)
  if (!a || a.kind !== 'freetext') return

  /*
   * ⚠️ `textEditBefore === null` 就是「这是新建的框」的信号（见 `beginTextEdit`）。
   *    新建的框**不能**用 `commitEdit`：它会在 `add` 之上再压一条 `edit`，
   *    于是"撤销一次"只退回到空框，用户得按两次才删得掉。
   */
  const before = textEditBefore
  if (!String(a.contents ?? '').trim()) {
    /*
     * 空框（没打字就点空白处）：
     *   · 新建的 → 把那条 `add` 一起抹掉。不抹的话撤销会把空框请回来，
     *     而且它还会作为一条**空批注**被写进 PDF。
     *   · 编辑既有框时清空内容 = 删除 → 正常记一条 `remove`。
     */
    if (before) annotStore.remove(id)
    else annotStore.collapseNewAnnot(id, null)
    textEditBefore = null
    emit('annot-count', annotStore.count())
    emit('history-change', { canUndo: annotStore.canUndo(), canRedo: annotStore.canRedo() })
    void annotLayer?.render(a.pageNumber, scale.value)
    return
  }
  /*
   * 有内容：
   *   · 编辑既有框 → 整个编辑过程塌成**一条** `edit` 历史（途中都走 replace）
   *   · 新建的框 → 改写那条 `add` 的快照（见 `collapseNewAnnot`）
   */
  if (before && !sameFreeText(before, a)) annotStore.commitEdit(before, a)
  else if (!before) annotStore.collapseNewAnnot(id, a)
  textEditBefore = null
  onAnnotChanged(a.pageNumber)
}

/** 工具条：改字号（改完按新字号重新断行，框高跟着变） */
function setTextFontSize(size: number): void {
  const a = currentFreeText()
  if (!a) return
  const s = nearestFontSize(size)
  if (s === a.fontSize) return
  const next = rewrap({ ...a, fontSize: s }, String(a.contents ?? a.text))
  applyTextEdit(next)
  void refreshTextEditBox()
  // 记成"下一个新框的默认字号"（Edge 也是这个行为：工具栏挂在框上，改完就跟着走）
  emit('font-size-change', s)
}

/** 工具条：改字色 */
function setTextColor(c: Rgb): void {
  const a = currentFreeText()
  if (!a) return
  applyTextEdit({ ...a, color: [...c] as Rgb } as Annotation)
}

/** 工具条：删掉这个文本框 */
function deleteTextAnnot(): void {
  const a = currentFreeText()
  if (!a) return
  const pn = a.pageNumber
  textEditId.value = null
  textEditBox.value = null
  textEditBefore = null
  textEditAnnotRef.value = null
  annotStore.remove(a.id)
  annotEditor?.setSelected(null)
  emit('annot-count', annotStore.count())
  emit('history-change', { canUndo: true, canRedo: false })
  void annotLayer?.render(pn, scale.value)
}

// ---- 编辑框上的两个手柄：左实心条（拖动）/ 右圆圈（调宽度）

let textDrag: {
  mode: 'move' | 'width'
  startX: number
  startY: number
  rect: Rect
  scale: number
} | null = null

function onTextHandleDown(e: PointerEvent, mode: 'move' | 'width'): void {
  const a = currentFreeText()
  if (!a) return
  e.preventDefault()
  e.stopPropagation()
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  textDrag = {
    mode,
    startX: e.clientX,
    startY: e.clientY,
    rect: [...a.rect] as Rect,
    scale: Math.max(scale.value, 0.01),
  }
}

function onTextHandleMove(e: PointerEvent): void {
  if (!textDrag) return
  const a = currentFreeText()
  if (!a) return
  e.preventDefault()
  e.stopPropagation()
  const dx = (e.clientX - textDrag.startX) / textDrag.scale
  const dy = (e.clientY - textDrag.startY) / textDrag.scale
  const r = textDrag.rect
  if (textDrag.mode === 'move') {
    // 屏幕 y 向下、页面 y 向上 → dy 取反
    const next = [r[0] + dx, r[1] - dy, r[2] + dx, r[3] - dy] as Rect
    applyTextEdit({ ...a, rect: normalizeRect(next) } as Annotation)
  } else {
    // 只改宽度；改完必须重新断行，否则文字会溢出或提前换行
    const w = Math.max(24, r[2] - r[0] + dx)
    const wider = { ...(a as FreeTextAnnot), rect: normalizeRect([r[0], r[1], r[0] + w, r[3]]) as Rect }
    applyTextEdit(rewrap(wider, String(a.contents ?? a.text)))
  }
  void refreshTextEditBox()
}

function onTextHandleUp(e: PointerEvent): void {
  if (!textDrag) return
  e.preventDefault()
  e.stopPropagation()
  textDrag = null
  // 几何改动不在这里进历史 —— 整个编辑过程结束时统一塌成一条（见 endTextEdit）
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
/** 跳到某一页的页顶 */
async function goToPage(pageNumber: number): Promise<void> {
  await goToDestination(pageNumber, null)
}

/**
 * 跳到某个书签位置：页 + **页内纵向位置**（目录点击走这条）。
 *
 * ⚠️ 坐标必须翻一下：`destTop` 是 **PDF 页面坐标**（原点在左下），
 *    而版面里的 `p.y` 是**基准坐标**（原点在左上）：
 *      y = p.y + (p.height − destTop)
 *    漏了这一步的表现是"点标题跳到了那一页的**相反**一端"。
 *
 * ⚠️ 已知限制：`destTop` 是**未旋转**坐标，而 `p.height` 已含 /Rotate。
 *    旋转页（/Rotate 90/270）上纵向会不准 —— 这类 PDF 少见，
 *    且退化只是"落在页内某个位置"，不会跳错页。
 */
async function goToDestination(pageNumber: number, destTop: number | null): Promise<void> {
  const vp = viewportRef.value
  const l = layout.value
  if (!vp || !l) return
  const p = l.pages.find((x) => x.pageNumber === pageNumber)
  if (!p) return
  let y = p.y
  if (destTop !== null && Number.isFinite(destTop)) {
    // 夹到页内：dest 有可能指到页外（比如指向页脚以下）
    const fromTop = Math.max(0, Math.min(p.height, p.height - destTop))
    y = p.y + fromTop
  }
  // ⚠️ 这里的 `− ANCHOR_GAP` 必须和 `updateCurrentPage` 里的 `+ ANCHOR_GAP` 配对。
  vp.scrollTop = Math.max(0, y * scale.value - ANCHOR_GAP)
}

/** 所有行的基准 y（去重 + 升序） */
function rowTops(pages: readonly { y: number }[]): number[] {
  const set = new Set<number>()
  for (const p of pages) set.add(p.y)
  return [...set].sort((a, b) => a - b)
}

/**
 * 按**行**翻页（工具栏的 ‹ › 和 PageUp/PageDown 都走这里）。
 *
 * ⚠️ 不能简单地 `page ± 1`：双页模式下同一行有左右两页，
 *    +1 会停在**同一行** —— 视觉上完全没动，用户以为"点了没反应"，
 *    再点一次才真的翻过去。按行走才是"翻一屏"：
 *    单页模式一次 1 页，双页模式一次 2 页。
 */
async function stepPage(dir: 1 | -1): Promise<void> {
  const l = layout.value
  if (!l || !l.pages.length) return
  const rows = rowTops(l.pages)
  const cur = l.pages.find((p) => p.pageNumber === currentPage.value) ?? l.pages[0]!
  const i = rows.indexOf(cur.y)
  if (i < 0) return
  const nextY = rows[i + dir]
  if (nextY === undefined) return // 到头了就不动，别绕回开头
  const target = l.pages.find((p) => p.y === nextY)
  if (!target) return
  await goToPage(target.pageNumber)
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
  /** 跳到书签位置：页 + 页内纵向位置（目录点击用） */
  goToDestination,
  /** 按行翻页（‹ › / PageUp·PageDown）。双页模式一次翻一屏，见函数注释 */
  stepPage,
  /** 版面基准尺寸，缩略图算宽高比要用 */
  pageSizes: () => baseSizes.value,
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
  /**
   * 有没有**还没写回文件**的批注 —— 退出拦截的唯一依据。
   *
   * 两个条件都要：
   *   · `count() > 0` 排掉"画了一条又撤销掉"的情况（那种时候页已被标脏，
   *     但一条批注都没有，拦下来纯属骚扰）
   *   · `dirty` 排掉"已经导出过"的情况
   */
  hasUnsaved: () => annotStore.count() > 0 && annotStore.dirtyPages().size > 0,
  /** 导出成功后调用：清脏标记，之后退出不再拦截 */
  markSaved: () => {
    annotStore.markSaved()
  },
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
    inkWidth: () => props.inkWidth,
    fontSize: () => props.fontSize,
    // ⚠️ 要原样透传 `isNew`（别写成 `=== true`）—— `undefined` 走的是"按内容推断"那条路
    beginTextEdit: (id, isNew) => beginTextEdit(id, isNew),
    onChange: (pn) => onAnnotChanged(pn),
    onSelectionChange: (id) => {
      const a = id ? (annotStore.get(id) ?? null) : null
      selId.value = a?.id ?? null
      selPage.value = a?.pageNumber ?? 0
      emit('sel-change', a ? { id: a.id, kind: a.kind, color: a.color } : null)
      void updateSelBox()
      /*
       * 文本框一被选中就直接进编辑态。
       *
       * 这是复刻 Edge 的行为，也是唯一说得通的状态：文本框"选中但不可操作"
       * 对用户没有意义（别的批注选中是为了拖/改大小，文本框这两件事在编辑态里做）。
       *
       * ⚠️ 反过来说，**选中了别的东西（或点空）也必须结束编辑** ——
       *    否则会出现"框还开着、但选中的是另一条批注"，接着按 Delete 删掉的是那条
       *    而文本框还在光标里，两个状态打架。所以下面这个条件是"选中项 ≠ 正在编辑的那个"，
       *    不是简单的 `!a`。
       */
      if (a && a.kind === 'freetext') beginTextEdit(a.id)
      else if (textEditId.value && (!a || a.id !== textEditId.value)) endTextEdit()
    },
    onSelectionGeometry: () => void updateSelBox(),
    onHistoryChange: () => pushHistory(),
    onToolAutoExit: () => emit('tool-auto-exit'),
  })
}

onMounted(() => {
  renderer = new PageRenderer(props.doc, dpr, 2, (s) => emit('stats', s))

  annotLayer = new AnnotLayer(props.doc, dpr, (pn) =>
    // ⚠️ 编辑中的那个文本框要排除掉：画布画一遍、DOM 编辑框再画一遍，
    //    字会看起来被描粗，而且浏览器算出来的选区跟画布位置对不上。
    annotStore.list(pn).filter((a) => a.id !== textEditId.value),
  )
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
        // ⚠️ 翻页出问题时，光看工具栏页码是不够的：这个值是**组件内部**
        // 由 scrollTop 反算出来的。它和工具栏页码不一致，就说明反算错了
        // （曾经因为漏掉 ANCHOR_GAP 补偿，它总是算成上一行）。
        page: currentPage.value,
        scrollTop: viewportRef.value?.scrollTop ?? 0,
        // 下面这几个是"选中 / 拖动 / 改大小 / 撤销重做"的观察窗口。
        // 这类交互的 bug（框没动、手柄方向反了、重做没生效）光看截图看不出来，
        // 必须能直接读到数据和可用态。
        tool: props.tool,
        // 就地编辑框的位置（页内 CSS）。拖动之后"框有没有跟着走"要靠它判 ——
        // 量手柄的屏幕坐标也能判，但那样出错时分不清是框没动还是手柄没动。
        textEdit: textEditBox.value ? { ...textEditBox.value } : null,
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
          // 外观标量。测试要能判"工具栏选的档位真的落进数据了" ——
          // 只看渲染像素能发现"粗细没变"，但定位不到是数据没写进去还是绘制没读它。
          lineWidth: a.kind === 'ink' || a.kind === 'rect' ? a.lineWidth : undefined,
          fontSize: a.kind === 'freetext' ? a.fontSize : undefined,
          // 文本：判"自动换行断对没断对""提交后有没有留空框"都要看它
          text: a.kind === 'freetext' ? a.text : undefined,
          /** 原始文本（`text` 是断行后的）。两者必须分开看：写回 PDF 用 text，
           *  再编辑用 contents；只有 contents 为空的框才会被当成"没打字"删掉 */
          contents: a.kind === 'freetext' ? a.contents : undefined,
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
    annotLayer = new AnnotLayer(doc, dpr, (pn) =>
      annotStore.list(pn).filter((a) => a.id !== textEditId.value),
    )
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
  // 就地编辑框同理 —— 不重算的话，改完缩放编辑框会留在旧位置
  if (textEditId.value) void refreshTextEditBox()
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

/**
 * 版面变化（切单/双页、封面对齐）之后要**重新锚定到当前页**。
 *
 * 🔴 只调 `updateVisibility` 是不够的 —— 那是这版之前的写法，带来一个很显眼的 bug：
 *    双页一行放两页，内容总高差不多只有单页的一半。版面的 y 坐标全变了，
 *    而 `scrollTop` 是像素偏移、**不会自己换算**，于是同一个偏移落到别的页上：
 *      · 单页第 7 页 → 切双页 → 变成第 13 页（偏移变大了一倍）
 *      · 双页第 13 页 → 切单页 → 变成第 7 页
 *    用户报的就是后一条："从双页切换成单页时页码会除以 2"。
 *
 * 所以这里记住切换前的当前页，等新版面生效后用 `restoreTo` 重新定位 ——
 * 它可以复用 ANCHOR_GAP 那对成对的换算，不用在这里再写一次。
 */
watch(
  () => [props.mode, props.spreadOffset] as const,
  () => {
    const keep = currentPage.value
    const doc0 = props.doc
    void nextTick(() => {
      // 换文档时 App 也会顺手把 mode/spreadOffset 复位，那不是"用户切换视图" ——
      // 新文件该走自己的起始位置，别拿旧文档的页码去定位。
      if (props.doc !== doc0) return
      const l = layout.value
      if (!l?.pages.some((p) => p.pageNumber === keep)) return
      void restoreTo(scale.value, keep)
    })
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
            v-if="selBoxVisible && selPage === p.pageNumber && selBoxStyle"
            class="sel-box"
            :style="selBoxStyle"
            @dblclick.stop="onSelDblClick"
          >
            <template v-if="selHandlesVisible">
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
        <!--
          就地文本编辑框（复刻 Edge 的文本框）。

          ⚠️ 挂在 `.content` 上、**不是**页槽里：页槽是 `overflow: hidden`
             （为了裁批注手柄），而这里有两样东西必须探出页槽 ——
             浮在框上方的工具条、以及右边那个调宽度的圆圈。
           ⚠️ 容器是 `pointer-events: none`，只有子元素接手事件 ——
             这样"点在框外空白处"才真的落到页面上（从而结束编辑、收起框）。
        -->
        <div
          v-if="textEditFree && textEditStyle"
          class="text-edit"
          :style="textEditStyle"
          data-tid="text-edit"
        >
          <!-- 工具条：字号三档 + 字色 + 删除（贴框上方，position:fixed 由 CSS 决定） -->
          <div class="te-tools" @pointerdown.stop>
            <span class="te-label">字号</span>
            <button
              v-for="(s, i) in FONT_SIZES"
              :key="s"
              class="te-size"
              :class="{ on: textEditFree.fontSize === s }"
              :data-tid="`te-size-${i}`"
              :title="`字号${FONT_SIZE_LABELS[i]}（${s}pt）`"
              @click="setTextFontSize(s)"
            >
              {{ FONT_SIZE_LABELS[i] }}
            </button>
            <span class="te-sep" />
            <button
              class="te-icon-btn"
              data-tid="te-color"
              title="字体颜色"
              :style="{ color: rgbCss(textEditFree.color) }"
              @click.stop="textMenuOpen = !textMenuOpen"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <text x="12" y="17" text-anchor="middle" font-size="16" fill="currentColor">A</text>
              </svg>
              <span class="te-bar" :style="{ background: rgbCss(textEditFree.color) }" />
            </button>
            <span class="te-sep" />
            <button class="te-icon-btn" data-tid="te-delete" title="删除这个文本框" @click="deleteTextAnnot">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
              </svg>
            </button>

            <div v-if="textMenuOpen" class="te-swatches" @pointerdown.stop>
              <button
                v-for="c in FREETEXT_SWATCHES"
                :key="c.join()"
                class="te-sw"
                :class="{ on: c.join() === textEditFree.color.join() }"
                :style="{ background: rgbCss(c) }"
                :title="'字体颜色'"
                @click.stop="setTextColor(c)"
              />
            </div>
          </div>

          <!-- 左边那条实心把手：拖动整个框 -->
          <div
            class="te-grip"
            data-tid="te-grip"
            title="拖动文本框"
            @pointerdown="onTextHandleDown($event, 'move')"
            @pointermove="onTextHandleMove"
            @pointerup="onTextHandleUp"
            @pointercancel="onTextHandleUp"
          >
            <svg viewBox="0 0 6 10" aria-hidden="true">
              <circle cx="1.5" cy="1.5" r="1" /><circle cx="4.5" cy="1.5" r="1" />
              <circle cx="1.5" cy="5" r="1" /><circle cx="4.5" cy="5" r="1" />
              <circle cx="1.5" cy="8.5" r="1" /><circle cx="4.5" cy="8.5" r="1" />
            </svg>
          </div>

          <!-- 右边那个圆圈：调宽度 -->
          <div
            class="te-widen"
            data-tid="te-widen"
            title="拖动调整宽度"
            @pointerdown="onTextHandleDown($event, 'width')"
            @pointermove="onTextHandleMove"
            @pointerup="onTextHandleUp"
            @pointercancel="onTextHandleUp"
          />

          <div
            ref="textEditEl"
            class="te-input"
            data-tid="te-input"
            contenteditable="true"
            spellcheck="false"
            :style="textEditInnerStyle"
            @input="onTextInput"
            @keydown="onTextKeydown"
            @pointerdown.stop
          />
        </div>
      </div>
    </div>

    <!--
      文本框不再有"居中弹窗"这回事了 —— 改成页面上的就地编辑（见 .text-edit）。
      原来那个模态的模板/CSS 一起删掉了，免得留一堆没人用的死样式。
    -->
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
  background: var(--viewport-bg);
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
 * 标记类工具（高亮 / 下划线 / 删除线）**也要** none —— 这是「Surface 上
 * 单指一拖页面就跟着动」的直接解药。
 *
 * 之前这里故意不设，是因为标记工具要靠浏览器原生选区选词，而 touch-action
 * 一关就选不中了。现在改成自己算选区（见 markupTouch），这个顾虑不成立了。
 *
 * ⚠️ touch-action 是**手势开始前**的声明，不是拦截 —— 必须工具激活时就切好，
 *    等手指落下再改已经来不及（浏览器那一帧就已经判成 pan 了）。
 * ⚠️ 代价同样是"单指翻不了页"，靠双指平移/捏合补（同绘图工具）。
 */
.viewport.markup-tool {
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
  color: var(--dim);
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
  background: var(--btn);
  outline: 1px solid var(--line-strong);
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
  outline: 1.5px solid var(--accent-strong);
  outline-offset: -1px;
  background: var(--sel-wash);
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
  border: 1.5px solid var(--accent-solid);
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

/* ---- 就地文本框（复刻 Edge 的文本框） ---- */

/*
 * 容器只负责定位 + 三边虚线。左边那条由实心把手占掉，所以不给左边框。
 * ⚠️ `pointer-events: none`：让"点在框外空白处"真的落到页面上，
 *    从而结束编辑、把框收起来 —— 这是用户要的核心行为。
 */
.text-edit {
  position: absolute;
  pointer-events: none;
  z-index: 6;
  border: 1px dashed var(--accent-strong);
  border-left: 0;
  box-sizing: border-box;
}

/*
 * 可编辑区。
 *
 * ⚠️ **背景必须透明**，不能用主题底色。
 *    编辑框是压在 PDF 的**白纸**上的，字色是用户选的（常见是深蓝/黑）。
 *    一旦填主题底色，暗色主题下就变成"深色底 + 深色字" —— 打字时几乎看不见，
 *    而且这个问题只在暗色主题下出现，很容易漏测。Edge 也是透明的。
 */
.te-input {
  pointer-events: auto;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  outline: none;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: break-word;
  cursor: text;
  background: transparent;
}

/*
 * 左边实心把手：拖动整个框（Edge 就是这条蓝条）。
 *
 * 🔴 **必须在框外（负偏移）** —— 放在框内会**压住正文首字符**：
 *    它视觉上盖住的是文字，而文字并不因此让位（编辑区还是占满整个框宽，
 *    因为换行位置必须和写回 PDF 的宽度一致）。用户报的现象就是"左边这条挡住了字"。
 *    ⚠️ 不能改成"把正文往右挤 14px"来避让 —— 那样编辑时的换行位置就和
 *    写回 PDF 的宽度差 14px，变成"写回之后排版变了"。
 *    右边那个圆圈同理，本来就是 `right: -6px`。
 */
.te-grip {
  pointer-events: auto;
  position: absolute;
  left: -16px;
  top: 0;
  bottom: 0;
  width: 14px;
  background: var(--accent-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: move;
}
.te-grip svg {
  width: 6px;
  height: 10px;
  fill: rgba(255, 255, 255, 0.9);
}

/* 右边圆圈：调宽度 */
.te-widen {
  pointer-events: auto;
  position: absolute;
  right: -6px;
  top: 50%;
  width: 12px;
  height: 12px;
  margin-top: -6px;
  border-radius: 50%;
  background: var(--surface-2);
  border: 2px solid var(--accent-strong);
  cursor: ew-resize;
}

/* 工具条：浮在框上方（所以编辑框必须挂在 .content 上，见模板里的说明） */
.te-tools {
  pointer-events: auto;
  position: absolute;
  left: 0;
  bottom: calc(100% + 6px);
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px;
  background: var(--surface-2);
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  box-shadow: 0 6px 20px var(--shadow);
  white-space: nowrap;
}
.te-label {
  font-size: 11px;
  color: var(--dim);
  margin-right: 2px;
}
.te-size {
  min-width: 26px;
  height: 24px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--fg-2);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.te-size:hover {
  background: var(--hover);
}
.te-size.on {
  background: var(--btn);
  border-color: var(--line-strong);
  color: var(--fg);
}
.te-sep {
  width: 1px;
  height: 18px;
  background: var(--line);
  margin: 0 2px;
}
.te-icon-btn {
  position: relative;
  width: 26px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 5px;
  background: transparent;
  cursor: pointer;
  padding: 0;
}
.te-icon-btn:hover {
  background: var(--hover);
}
.te-icon-btn svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
}
/* 「A」下面那条颜色指示（和 Edge 那个 A 一致） */
.te-icon-btn .te-bar {
  position: absolute;
  left: 5px;
  right: 5px;
  bottom: 3px;
  height: 3px;
  border-radius: 1px;
}

/*
 * 色板：挂在**工具条上方**。
 *
 * 🔴 之前写的是 `top: calc(100% + 6px)`（工具条**下方**），而工具条下方那一块
 *    正是文本框自己的正文 —— 一弹出来就把字盖住了（用户报的"放在下面遮住文本内容"）。
 *    上方是空白的，往那边展开不挡任何东西。
 */
.te-swatches {
  position: absolute;
  left: 0;
  bottom: calc(100% + 6px);
  display: grid;
  grid-template-columns: repeat(5, auto);
  gap: 6px;
  padding: 8px;
  background: var(--surface-2);
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  box-shadow: 0 6px 20px var(--shadow);
}
.te-sw {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  padding: 0;
}
.te-sw.on {
  border-color: var(--on-accent);
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
  background: var(--sel-wash-strong);
}
</style>
