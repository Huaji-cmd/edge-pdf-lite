<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { PdfDocument } from './viewer/pdfDocument'
import PdfViewer from './viewer/PdfViewer.vue'
import { MarkdownDocument } from './viewer/markdownDocument'
import type { MdHeading } from './viewer/markdownDocument'
import MarkdownViewer from './viewer/MarkdownViewer.vue'
import { buildPrintHtml } from './viewer/mdPrint'
import ConvertGuideDialog from './viewer/ConvertGuideDialog.vue'
import ViewerToolbar from './viewer/ViewerToolbar.vue'
import SidePanel from './viewer/SidePanel.vue'
import TitleBar from './viewer/TitleBar.vue'
import Icon from './viewer/Icon.vue'
import { initTheme, resolveSaveDir, settings } from './viewer/settings'
import { docKindOf, MD_MAX_BYTES, OPEN_ACCEPT, UNSUPPORTED_HINT } from './viewer/documentKind'
import type { DocKind } from './viewer/documentKind'
import {
  loadMdReadingState,
  saveMdReadingState,
  clampMdScale,
} from './viewer/mdReadingState'
import {
  useFileList,
  readDocBytes,
  readBytesByPath,
  pathExists,
  stillExists,
  restoreList,
  pruneMissing,
} from './viewer/fileList'
import type { FileNode } from './viewer/fileList'
import { IS_TAURI } from './platform'
import type { PageSize, SidePanelKind } from './viewer/types'
import type { OutlineNode } from './viewer/outline'
import {
  loadReadingState,
  saveReadingState,
  loadLastDocument,
  saveLastDocument,
  clearLastDocument,
} from './viewer/readingState'
import type { ViewMode } from './viewer/types'
import { loadUiState, saveUiState, restorablePanel } from './viewer/uiState'
import type { RestorablePanel } from './viewer/uiState'
import type { ToolKind, ToolColors, PointerMode, Rgb, SelectedInfo } from './annot/types'
import {
  defaultToolColors,
  isColorTool,
  DEFAULT_INK_WIDTH,
  nearestInkWidth,
  DEFAULT_FONT_SIZE,
  nearestFontSize,
} from './annot/types'
// ⚠️ 不静态 import：pdf-lib 打包后有 570 KB（gzip 248 KB），
// 而"打开就为阅读"的用户一条批注都不会画。只有真的点「保存批注」才去拉它。
const loadWriter = () => import('./annot/writer')

const doc = shallowRef<PdfDocument | null>(null)
/*
 * 两种文档各自一套会话状态，**刻意不合并成"万能 Document"**。
 *
 * `doc` 仍然是 PDF 专用（批注、页数、指纹、书签都挂在它上面），`mdDoc` 是新增的；
 * `docKind` 只用来决定"界面上该出现哪些控件"。合并的想法很好听，但 PDF 那条链路上
 * 已经有 2900 行 PdfViewer + 批注写回 + 保存增量，任何"统一抽象"都得从那里改起。
 * 并列的好处是：PDF 的代码路径**一行都不用动**，出问题时边界很清楚。
 */
const docKind = ref<DocKind | null>(null)
const mdDoc = shallowRef<MarkdownDocument | null>(null)
/** Markdown 的字号缩放（1 = 100%）。与 PDF 的 `scale` 分开，语义不同、区间不同 */
const mdScale = ref(1)
/** 当前所在标题（大纲高亮） */
const mdActiveHeading = ref<string | null>(null)
const mdViewerRef = ref<InstanceType<typeof MarkdownViewer> | null>(null)
/**
 * 每次打开 Markdown 都 +1，作为阅读器组件的 `key`。
 *
 * ⚠️ **不能拿内容指纹当 key**：同一份文件再打开一次，指纹一样 ——
 *    Vue 会认为"还是那个组件"，只更新 props，于是 `onMounted` 不再执行：
 *    图片不会加载、`ready` 不会发出、阅读位置也不会恢复。
 *    症状是"第二次打开同一篇 md，图片全是占位、还停在上一处"。
 */
const mdOpenSeq = ref(0)
const mdHeadings = computed<readonly MdHeading[]>(() => mdDoc.value?.headings ?? [])
/** 「转 PDF 后批注」说明框 */
const showConvertGuide = ref(false)

const fileName = ref('')
const scale = ref(1.5)
const mode = ref<ViewMode>('single')
const spreadOffset = ref<0 | 1>(0)
const page = ref(1)

// ---------------------------------------------------------------- 侧边栏：文件 / 搜索 / 目录 / 缩略图

/**
 * 侧边栏的开合与当前面板会**跨启动记住**。
 *
 * 只在启动时读一次（`loadUiState()` 是最初值），之后每次变化由下面的 watch 落盘。
 * ⚠️ 别改成"每次用到时读 localStorage" —— 那会让面板状态变成非响应式的，
 *    而且手改 localStorage 之后界面不会跟着变。
 */
const initialUi = loadUiState()
const sideOpen = ref(initialUi.sideOpen)
/** 侧边栏当前显示哪个面板。默认「文件列表」—— 跟 Obsidian 一样，先从列表挑书 */
const panel = ref<SidePanelKind>(initialUi.panel)
const outline = ref<OutlineNode[]>([])
const outlineLoading = ref(false)
/** 各页基准尺寸 —— 缩略图靠它算宽高比和占位高度（没渲染出来之前也要占位） */
const pageSizes = ref<PageSize[] | null>(null)

/**
 * 加载书签目录。
 *
 * ⚠️ 空数组是**正常结果**，不是错误 —— 很多 PDF（尤其扫描件）根本没有书签。
 *    真正的提示交给 `OutlinePanel` 的空状态文案，这里不要弹错误框。
 */
async function loadOutline(): Promise<void> {
  const d = doc.value
  if (!d) {
    outline.value = []
    return
  }
  outlineLoading.value = true
  try {
    outline.value = await d.getOutline()
  } catch {
    outline.value = []
  } finally {
    outlineLoading.value = false
  }
}
const errorText = ref('')
const busy = ref(false)
const busyLabel = ref('正在打开…')
const dragging = ref(false)
/*
 * 提示条。
 *
 * `toastPath` 非空时会在提示里带一个「打开文件夹」按钮 ——
 * 保存之后用户最想知道的就是"存哪了"，光给一句话他要自己去找。
 */
const toast = ref('')
const toastPath = ref('')
let toastTimer: number | null = null

/**
 * 当前文件的**原始路径**。
 *
 * 只有桌面端从文件列表 / 对话框打开才有值 —— 浏览器里 `<input type=file>`
 * 和拖放都只给一个临时 File 对象，没有路径，也就没法"覆盖原文件"。
 * 空串表示"不知道原文件在哪"，保存时会自动退回"另存一份"。
 */
const currentSourcePath = ref('')

/** 当前批注工具；`none` = 纯阅读 */
const tool = ref<ToolKind>('none')
const annotCount = ref(0)

/**
 * 有没有**还没写回文件**的批注。
 *
 * ⚠️ 刻意**不**做后台自动暂存（不做 IndexedDB 悄悄存一份）。
 * 那会把"用户还没决定要不要留"的东西留下来，跟 Word 的语义不符：
 * Word 也不会替你存一个"未保存版本"。这里学 Word ——
 * **只在他真要离开的时候拦一下，决定权留给他**。
 *
 * 拦截点有两处，缺一不可：
 *   ① `beforeunload`：刷新 / 关标签 / 关窗口 / 浏览器后退
 *   ② `openBytes`：应用内换文档（这条 beforeunload 管不到，因为页面没卸载）
 */
const unsaved = ref(false)

function refreshUnsaved(): void {
  unsaved.value = viewerRef.value?.hasUnsaved() ?? false
}

function onAnnotCount(n: number): void {
  annotCount.value = n
  refreshUnsaved()
}

/** 指针模式：选择 / 滚动 / 拖动。与「工具」正交，互斥在下面的 setTool / setPointerMode 里保证 */
const pointerMode = ref<PointerMode>('select')

/** 各工具的当前配色。存 localStorage —— 换文档、重开浏览器都还是上次选的那套 */
const COLOR_KEY = 'epl:tool-colors'
const colors = ref<ToolColors>(loadColors())
const selected = ref<SelectedInfo | null>(null)
const canUndo = ref(false)
const canRedo = ref(false)

// ---------------------------------------------------------------- 安装为应用

/** Chrome / Edge 的非标准事件，lib.dom 里没有类型定义 */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
}

/**
 * Edge / Chrome 判定这个站点可安装时会派发 `beforeinstallprompt`，
 * **必须在那一刻拦下来存住**（`preventDefault()` 掉浏览器自己要弹的横幅），
 * 之后用户点按钮时才能调它的 `prompt()`。
 *
 * ⚠️ 这个事件只在页面加载早期派发一次，错过了就再也没有 ——
 * 所以监听写在 onMounted 里，不能等用户点按钮时才去挂。
 */
const installPrompt = shallowRef<InstallPromptEvent | null>(null)
/** 已经以应用形态在跑（独立窗口）就不用再提示安装了 */
const standalone = ref(false)
const canInstall = computed(() => !!installPrompt.value && !standalone.value)

/**
 * 触屏设备。
 *
 * 用途只有一个：告诉用户「单指画 / 双指翻页」——
 * 工具激活后单指被我们接管（否则浏览器会把手势抢去滚动），
 * 不说的话用户会以为"应用卡住了，翻不动"。
 */
const isTouchDevice =
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 0)
let touchTipShown = false

function loadColors(): ToolColors {
  const base = defaultToolColors()
  try {
    const raw = localStorage.getItem(COLOR_KEY)
    if (!raw) return base
    const obj = JSON.parse(raw) as Record<string, unknown>
    for (const k of Object.keys(base) as Array<keyof ToolColors>) {
      const v = obj[k]
      // 颜色是 [0..1, 0..1, 0..1]。不校验的话，手改坏的 localStorage 会把画布画成怪色
      if (
        Array.isArray(v) &&
        v.length === 3 &&
        v.every((n) => typeof n === 'number' && n >= 0 && n <= 1)
      ) {
        base[k] = [v[0] as number, v[1] as number, v[2] as number]
      }
    }
  } catch {
    /* 坏数据就当没配过 */
  }
  return base
}

function saveColors(): void {
  try {
    localStorage.setItem(COLOR_KEY, JSON.stringify(colors.value))
  } catch {
    /* 隐私模式下 localStorage 会抛异常，配色丢了也不该影响阅读 */
  }
}

/**
 * 手写笔尖粗细。和配色一样存 localStorage —— 换文档、重开应用都还是上次那档。
 *
 * ⚠️ 读进来要**吸附到最近的档位**：localStorage 里可能留着老版本写的任意数值，
 *    不吸附的话工具栏三个按钮会一个都不高亮，看着像"没有任何档位被选中"。
 */
const INK_WIDTH_KEY = 'epl:ink-width'
const inkWidth = ref(loadInkWidth())

function loadInkWidth(): number {
  try {
    return nearestInkWidth(JSON.parse(localStorage.getItem(INK_WIDTH_KEY) ?? 'null'))
  } catch {
    /* 坏数据当没配过 */
  }
  return DEFAULT_INK_WIDTH
}

function pickInkWidth(w: number): void {
  inkWidth.value = nearestInkWidth(w)
  try {
    localStorage.setItem(INK_WIDTH_KEY, JSON.stringify(inkWidth.value))
  } catch {
    /* 存不上就算了，不该影响画 */
  }
}

/**
 * 新建文本框的默认字号。
 *
 * ⚠️ 它**跟着"最后一次在某个文本框里选的字号"走**（见 `@font-size-change`）：
 *    Edge 也是这个行为 —— 工具栏是挂在框上的，改完这一档，下一个新框就用这一档。
 *    不这么做的话，用户在框里调好字号、再建一个又回到最小，会以为设置没生效。
 */
const FONT_SIZE_KEY = 'epl:font-size'
const fontSize = ref(loadFontSize())

function loadFontSize(): number {
  try {
    return nearestFontSize(JSON.parse(localStorage.getItem(FONT_SIZE_KEY) ?? 'null'))
  } catch {
    /* 坏数据当没配过 */
  }
  return DEFAULT_FONT_SIZE
}

function pickFontSize(size: number): void {
  fontSize.value = nearestFontSize(size)
  try {
    localStorage.setItem(FONT_SIZE_KEY, JSON.stringify(fontSize.value))
  } catch {
    /* 同上 */
  }
}

/**
 * 选工具 → 自动回到「选择」模式。
 *
 * 不这么做的话：用户在「滚动」模式下点「手写」，工具看着是选中了，
 * 但 pointerdown 会被 scroll 分支吃掉 —— 症状是"点了没反应"，而且很难联想到是模式问题。
 */
function setTool(t: ToolKind): void {
  tool.value = t
  if (t !== 'none') pointerMode.value = 'select'
  // 触屏上"进了工具就翻不动页"是个必然的取舍（单指被拿去画了），
  // 第一次踩到时说一声，否则用户只会觉得应用坏了
  if (t !== 'none' && isTouchDevice && !touchTipShown) {
    touchTipShown = true
    showToast('触屏：单指绘制 · 双指拖动 / 捏合缩放')
  }
}

/**
 * 切「拖动」→ 自动清掉工具。
 * 抓手会接管左键，工具也想要左键，两个并存就是"点下去到底画还是拖"的歧义。
 */
function setPointerMode(m: PointerMode): void {
  pointerMode.value = m
  if (m === 'pan') tool.value = 'none'
}

/** 色板：有选中项就改这一条，没有就改当前工具的默认色 */
function pickColor(c: Rgb): void {
  if (selected.value) {
    viewerRef.value?.applySelColor(c)
    return
  }
  if (isColorTool(tool.value)) {
    colors.value = { ...colors.value, [tool.value]: c }
    saveColors()
  }
}

function deleteSelected(): void {
  viewerRef.value?.deleteSelected()
}

function onHistoryChange(h: { canUndo: boolean; canRedo: boolean }): void {
  canUndo.value = h.canUndo
  canRedo.value = h.canRedo
}

const viewerRef = ref<InstanceType<typeof PdfViewer> | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)

// ---------------------------------------------------------------- 阅读位置记忆

let saveTimer: number | null = null
/** 恢复过程中不要回写，否则会把默认值当成"用户的阅读位置"存下来 */
let restoring = false

function flushSave(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const d = doc.value
  if (!d || restoring) return
  saveReadingState(d.fingerprint, {
    page: page.value,
    scale: scale.value,
    mode: mode.value,
    spreadOffset: spreadOffset.value,
  })
}

function scheduleSave(): void {
  if (restoring) return
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    flushSave()
  }, 600)
}

// ---------------------------------------------------------------- Markdown 的阅读位置

/**
 * Markdown 的落盘走**独立的一套**（键前缀 `epl:md-reading:`）。
 *
 * ⚠️ 千万不要复用到 `flushSave()` 里：那个读 `doc.value.fingerprint`，
 *    Markdown 期间 `doc` 是 `null`，写进去的会是一份"页码=1"的 PDF 记录，
 *    下次打开**同名 PDF** 还会被打回第一页。两套状态、两把键，边界才清。
 */
let mdSaveTimer: number | null = null
/** 恢复过程中不要回写（否则会把"还没恢复完的默认值"当成用户位置存下来） */
let mdRestoring = false

function flushMdSave(): void {
  if (mdSaveTimer !== null) {
    clearTimeout(mdSaveTimer)
    mdSaveTimer = null
  }
  const d = mdDoc.value
  if (!d || mdRestoring) return
  const snap = mdViewerRef.value?.snapshot()
  if (!snap) return
  saveMdReadingState(d.fingerprint, { ...snap, scale: mdScale.value })
}

function scheduleMdSave(): void {
  if (mdRestoring) return
  if (mdSaveTimer !== null) clearTimeout(mdSaveTimer)
  mdSaveTimer = window.setTimeout(() => {
    mdSaveTimer = null
    flushMdSave()
  }, 600)
}

watch(mdScale, scheduleMdSave)

/** 离开页面前把**两种**阅读位置都落盘（防抖可能还没到点） */
function flushAllReading(): void {
  flushSave()
  flushMdSave()
}

/**
 * Markdown 排版完成 → 恢复上次的缩放与位置。
 *
 * ⚠️ 顺序：**先改缩放，再恢复位置**。
 *    字号一变，同一段文字的滚动坐标就全变了；反过来做会先按旧字号定位、
 *    再重排一次把位置推走（用户看到的是"打开了，但不在上次那一段"）。
 */
async function onMdReady(): Promise<void> {
  const d = mdDoc.value
  if (!d) return
  const saved = loadMdReadingState(d.fingerprint)
  try {
    /*
     * 只恢复**位置**：缩放已经在 `openMarkdown` 里定好了（挂载前），
     * 这里再改会触发重排并把刚恢复的位置推走。
     */
    if (saved) mdViewerRef.value?.restore(saved)
  } finally {
    // ⚠️ 无论有没有可恢复的记录都要解除（没有记录时也得允许后续落盘），
    //    且要等一帧 —— 恢复引起的 scroll 事件会补一次落盘，别把中间态写进去
    void nextTick(() => {
      mdRestoring = false
    })
  }
}

/** 版面就绪后恢复上次的阅读位置 */
async function onViewerReady(): Promise<void> {
  const d = doc.value
  if (!d) return

  // ⚠️ 必须**无条件**设置（下面"没有记忆位置"时会提前 return）：
  //    缩略图要拿各页尺寸算宽高比和占位高度
  pageSizes.value = viewerRef.value?.pageSizes() ?? null

  const saved = loadReadingState(d.fingerprint)
  if (!saved) return

  restoring = true
  /*
   * 🔴 先把「显式恢复」闸门拉起来，再动 `mode`。
   *
   * 顺序不能反：设 `mode` 会触发 PdfViewer 里"单双页切换要锚定当前页"那个 watch，
   * 而它用的是**恢复前的** `currentPage`（还是 1）→ 它会去定位第 1 页，
   * 和下面这次恢复抢同一个滚动位置，经常后落地 → 把恢复整个覆盖掉
   * （实测：存 {page:50, scale:0.96, mode:dual}，打开后停在第 1 页 / 150%）。
   */
  viewerRef.value?.beginExplicitRestore()
  try {
    mode.value = saved.mode
    spreadOffset.value = saved.spreadOffset
    await nextTick()
    /*
     * ⚠️ 先把页码**夹进当前文档的范围**再恢复。存下来的值可能超出页数
     *    （这份 PDF 换成页数更少的版本时就会这样），而 `restoreTo` 拿到
     *    范围外的页码时找不到目标页。
     * 用 restoreTo 一次性定位。分开调用 applyScale + goToPage 会因为
     * 各自的"保持视口中心"逻辑互相抵消，落不到目标页（实测差了好几页）。
     */
    const want = Math.min(Math.max(1, Math.round(saved.page)), d.numPages)
    const landed = (await viewerRef.value?.restoreTo(saved.scale, want)) === true
    /*
     * 🔴 这里**不再给 `page.value` 赋值**。
     *
     * 原来那行 `page.value = Math.min(Math.max(1, saved.page), d.numPages)` 是把
     * "我们想去的页码"直接写成了现实 —— 恢复没成功时，工具栏就显示一个从没到过的页码，
     * 看起来像"记录生效了但没跳过去"。实际上 `restoreTo` 里的 `updateVisibility()`
     * 会 emit('page-change')，页面上的页码**已经是实际落点**了，不需要也不该再覆盖。
     *
     * 提示同理：只有真的落到了才说"已回到"。说不出实话就别说。
     */
    if (landed) showToast(`已回到上次的阅读位置：第 ${page.value} 页`)
  } finally {
    viewerRef.value?.endExplicitRestore()
    // 等一帧再解除，避免恢复引发的 watch 立刻回写
    void nextTick(() => {
      restoring = false
    })
  }
}

function showToast(msg: string, path?: string): void {
  toast.value = msg
  toastPath.value = path ?? ''
  if (toastTimer !== null) clearTimeout(toastTimer)
  // 带路径的提示要留久一点 —— 路径长，2.6 秒读不完
  toastTimer = window.setTimeout(
    () => {
      toast.value = ''
      toastPath.value = ''
      toastTimer = null
    },
    path ? 9000 : 2600,
  )
}

/** 提示条上的「打开文件夹」 */
async function openToastDir(): Promise<void> {
  if (!toastPath.value) return
  const { revealInFolder } = await import('./viewer/settings')
  if (!(await revealInFolder(toastPath.value))) showToast(`打不开：${toastPath.value}`)
}

// ---------------------------------------------------------------- 安装为应用

function onBeforeInstallPrompt(e: Event): void {
  // 拦掉浏览器自己弹的横幅，改由我们的按钮在合适的时机触发
  e.preventDefault()
  installPrompt.value = e as InstallPromptEvent
}

/**
 * 离开页面前的拦截。
 *
 * ⚠️ 两件事必须说清楚，否则很容易白写：
 *  1. **现代浏览器不会显示我们给的文字**。`returnValue` / `preventDefault()`
 *     只是一个开关，浏览器永远显示它自己那句（"你确定要离开此页面吗？"）。
 *     所以别费劲写提示文案 —— 真正的信息要靠**页面内的可见标记**传达。
 *  2. **要求页面发生过用户交互**才真的弹（防滥用）。我们的场景天然满足：
 *     有未保存批注就一定点过或画过。
 */
function onBeforeUnload(e: BeforeUnloadEvent): void {
  flushAllReading()
  if (!unsaved.value) return
  e.preventDefault()
  e.returnValue = ''
}

function onInstalled(): void {
  installPrompt.value = null
  standalone.value = true
  showToast('已安装为应用，可从开始菜单 / 任务栏启动')
}

async function installApp(): Promise<void> {
  const p = installPrompt.value
  if (!p) return
  try {
    await p.prompt()
  } catch {
    /* 用户取消或浏览器已自行处理，忽略 */
  }
  // prompt() 调过之后这个事件对象就作废了（不管用户最终装没装）
  installPrompt.value = null
}

watch([page, scale, mode, spreadOffset], scheduleSave)

// ---------------------------------------------------------------- 打开文件

/**
 * 打开任何一个**本应用支持**的文档（PDF / Markdown）。
 *
 * 这里是唯一的分流点：按扩展名决定走 PDF 还是 Markdown。
 * 两个分支各自维护自己的会话状态，**不共享**页码/缩放/批注。
 *
 * @returns 真的打开了返回 true；用户取消（未保存确认框点了取消）或失败返回 false
 *          —— 文件列表要靠这个决定要不要把高亮切过去，不然"点了取消但列表已跳走"
 */
async function openDocument(bytes: Uint8Array, name: string, path = ''): Promise<boolean> {
  const kind = docKindOf(name)
  if (!kind) {
    errorText.value = UNSUPPORTED_HINT
    return false
  }

  /*
   * 换文档会**清空整个批注 store**（批注按文档归属，不能跨文件漂）。
   * 这一步浏览器不会卸载页面，所以 `beforeunload` 拦不到 —— 必须自己问一句。
   *
   * ⚠️ 判定放在分流**之前**：从"有未保存批注的 PDF"切到 Markdown，同样会丢掉这些批注，
   *    不能因为"Markdown 没有批注"就跳过这一问。
   */
  if (
    unsaved.value &&
    !window.confirm(
      `《${fileName.value}》上还有 ${annotCount.value} 条批注没有保存。\n\n` +
        `打开新文件会丢掉它们，确定继续吗？\n\n` +
        `（想留住就先取消，点工具栏的「保存批注」）`,
    )
  ) {
    return false
  }

  if (kind === 'markdown') return openMarkdown(bytes, name, path)
  return openPdf(bytes, name)
}

/** 打开一份 PDF（原逻辑，行为不变） */
async function openPdf(bytes: Uint8Array, name: string): Promise<boolean> {
  errorText.value = ''
  // 打开新文档 = 原路径作废。桌面端从列表打开的会由调用方在成功后重新设上
  currentSourcePath.value = ''
  busyLabel.value = '正在打开…'
  busy.value = true
  try {
    const next = await PdfDocument.open(bytes, name)
    const prev = doc.value
    // 换文档前先把旧的阅读位置落盘（PDF 和 Markdown 各存一份）
    flushSave()
    flushMdSave()
    // 同一个会话里只能有一个"活着的文档"：把 Markdown 会话关掉，
    // 否则侧边栏的目录 / 标题高亮会指向一份已经看不见的文档
    const prevMd = mdDoc.value
    mdDoc.value = null
    doc.value = next
    docKind.value = 'pdf'
    fileName.value = name
    pageSizes.value = null
    // 目录要重新解析 —— 批注和书签都是按文档归属的，不能跨文件漂
    void loadOutline()
    page.value = 1
    scale.value = 1.5
    mode.value = 'single'
    spreadOffset.value = 0
    // 新文档接管之后再关掉旧的，避免中间出现空白
    if (prev) void prev.close()
    if (prevMd) prevMd.close()
    return true
  } catch (e) {
    errorText.value = errTextOf(e)
    return false
  } finally {
    busy.value = false
  }
}

/**
 * 打开一份 Markdown（只读）。
 *
 * 与 PDF 分支的差别不只是"渲染方式"：这里**必须**把 PDF 会话整个拆掉 ——
 * 批注计数、未保存标记、页码、缩略图尺寸都还挂在 `doc` 上，留着就会出现
 * "Markdown 页面上显示着一个未保存批注徽标"这种鬼东西。
 */
async function openMarkdown(bytes: Uint8Array, name: string, path: string): Promise<boolean> {
  /*
   * 大小闸门（前端这一层是给**拖进来的 File** 用的：它没有真实路径，
   * 到不了 Rust 的 stat 闸门）。桌面端从列表打开时 Rust 已经拦过一遍，
   * 这里再拦一次不亏 —— 两道闸门的存在意义就是"任一道坏了还有另一道"。
   */
  if (bytes.length > MD_MAX_BYTES) {
    errorText.value = `这个 Markdown 有 ${(bytes.length / (1 << 20)).toFixed(1)} MB，超过 ${
      MD_MAX_BYTES / (1 << 20)
    } MB 上限。这类文件要一次性解析完，太大在低配机上会卡住界面。`
    return false
  }

  errorText.value = ''
  currentSourcePath.value = ''
  busyLabel.value = '正在解析 Markdown…'
  busy.value = true
  try {
    const next = await MarkdownDocument.open(bytes, name, path)
    const prevPdf = doc.value
    const prevMd = mdDoc.value

    flushSave()
    flushMdSave()

    // 先把 PDF 会话完全关掉，再换 Markdown —— 顺序反了会有一帧"两个文档都在"
    doc.value = null
    pageSizes.value = null
    outline.value = []
    outlineLoading.value = false

    /*
     * 🔴 缩放必须在**挂载之前**就设成上次的值。
     *    挂载后再改会触发 MarkdownViewer 里"改字号保住锚点"的 watch，
     *    而那一刻组件刚建好、锚点还是文档开头 —— 两边会抢同一个滚动位置。
     *    先把初值摆对，`onMdReady` 就只需要恢复"位置"这一件事。
     */
    /*
     * 🔴 从现在起就"别回写"：接下来会改 mdScale（会触发 watch -> scheduleMdSave），
     *    而此刻正文还没挂载、也没恢复位置。若这时落盘，会把"顶部 = 0"写成用户的
     *    阅读位置 —— 一次打开就把记录冲掉。这个标志在 `onMdReady` 里解除。
     */
    mdRestoring = true
    const saved = loadMdReadingState(next.fingerprint)
    mdScale.value = saved ? clampMdScale(saved.scale) : 1

    mdDoc.value = next
    mdOpenSeq.value++
    docKind.value = 'markdown'
    fileName.value = name
    mdActiveHeading.value = null
    page.value = 1
    tool.value = 'none'
    selected.value = null
    annotCount.value = 0
    unsaved.value = false

    // 缩略图面板对 Markdown 不存在：停在那一页会是一片空白
    if (panel.value === 'thumbs') panel.value = 'outline'

    if (prevPdf) void prevPdf.close()
    if (prevMd) prevMd.close()
    return true
  } catch (e) {
    // 打开失败：别让"暂停回写"的闸门卡住（否则当前这份文档的位置再也不会落盘）
    mdRestoring = false
    errorText.value = errTextOf(e)
    return false
  } finally {
    busy.value = false
  }
}

/**
 * 把「抛出来/拒掉的那个东西」变成一句能给人看的话。
 *
 * 🔴 这不是洁癖：Tauri 命令返回 `Result<_, String>` 时，**失败拒的是一个字符串**，
 *    不是 `Error` 对象。前端写 `(e as Error).message` 拿到的是 `undefined` ——
 *    用户看到的就是"保存失败：undefined"，真正的错误（拒绝访问 / 只读 / 不在白名单）
 *    一个字都没露出来。这一条让用户白报了一次 bug，我这边也白猜了一轮。
 */
function errTextOf(e: unknown): string {
  if (typeof e === 'string') return e
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object' && 'message' in e) {
    return String((e as { message: unknown }).message)
  }
  try {
    const s = JSON.stringify(e)
    return s && s !== '{}' ? s : String(e)
  } catch {
    return String(e)
  }
}

// ---------------------------------------------------------------- 文件列表

const { nodes: fileNodes } = useFileList()
/** 当前打开的文件在列表里的 id（用于高亮那一行） */
const currentFileId = ref<string | null>(null)

/**
 * 点文件列表 / 搜索结果里的一个文件。
 *
 * 读字节这一步**两套实现**：桌面端用真实路径走 Rust 读，
 * 浏览器端读那个临时 File 对象（见 fileList.ts 的文件头）。
 *
 * ⚠️ 高亮**只在真的打开成功之后**才切过去 —— 用户在"未保存批注"的确认框上
 *    点了取消的话，列表还停在原来那份文件上，不能提前跳走。
 */
async function openFromList(node: FileNode): Promise<void> {
  // 桌面端：上次记住的文件可能已经被删了/移走了
  if (!(await stillExists(node))) {
    showToast(`《${node.name}》已经不在原来的位置了`)
    return
  }
  let bytes: Uint8Array
  try {
    bytes = await readDocBytes(node)
  } catch (e) {
    errorText.value = errTextOf(e)
    return
  }
  if (await openDocument(bytes, node.name, node.path ?? '')) {
    currentFileId.value = node.id
    currentSourcePath.value = node.path ?? ''
    // 记住"上次打开的是这一份" —— 下次启动会自动打开它（见 restoreLastDocument）
    if (node.path) saveLastDocument(node.path, node.name)
  }
}

/**
 * 工具栏「转 PDF 后批注」的分流：
 * 桌面版**真转换**（Edge 无头打印，见 convertCurrentMd）；
 * 浏览器版没有本地打印引擎，退回外部工具引导框（Pandoc / Typora）。
 */
function onConvertRequest(): void {
  if (IS_TAURI && docKind.value === 'markdown') {
    void convertCurrentMd()
  } else {
    showConvertGuide.value = true
  }
}

/**
 * 应用内 Markdown → PDF。
 *
 * 前端只负责**组装自包含的打印 HTML**（公式/高亮静态化、字体内嵌，见 mdPrint.ts）；
 * 保存对话框、临时文件、Edge 打印、输出路径登记全在 Rust 侧
 * （`convert_md_to_pdf` —— 对话框和登记不进前端是路径闸门的一部分）。
 * 转完**直接打开**转出的 PDF：转 PDF 的唯一目的是批注，别让用户再找一遍文件。
 */
async function convertCurrentMd(): Promise<void> {
  const d = mdDoc.value
  if (!d) return
  busyLabel.value = '正在生成 PDF…'
  busy.value = true
  try {
    const html = await buildPrintHtmlFor(d)
    const core = await import('@tauri-apps/api/core')
    const out = await core.invoke<string>('convert_md_to_pdf', { html })
    if (out === '__cancelled__') return // 保存对话框点了取消：不算错误
    showToast('已转成 PDF，正在打开…')
    const bytes = await readBytesByPath(out)
    await openDocument(bytes, out.split(/[\\/]/).pop() ?? '转换结果.pdf', out)
  } catch (e) {
    errorText.value = errTextOf(e)
  } finally {
    busy.value = false
  }
}

/** 组装打印 HTML（转换与调试钩子共用；公式/高亮的懒加载 chunk 顺带预热） */
function buildPrintHtmlFor(d: MarkdownDocument): Promise<string> {
  const dirIdx = d.path ? Math.max(d.path.lastIndexOf('\\'), d.path.lastIndexOf('/')) : -1
  return buildPrintHtml(d, {
    docDir: dirIdx > 0 ? d.path.slice(0, dirIdx) : undefined,
    allowAbsoluteImages: mdViewerRef.value?.isAbsApproved() ?? false,
  })
}

// 诊断钩子：test-exe 用它拿**当前文档的打印 HTML** 做产物质量断言
// （保存对话框是原生模态、CDP 点不了，所以全链路在测试里只跳过这一环）
if (IS_TAURI) {
  ;(globalThis as unknown as Record<string, unknown>).__eplMdPrint = {
    buildHtml: () => (mdDoc.value ? buildPrintHtmlFor(mdDoc.value) : Promise.resolve('')),
  }
}

/**
 * 启动时自动打开上次那篇 PDF（只有桌面端有路径可存）。
 *
 * 用户的原话：*"我看了一篇 pdf 之后关闭了软件，重新打开需要我重新打开本来的 pdf"*。
 * 阅读位置本来就记住了（按内容指纹），缺的只是"上次读的是哪个文件"这一步。
 *
 * ⚠️ 文件不在了就**必须把记录清掉**再提示 —— 否则每次启动都会读到同一个死路径，
 *    用户会反复看到同一条提示，还以为是坏了。
 */
async function restoreLastDocument(): Promise<void> {
  const last = loadLastDocument()
  // 已经有文档打开说明用户手快已经打开了别的，别抢
  if (!last || doc.value || mdDoc.value) return
  if (!(await pathExists(last.path))) {
    clearLastDocument()
    showToast(`上次打开的《${last.name}》已经不在原来的位置了`)
    return
  }
  try {
    const bytes = await readBytesByPath(last.path)
    if (await openDocument(bytes, last.name, last.path)) {
      currentSourcePath.value = last.path
      // 文件列表里已经有这一条的话，顺手把高亮也切过去
      currentFileId.value =
        fileNodes.value.find((n) => n.path === last.path)?.id ?? findNodeIdByPath(last.path)
    }
  } catch (e) {
    // 读不出来（权限/损坏）也清掉，免得每次启动都白试一遍
    clearLastDocument()
    console.warn('[last-doc] 恢复上次打开的文档失败：', e)
  }
}

/**
 * 在文件列表里按路径找条目 id（含一层层展开的子节点）。
 *
 * 顶层没找到不代表不在列表里 —— 从文件夹里打开的文件，它的节点在 children 里。
 * 只查顶层的话，重启后恢复文档时左边列表不会高亮，看起来像"没打开"。
 */
function findNodeIdByPath(path: string, list: readonly FileNode[] = fileNodes.value): string | null {
  for (const n of list) {
    if (n.path === path && n.kind === 'file') return n.id
    if (n.children) {
      const hit = findNodeIdByPath(path, n.children)
      if (hit) return hit
    }
  }
  return null
}

async function onPickFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  input.value = ''
  if (!f) return
  await openDocument(new Uint8Array(await f.arrayBuffer()), f.name)
}

function onDrop(e: DragEvent): void {
  e.preventDefault()
  dragging.value = false
  const f = e.dataTransfer?.files?.[0]
  if (!f) return
  /*
   * 拖放的白名单必须和对话框 / 目录扫描**用同一套判断**（`docKindOf`）。
   * 以前这里写的是 `/\.pdf$/i`，加格式时最容易漏的就是它 ——
   * 症状是"从文件夹点得开，拖进来却说不支持"。
   */
  if (!docKindOf(f.name)) {
    errorText.value = UNSUPPORTED_HINT
    return
  }
  void f.arrayBuffer().then((b) => openDocument(new Uint8Array(b), f.name))
}

function onDragOver(e: DragEvent): void {
  e.preventDefault()
  dragging.value = true
}

function onDragLeave(e: DragEvent): void {
  if (e.relatedTarget === null) dragging.value = false
}

// ---------------------------------------------------------------- 工具栏动作

/** 跳到指定页（页码输入框用） */
function goTo(p: number): void {
  const total = doc.value?.numPages ?? 1
  const target = Math.min(Math.max(1, p), total)
  page.value = target
  void viewerRef.value?.goToPage(target)
}

/**
 * 按**行**翻页（‹ › / PageUp·PageDown / 左右方向键）。
 *
 * 走 `stepPage` 而不是 `goTo(page ± 1)`：双页模式下同一行有左右两页，
 * `page + 1` 会停在**同一行** —— 视觉上完全没动，用户以为没反应，
 * 再点一次才真的翻过去。按行走一次翻一屏。
 */
function stepPage(dir: 1 | -1): void {
  void viewerRef.value?.stepPage(dir)
}

/** 从目录跳转（带页内纵向位置，所以能落到具体段落而不是页顶） */
function goToDest(p: number, top: number | null): void {
  void viewerRef.value?.goToDestination(p, top)
}

/**
 * 进入设置之前所在的面板 —— 再点一次齿轮就退回这里。
 *
 * ⚠️ 用 **watch** 维护，而不是"点齿轮那一刻记一下"：
 *    这样从设置里点顶栏的「目录」切走时，记忆也会跟着更新 ——
 *    `文件 → 设置 → 目录 → 再点设置` 应该回到**目录**，不是文件。
 */
let panelBeforeSettings: SidePanelKind = initialUi.panel
watch(panel, (p) => {
  if (p !== 'settings') panelBeforeSettings = p
})

/**
 * 把「侧边栏开合 + 当前面板」落盘。
 *
 * ⚠️ 放在上面那个 watch **之后**：Vue 的 watch 回调按创建顺序执行，
 *    这样 `panelBeforeSettings` 一定已经是新值了 —— 否则从"设置"里切走时
 *    会先把**旧的**面板写进 localStorage，重开就退回上一个面板。
 */
/** 上次真正记住的面板 —— 当前面板不适合记（大纲/缩略图）时沿用它 */
let rememberedPanel: RestorablePanel = initialUi.panel
function persistUiState(): void {
  const p = restorablePanel(panel.value, panelBeforeSettings)
  if (p) rememberedPanel = p
  saveUiState({ sideOpen: sideOpen.value, panel: rememberedPanel })
}
watch([sideOpen, panel], persistUiState)

/**
 * 切面板。设置是**可来回切**的：已经在设置里了，再点一次就退回上一个面板
 * （否则用户进了设置就出不来，除非去顶栏重新点一次）。
 */
function setPanel(p: SidePanelKind): void {
  panel.value = p === 'settings' && panel.value === 'settings' ? panelBeforeSettings : p
  sideOpen.value = true
}

/** 窗口当前是否最大化（决定标题栏显示「最大化」还是「还原」图标） */
const maximized = ref(false)

/**
 * 窗口控制（最小化 / 最大化 / 关闭）。
 *
 * ⚠️ 浏览器里这三个按钮**根本不渲染**（TitleBar 里 `v-if="IS_TAURI"`），
 *    所以这里在网页上永远不会被调用。
 *
 * ⚠️ **动态 import**：`@tauri-apps/api` 只有桌面端用得上，
 *    静态引入会让**浏览器版**也把它打进主包 —— 跟"只在必须付的时候付一次"冲突。
 */
async function onWindowAction(action: 'min' | 'max' | 'close'): Promise<void> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const win = getCurrentWindow()
  if (action === 'min') await win.minimize()
  else if (action === 'max') await win.toggleMaximize()
  else await win.close()
}

/** 把最大化状态同步进来（切图标用）。只在 Tauri 下有意义 */
async function syncMaximized(): Promise<void> {
  if (!IS_TAURI) return
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const win = getCurrentWindow()
    maximized.value = await win.isMaximized()
  } catch {
    /* 不是桌面端就无所谓 —— 那三个按钮不会渲染 */
  }
}

/**
 * 缩放 —— 按文档类型分流。
 *
 * ⚠️ 两个值不能混用：PDF 的 `scale` 是"页面放大倍数"（0.25–8），
 *    Markdown 的 `mdScale` 是"字号倍数"（0.75–2.5）。共用一个 ref 会让
 *    "从 150% 的 PDF 切到 Markdown"时正文直接变成 24px 起。
 */
function setScale(s: number): void {
  if (docKind.value === 'markdown') {
    mdScale.value = clampMdScale(s)
    return
  }
  void viewerRef.value?.applyScale(s)
}

/** 点大纲里的标题 */
function goHeading(id: string): void {
  mdViewerRef.value?.scrollToHeading(id, true)
}

/**
 * 打开外部链接。
 *
 * 桌面端走受控命令（Rust 侧再验一次协议白名单），浏览器端用新标签页。
 * **绝不**让 WebView 在当前窗口导航 —— 那会把整个阅读界面顶掉，
 * 而且回退之后 Vue 的状态已经没了。
 */
async function openExternalLink(href: string): Promise<void> {
  if (!IS_TAURI) {
    window.open(href, '_blank', 'noopener,noreferrer')
    return
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('open_external_url', { url: href })
  } catch (e) {
    errorText.value = `打不开链接：${errTextOf(e)}`
  }
}

function fitWidth(): void {
  void viewerRef.value?.fitWidth()
}

function fitPage(): void {
  void viewerRef.value?.fitPage()
}

// ---------------------------------------------------------------- 导出带批注的 PDF

/**
 * 保存批注 —— 按设置里的「保存方式」走两条不同的路。
 *
 * | 环境 | 另存 | 覆盖 |
 * |---|---|---|
 * | 桌面端 | 写到设置里的保存目录 | 写回原文件路径（**先自动留 .bak**） |
 * | 浏览器 | 下载到浏览器下载目录 | 做不到 —— 自动退回另存并说明原因 |
 *
 * 为什么覆盖要自动备份：这是不可逆操作，而没有备份的话"保存后想反悔"
 * 就只能靠重新画一遍。备份失败时**整个保存中止**（Rust 侧先备份后写），
 * 不会出现"备份没成、原文件已经被盖掉"这种最坏结果。
 *
 * ⚠️ 用户提的第一个问题就是"保存之后不知道存到哪了" ——
 *    所以每次保存都把**完整路径**写进提示，并附一个「打开文件夹」按钮。
 */
async function exportAnnotated(): Promise<void> {
  const d = doc.value
  if (!d) return
  const list = viewerRef.value?.getAnnotations() ?? []
  if (!list.length) {
    showToast('还没有批注')
    return
  }

  busyLabel.value = `正在生成带批注的 PDF（${list.length} 条）…`
  busy.value = true
  try {
    const { buildAnnotatedPdf, annotatedFileName } = await loadWriter()

    /*
     * 中文必须**嵌入字体**才画得出来（标准 14 字体没有 CJK 字形）。
     * 字体从系统读，读不到就退回占位横线 —— 所以要提前判断、提前说清楚，
     * 不能让用户存完才发现"怎么全是灰条"。
     */
    const hasCjk = list.some((a) => a.kind === 'freetext' && !/^[\x20-\x7E\r\n\t]*$/.test(a.text))
    const { loadCjkFont } = await import('./annot/cjkFont')
    const cjkFont = hasCjk ? await loadCjkFont() : null
    if (hasCjk && !cjkFont) {
      showToast(
        '这个环境里读不到系统中文字体（浏览器版没有文件系统），中文会存成占位横线 —— 用桌面版保存才能真的画出中文',
      )
    }

    const bytes = await buildAnnotatedPdf(d.originalBytes, list, { cjkFont })
    const name = annotatedFileName(fileName.value)

    // 已经落到文件里了 —— 之后退出不再拦截
    const done = (): void => {
      viewerRef.value?.markSaved()
      refreshUnsaved()
    }

    // ---- 浏览器：只有"下载"这一条路
    if (!IS_TAURI) {
      downloadBytes(bytes, name)
      done()
      showToast(`已下载 ${name}（在浏览器的下载目录里）`)
      return
    }

    const { invoke } = await import('@tauri-apps/api/core')
    const wantOverwrite = settings.value.saveMode === 'overwrite'
    const overwrite = wantOverwrite && currentSourcePath.value !== ''

    let target = ''
    let note = ''
    if (overwrite) {
      target = currentSourcePath.value
    } else {
      const dir = await resolveSaveDir()
      if (!dir) {
        // 拿不到目录也不能把用户的批注丢掉 —— 退回下载
        downloadBytes(bytes, name)
        done()
        showToast(`拿不到保存目录，已改为下载 ${name}`)
        return
      }
      target = joinPath(dir, name)
      // 选了覆盖但没有原路径（比如是拖进来的文件），要说清为什么没覆盖
      if (wantOverwrite) note = '（这个文件没有原路径，已改为另存）'
    }

    /*
     * `.bak` 放哪 —— 用户可以在设置里选「跟原文件同目录」还是「跟保存位置一致」。
     * 默认 same（老行为）；选了 saveDir 才把目录传下去，Rust 侧还要再核对一次
     * 白名单（备份 = 在目标目录里新建文件，同样要过闸门）。
     *
     * 具体备份成了哪个文件**由 Rust 回传**（它知道 .bak / .bak2 的排号），
     * 前端不猜 —— 猜错的话提示里的路径就是假的。
     */
    let backupDir: string | undefined
    if (overwrite && settings.value.backupPos === 'saveDir') {
      const dir = await resolveSaveDir()
      // 保存目录和原文件目录相同就没必要多传（Rust 会自己算出来）
      if (dir && dir !== targetDirOf(target)) backupDir = dir
    }

    /*
     * 🔴 大文件**不能**走"整份 base64 + IPC"。
     *
     * 实测（一本 92 MB / 376 页的扫描书，18 条批注）：
     *   · pdf-lib 自己 load + 加批注 + commit + Buffer base64 = **128 ms**
     *   · 但浏览器里 `bytesToBase64`（92 MB → 123 MB 字符串）+ `JSON.stringify`
     *     **超过 3 分钟**，用户就是在这一步干等的。
     *
     * 增量更新的产物 = 原文件字节 + 几千字节尾巴。所以只把尾巴传过去，
     * 让 Rust 复制原文件再追加 —— IPC 从 123 MB 降到几 KB。
     *
     * 三种情况会自动退回老路（整份 b64）：没有真实路径（拖进来的文件）、
     * 产物不是增量（writer 回退到全量重写）、文件头对不上。
     */
    const srcPath = currentSourcePath.value
    const originalLen = d.originalBytes.length
    const canTail =
      srcPath !== '' && bytes.length > originalLen && sameHead(bytes, d.originalBytes, 4096)

    // ⚠️ 参数名用 **camelCase**：Tauri v2 按前端 camelCase → Rust snake_case
    //    来匹配，写成 `make_backup` 会直接报 "missing required key"。
    const res = canTail
      ? await invoke<{
          path: string
          backup: string | null
          readonly_cleared: boolean
        }>('write_pdf_tail', {
          path: target,
          srcPath,
          // Rust 会核对原文件长度：读完之后被改过就拒绝写（宁可让它重开）
          srcLen: originalLen,
          tailB64: bytesToBase64(bytes.subarray(originalLen)),
          makeBackup: overwrite,
          backupDir: backupDir ?? null,
        })
      : await invoke<{
          path: string
          backup: string | null
          readonly_cleared: boolean
        }>('write_pdf_b64', {
          path: target,
          b64: bytesToBase64(bytes),
          makeBackup: overwrite,
          // ⚠️ 显式给 `null` 而不是留 undefined：Tauri v2 对 `Option<T>` 参数
          //    缺省行为不够明确，传 null 一定被当成 None
          backupDir: backupDir ?? null,
        })
    done()

    const parts: string[] = [overwrite ? '已覆盖原文件' : '已保存']
    if (res.backup) parts.push(`原件备份：${res.backup}`)
    // 只读文件写不进去 —— 我们取消了只读才写成功的，这件事必须说出来
    if (res.readonly_cleared) parts.push('原文件是只读的，已取消只读')
    showToast(`${parts.join(' · ')}${note}：${res.path}`, res.path)
  } catch (e) {
    console.error('[save] 失败', e)
    errorText.value = `保存失败：${errTextOf(e)}`
  } finally {
    busy.value = false
  }
}

/** 拼路径。打包目标只有 Windows，但 dev 时可能在别的系统 —— 两种分隔符都认 */
function joinPath(dir: string, name: string): string {
  const sep = dir.includes('/') && !dir.includes('\\') ? '/' : '\\'
  const base = dir.replace(/[\\/]+$/, '')
  // 盘符根（D:\）不能把末尾的斜杠去掉，否则会变成"当前目录下的相对路径"
  if (/^[A-Za-z]:$/.test(base)) return dir.endsWith(sep) ? dir + name : dir + sep + name
  return base + sep + name
}

/** 一个路径所在的目录（不引入 node:path —— 浏览器里没有） */
function targetDirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i > 0 ? p.slice(0, i) : ''
}

/**
 * 字节 → base64。
 *
 * ⚠️ 必须**分块**再 `fromCharCode`：一次性把 20 MB 展开成 apply 的参数
 *    会直接爆栈（V8 的参数个数上限）。8 KB 一块是常规做法。
 */
/**
 * 比较两个字节数组的前 `n` 个字节是否一致。
 *
 * 用来判断"产物是不是以原文件为前缀" —— 增量更新一定满足，全量重写一定不满足
 * （全量会把整个文件重新序列化，头部的对象编号/xref 位置都变了）。
 * 只比 4 KB 足够，且是 O(1) 级别的开销（相对 92 MB 来说）。
 */
function sameHead(a: Uint8Array, b: Uint8Array, n: number): boolean {
  if (a.length < n || b.length < n) return false
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false
  return true
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(s)
}

function downloadBytes(bytes: Uint8Array, name: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 5000)
}

// ---------------------------------------------------------------- 快捷键

function onKeydown(e: KeyboardEvent): void {
  const target = e.target as HTMLElement | null
  if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return
  /*
   * ⚠️ 就地文本框是 `contenteditable` 的 **div**，不是 INPUT/TEXTAREA ——
   *    只判 tagName 会漏掉它，于是在框里打字时会同时触发全局快捷键：
   *      Delete → 删掉选中的批注（正在编辑的这个！）
   *      Ctrl+Z → 走应用自己的撤销，而不是文本框内的撤销
   *      Ctrl+C/V → 被应用拦掉，粘贴不进文字
   *    这一条必须留着，否则"在文本框里改字"这个功能基本没法用。
   */
  if (target?.isContentEditable) return
  if (!doc.value && !mdDoc.value) return

  const ctrl = e.ctrlKey || e.metaKey
  const isMd = docKind.value === 'markdown'
  const curScale = isMd ? mdScale.value : scale.value
  /*
   * Ctrl+F：只对 Markdown 生效（PDF 的页内查找是另一条链路，本期没做）。
   * ⚠️ 必须 preventDefault：否则 WebView2 / 浏览器会自己弹原生查找条，
   *    那东西和我们的阅读区各管各的，用户会以为"搜不到"。
   */
  if (ctrl && (e.key === 'f' || e.key === 'F')) {
    if (isMd) {
      e.preventDefault()
      mdViewerRef.value?.toggleFind()
    }
    return
  }
  if (ctrl && (e.key === '=' || e.key === '+')) {
    e.preventDefault()
    setScale(curScale * 1.2)
  } else if (ctrl && e.key === '-') {
    e.preventDefault()
    setScale(curScale / 1.2)
  } else if (ctrl && e.key === '0') {
    e.preventDefault()
    setScale(1)
  } else if (isMd) {
    /*
     * Markdown 只保留**滚动**相关的键位。
     *
     * ⚠️ 撤销/重做/删除/翻页在 Markdown 下必须**什么都不做**，不能"顺手沿用 PDF 的分支"：
     *    那些分支最终会调到 `viewerRef`（PDF 组件），而它此刻是 null ——
     *    看起来没反应，实际是"按了键、被吃掉了"，跟"没这个功能"是两回事。
     */
    if (e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) {
      e.preventDefault()
      mdViewerRef.value?.scrollByPage(1)
    } else if (e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) {
      e.preventDefault()
      mdViewerRef.value?.scrollByPage(-1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      mdViewerRef.value?.scrollToEdge('start')
    } else if (e.key === 'End') {
      e.preventDefault()
      mdViewerRef.value?.scrollToEdge('end')
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      mdViewerRef.value?.scrollByStep(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      mdViewerRef.value?.scrollByStep(-1)
    }
  } else if (ctrl && e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
    // ⚠️ 必须排在"Ctrl+Z"前面：Ctrl+Shift+Z 的 e.key 是大写 'Z'，
    // 顺序反了就永远走不到重做这条分支（撤销会吃掉它）
    e.preventDefault()
    viewerRef.value?.redoAnnot()
  } else if (ctrl && (e.key === 'y' || e.key === 'Y')) {
    e.preventDefault()
    viewerRef.value?.redoAnnot()
  } else if (ctrl && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault()
    viewerRef.value?.undoAnnot()
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selected.value) {
      e.preventDefault()
      deleteSelected()
    }
  } else if (e.key === 'Escape') {
    /*
     * Markdown：先把查找条关掉（这是用户此刻最可能想 Escape 的东西）。
     * 焦点在查找框里时由输入框自己的 keydown 处理，走不到这里 —— 两条都不落空。
     */
    if (isMd && mdViewerRef.value?.closeFindIfOpen()) return
    // 退回阅读模式 —— 避免"工具还开着但忘了"导致误画
    tool.value = 'none'
    viewerRef.value?.clearSelection()
  } else if (e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) {
    e.preventDefault()
    stepPage(1)
  } else if (e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) {
    e.preventDefault()
    stepPage(-1)
  } else if (e.key === 'Home') {
    e.preventDefault()
    goTo(1)
  } else if (e.key === 'End') {
    e.preventDefault()
    goTo(doc.value?.numPages ?? 1)
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    stepPage(1)
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    stepPage(-1)
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('dragover', onDragOver)
  window.addEventListener('dragleave', onDragLeave)
  window.addEventListener('drop', onDrop)
  // 关页面前把阅读位置落盘（防抖可能还没到点）；顺带拦住未保存的批注
  window.addEventListener('beforeunload', onBeforeUnload)
  // pagehide 覆盖"切到后台/移动设备被杀"这类不触发 beforeunload 的情况
  window.addEventListener('pagehide', flushAllReading)
  // 应用形态判断 + 安装事件（见上面 installPrompt 的注释：只能在这儿挂）
  standalone.value = window.matchMedia?.('(display-mode: standalone)').matches ?? false
  window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
  window.addEventListener('appinstalled', onInstalled)

  // 主题要在挂载时就落到 DOM 上 —— 晚了会先闪一下暗色再变
  initTheme()

  /*
   * 桌面端：向宿主报一声「界面真的跑起来了」。
   *
   * 🔴 这一声是**唯一能判断"这次启动成没成"的信号**：白屏时我们的 JS 一次都不会执行，
   *    所以只要这个命令被调到，就说明页面加载、CSP、IPC 整条链是通的。
   *    Rust 那边（`heal_webview_profile`）拿它当"上次启动是否正常"的判据 ——
   *    跑不起来的那次不会留标记，下次启动就会自愈。
   */
  if (IS_TAURI) {
    void (async () => {
      try {
        const core = await import('@tauri-apps/api/core')
        await core.invoke('app_ready')
      } catch {
        /* 报不上就算了：顶多下次启动多清一次 profile，不该影响使用 */
      }
    })()
  }

  // 桌面端：恢复上次记住的文件列表，并清掉其中已经不存在的条目
  if (IS_TAURI) {
    restoreList()
    void pruneMissing()
    // 再把上次看的那一本直接打开 —— 用户要的是"重开还是那篇 PDF"
    void restoreLastDocument()
  }

  // 桌面端：同步最大化状态，并跟着窗口变化更新（标题栏的图标要靠它切换）
  if (IS_TAURI) {
    void syncMaximized()
    void installCloseGuard()
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        await getCurrentWindow().onResized(() => {
          void syncMaximized()
        })
      } catch {
        /* 非桌面端忽略 */
      }
    })()
  }
})

/**
 * 桌面端**关窗口**时的未保存拦截。
 *
 * 🔴 为什么不能只靠 `beforeunload`：WebView2 里关窗口走的是 Tauri 的
 *    `CloseRequested` → 直接销毁 webview，**不保证**跑页面的 beforeunload。
 *    实测（用户报的）：画完批注直接点 ✕，窗口就没了，什么都没问。
 *
 * 做法：拦下 CloseRequested → 用自己的确认框问 → 用户确认后 `destroy()`
 *（`destroy` 不会再触发一次 CloseRequested，避免死循环）。
 *
 * 🔴 **不能用 `window.confirm`**：WebView2 里它会让页面的 JS **整段阻塞**，
 *    而且 CDP 收不到 `Page.javascriptDialogOpening` —— 表现是"点了 ✕ 之后
 *    整个应用像死了一样，自动化测试也拿不到任何信号"。
 *    改用 Tauri 自己的 dialog 插件（Rust 侧的原生对话框，`await` 不阻塞页面）。
 *
 * ⚠️ 用户选"取消"时要**把 beforeunload 监听装回去** —— 上面为了不弹第二次
 *    临时摘掉过它；不装回去的话，之后刷新页面就不会再提醒了。
 */
let unlistenClose: (() => void) | null = null

async function installCloseGuard(): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const win = getCurrentWindow()
    unlistenClose = await win.onCloseRequested(async (event) => {
      if (!unsaved.value) return // 没有未保存的东西，直接放行
      event.preventDefault()
      // 先摘掉 beforeunload，避免"确认框一次 + 浏览器自己再弹一次"
      window.removeEventListener('beforeunload', onBeforeUnload)
      let ok = false
      try {
        const { ask } = await import('@tauri-apps/plugin-dialog')
        ok = await ask(
          `《${fileName.value}》上还有 ${annotCount.value} 条批注没有保存。\n\n` +
            `关闭窗口会丢掉它们，确定关闭吗？`,
          { title: '还有批注没有保存', kind: 'warning', okLabel: '仍然关闭', cancelLabel: '取消' },
        )
      } catch (e) {
        // 权限没开 / 插件异常：宁可别把人关在窗口里 —— 放行并说明
        console.warn('[close] 确认框弹不出来，按"继续关闭"处理：', e)
        ok = true
      }
      if (!ok) {
        window.addEventListener('beforeunload', onBeforeUnload)
        return
      }
      flushAllReading()
      await win.destroy()
    })
  } catch (e) {
    // 权限没开（capabilities 少了 allow-destroy）会走到这里 —— 此时退回
    // "只有 beforeunload"的老行为，不该让应用起不来
    console.warn('[close] 关闭拦截没装上：', e)
  }
}

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('dragover', onDragOver)
  window.removeEventListener('dragleave', onDragLeave)
  window.removeEventListener('drop', onDrop)
  window.removeEventListener('beforeunload', onBeforeUnload)
  window.removeEventListener('pagehide', flushAllReading)
  window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
  window.removeEventListener('appinstalled', onInstalled)
  unlistenClose?.()
  unlistenClose = null
  flushAllReading()
  void doc.value?.close()
  mdDoc.value?.close()
})
</script>

<template>
  <div class="app">
    <TitleBar
      :file-name="fileName"
      :side-open="sideOpen"
      :panel="panel"
      :doc-kind="docKind"
      :maximized="maximized"
      @toggle-side="sideOpen = !sideOpen"
      @set-panel="setPanel"
      @win="onWindowAction"
    />

    <ViewerToolbar
      :doc-kind="docKind"
      :num-pages="docKind === 'pdf' ? (doc?.numPages ?? 0) : 0"
      :page="page"
      :scale="docKind === 'markdown' ? mdScale : scale"
      :mode="mode"
      :spread-offset="spreadOffset"
      :tool="tool"
      :annot-count="annotCount"
      :unsaved="unsaved"
      :pointer-mode="pointerMode"
      :colors="colors"
      :ink-width="inkWidth"
      :selected="selected"
      :can-undo="canUndo"
      :can-redo="canRedo"
      @open="fileInputRef?.click()"
      @go-to="goTo"
      @step-page="(d) => stepPage(d)"
      @set-scale="setScale"
      @fit-width="fitWidth"
      @fit-page="fitPage"
      @set-mode="(m) => (mode = m)"
      @set-spread-offset="(o) => (spreadOffset = o)"
      @set-tool="setTool"
      @set-pointer-mode="setPointerMode"
      @pick-color="pickColor"
      @pick-ink-width="pickInkWidth"
      @undo="viewerRef?.undoAnnot()"
      @redo="viewerRef?.redoAnnot()"
      @delete-selected="deleteSelected"
      @export-annot="exportAnnotated"
      @convert-guide="onConvertRequest"
    />

    <!--
      侧边栏：文件 / 搜索 **在没有打开文档时也能用**（先从列表挑书，跟 Obsidian 一样）；
      目录 / 缩略图 需要文档，SidePanel 内部各自处理空状态。
    -->
    <div class="main">
      <SidePanel
        v-if="sideOpen"
        :panel="panel"
        :doc="doc"
        :doc-kind="docKind"
        :outline="outline"
        :outline-loading="outlineLoading"
        :md-headings="mdHeadings"
        :md-active-heading-id="mdActiveHeading"
        :sizes="pageSizes"
        :current-page="page"
        :file-nodes="fileNodes"
        :current-file-id="currentFileId"
        :busy="busy"
        @go-dest="goToDest"
        @go-page="goTo"
        @go-heading="goHeading"
        @open-file="openFromList"
        @set-panel="setPanel"
        @toast="showToast"
      />

      <PdfViewer
        v-if="doc"
        ref="viewerRef"
        v-model:scale="scale"
        :doc="doc"
        :mode="mode"
        :spread-offset="spreadOffset"
        :tool="tool"
        :pointer-mode="pointerMode"
        :colors="colors"
        :ink-width="inkWidth"
        :font-size="fontSize"
        @page-change="(p) => (page = p)"
        @ready="onViewerReady"
        @font-size-change="pickFontSize"
        @annot-count="onAnnotCount"
        @sel-change="(s) => (selected = s)"
        @history-change="onHistoryChange"
        @tool-auto-exit="tool = 'none'"
      />

      <!--
        `:key` 用内容指纹：换了文档就**重建组件**。
        复用同一个实例的话，滚动位置、已加载的图片 Blob URL、标题缓存都会残留，
        而"清干净"要写一堆 watch —— 重建比清理便宜也更不容易漏。
      -->
      <MarkdownViewer
        v-else-if="mdDoc"
        :key="mdOpenSeq"
        ref="mdViewerRef"
        :doc="mdDoc"
        :scale="mdScale"
        @ready="onMdReady"
        @scroll="scheduleMdSave"
        @heading-change="(id) => (mdActiveHeading = id)"
        @set-scale="setScale"
        @open-link="openExternalLink"
      />

      <div v-else class="welcome">
        <div class="welcome-box">
          <h1>edge-pdf-lite</h1>
          <p>把 PDF / Markdown 拖进来，或者点顶栏的文件夹图标 / 左侧「文件」面板添加。</p>
          <div class="welcome-actions">
            <button class="btn primary" @click="fileInputRef?.click()">选择文件</button>
            <button v-if="canInstall" class="btn" @click="installApp">安装为应用</button>
          </div>
          <p v-if="isTouchDevice" class="touch-hint">
            触屏：<strong>单指</strong>画 / 选文字 · <strong>双指</strong>拖动或捏合缩放
          </p>
          <p class="hint">
            快捷键：<kbd>Ctrl</kbd>+<kbd>滚轮</kbd> 缩放 ·
            <kbd>PageUp</kbd>/<kbd>PageDown</kbd> 翻页 ·
            <kbd>Ctrl</kbd>+<kbd>0</kbd> 回到 100%<br />
            批注（仅 PDF）：<kbd>Ctrl</kbd>+<kbd>Z</kbd> 撤销 ·
            <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> 重做 ·
            <kbd>Delete</kbd> 删除所选 ·
            <kbd>Esc</kbd> 退出工具
          </p>
        </div>
      </div>
    </div>

    <!-- 下面这些是覆盖层（position: fixed），留在 .app 下而不是侧边栏的 .main 里 -->
    <div v-if="dragging" class="drop-hint">松手打开 PDF / Markdown</div>
    <div v-if="busy" class="overlay">{{ busyLabel }}</div>
    <div v-if="toast" class="toast">
      <span class="toast-msg">{{ toast }}</span>
      <button
        v-if="toastPath"
        class="toast-open"
        data-tid="toast-open-dir"
        title="在文件管理器里显示这个文件"
        @click="openToastDir"
      >
        <Icon name="folder-open" /> 打开文件夹
      </button>
    </div>

    <div v-if="errorText" class="err" @click="errorText = ''">
      <pre>{{ errorText }}</pre>
      <span class="dim">（点击关闭）</span>
    </div>

    <input
      ref="fileInputRef"
      type="file"
      data-tid="open-input"
      :accept="OPEN_ACCEPT"
      hidden
      @change="onPickFile"
    />

    <!-- 「转 PDF 后批注」说明框：Markdown 是只读的，这是唯一的批注出路 -->
    <ConvertGuideDialog
      v-if="showConvertGuide"
      :file-name="fileName"
      :file-path="currentSourcePath"
      @close="showConvertGuide = false"
      @toast="showToast"
    />
  </div>
</template>

<style scoped>
.app {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

/* 工具栏下面这一横排：[侧边栏] [阅读区] */
.main {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
}

.btn {
  background: var(--btn);
  color: var(--fg);
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  padding: 6px 12px;
  font: inherit;
  cursor: pointer;
}
.btn.primary {
  background: var(--accent-solid);
  border-color: var(--accent-solid);
}
.btn.primary:hover {
  background: var(--accent-solid-hover);
}

.welcome {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.welcome-box {
  text-align: center;
  color: var(--fg);
}
.welcome-box h1 {
  font-size: 22px;
  font-weight: 600;
  margin: 0 0 8px;
  letter-spacing: 0.02em;
}
.welcome-box p {
  color: var(--dim);
  margin: 0 0 18px;
  font-size: 14px;
}
.welcome-actions {
  display: flex;
  gap: 8px;
  justify-content: center;
}
/* 触屏提示紧跟在按钮下面，不该有 `.welcome-box p` 那个 18px 下边距 */
.touch-hint {
  margin: 12px 0 0 !important;
  font-size: 12.5px !important;
}
.touch-hint strong {
  color: var(--fg-2);
  font-weight: 600;
}
.hint {
  margin-top: 22px !important;
  font-size: 12px !important;
}
kbd {
  background: var(--btn);
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 11px;
}

.drop-hint {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent-wash);
  border: 3px dashed var(--accent-solid);
  color: var(--fg);
  font-size: 18px;
  pointer-events: none;
}

.overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--scrim);
  color: var(--fg);
  font-size: 14px;
}

.err {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  max-width: min(720px, 90vw);
  background: var(--err-bg);
  border: 1px solid var(--err-line);
  border-left-width: 3px;
  border-radius: 8px;
  padding: 12px 16px;
  color: var(--err-fg);
  cursor: pointer;
  font-size: 13px;
}
.err pre {
  margin: 0;
  white-space: pre-wrap;
  font-size: 12px;
}
.dim {
  color: var(--dim);
  font-size: 11px;
}

.toast {
  position: fixed;
  left: 50%;
  top: 62px;
  transform: translateX(-50%);
  background: var(--toast-bg);
  border: 1px solid var(--accent-solid);
  border-radius: 8px;
  padding: 8px 16px;
  color: var(--toast-fg);
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: min(92vw, 720px);
  /* 整体不拦点击（它飘在工具栏上方），但下面的按钮要能按 */
  pointer-events: none;
  animation: toast-in 0.18s ease-out;
}
.toast-msg {
  min-width: 0;
  overflow-wrap: anywhere;
}
.toast-open {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  border: 1px solid var(--accent-solid);
  border-radius: 6px;
  background: transparent;
  color: var(--toast-fg);
  font-size: 12px;
  cursor: pointer;
  pointer-events: auto;
}
.toast-open:hover {
  background: var(--accent-wash);
}
.toast-open :deep(svg) {
  width: 13px;
  height: 13px;
}
@keyframes toast-in {
  from {
    opacity: 0;
    transform: translate(-50%, -6px);
  }
  to {
    opacity: 1;
    transform: translate(-50%, 0);
  }
}
</style>
