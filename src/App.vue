<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { PdfDocument } from './viewer/pdfDocument'
import PdfViewer from './viewer/PdfViewer.vue'
import ViewerToolbar from './viewer/ViewerToolbar.vue'
import SidePanel from './viewer/SidePanel.vue'
import TitleBar from './viewer/TitleBar.vue'
import Icon from './viewer/Icon.vue'
import { initTheme, resolveSaveDir, settings } from './viewer/settings'
import {
  useFileList,
  readPdfBytes,
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
const fileName = ref('')
const scale = ref(1.5)
const mode = ref<ViewMode>('single')
const spreadOffset = ref<0 | 1>(0)
const page = ref(1)

// ---------------------------------------------------------------- 侧边栏：文件 / 搜索 / 目录 / 缩略图

const sideOpen = ref(false)
/** 侧边栏当前显示哪个面板。默认「文件列表」—— 跟 Obsidian 一样，先从列表挑书 */
const panel = ref<SidePanelKind>('files')
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
  try {
    mode.value = saved.mode
    spreadOffset.value = saved.spreadOffset
    await nextTick()
    // 用 restoreTo 一次性定位。分开调用 applyScale + goToPage 会因为
    // 各自的"保持视口中心"逻辑互相抵消，落不到目标页（实测差了好几页）。
    await viewerRef.value?.restoreTo(saved.scale, saved.page)
    page.value = Math.min(Math.max(1, saved.page), d.numPages)
    showToast(`已回到上次的阅读位置：第 ${page.value} 页`)
  } finally {
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
  flushSave()
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
 * 打开一份 PDF。
 * @returns 真的打开了返回 true；用户取消（未保存确认框点了取消）或失败返回 false
 *          —— 文件列表要靠这个决定要不要把高亮切过去，不然"点了取消但列表已跳走"
 */
async function openBytes(bytes: Uint8Array, name: string): Promise<boolean> {
  /*
   * 换文档会**清空整个批注 store**（批注按文档归属，不能跨文件漂）。
   * 这一步浏览器不会卸载页面，所以 `beforeunload` 拦不到 —— 必须自己问一句。
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

  errorText.value = ''
  // 打开新文档 = 原路径作废。桌面端从列表打开的会由调用方在成功后重新设上
  currentSourcePath.value = ''
  busy.value = true
  try {
    const next = await PdfDocument.open(bytes, name)
    const prev = doc.value
    // 换文档前先把旧的阅读位置落盘
    flushSave()
    doc.value = next
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
    return true
  } catch (e) {
    errorText.value = (e as Error).message
    return false
  } finally {
    busy.value = false
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
    bytes = await readPdfBytes(node)
  } catch (e) {
    errorText.value = (e as Error).message
    return
  }
  if (await openBytes(bytes, node.name)) {
    currentFileId.value = node.id
    currentSourcePath.value = node.path ?? ''
    // 记住"上次打开的是这一本" —— 下次启动会自动打开它（见 restoreLastDocument）
    if (node.path) saveLastDocument(node.path, node.name)
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
  // doc 已有值说明用户手快已经打开了别的，别抢
  if (!last || doc.value) return
  if (!(await pathExists(last.path))) {
    clearLastDocument()
    showToast(`上次打开的《${last.name}》已经不在原来的位置了`)
    return
  }
  try {
    const bytes = await readBytesByPath(last.path)
    if (await openBytes(bytes, last.name)) {
      currentSourcePath.value = last.path
      // 文件列表里已经有这一条的话，顺手把高亮也切过去
      currentFileId.value = fileNodes.value.find((n) => n.path === last.path)?.id ?? null
    }
  } catch (e) {
    // 读不出来（权限/损坏）也清掉，免得每次启动都白试一遍
    clearLastDocument()
    console.warn('[last-doc] 恢复上次打开的文档失败：', e)
  }
}

async function onPickFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  input.value = ''
  if (!f) return
  await openBytes(new Uint8Array(await f.arrayBuffer()), f.name)
}

function onDrop(e: DragEvent): void {
  e.preventDefault()
  dragging.value = false
  const f = e.dataTransfer?.files?.[0]
  if (!f) return
  if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') {
    errorText.value = '只支持 PDF 文件'
    return
  }
  void f.arrayBuffer().then((b) => openBytes(new Uint8Array(b), f.name))
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
let panelBeforeSettings: SidePanelKind = 'files'
watch(panel, (p) => {
  if (p !== 'settings') panelBeforeSettings = p
})

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

function setScale(s: number): void {
  void viewerRef.value?.applyScale(s)
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
    const bytes = await buildAnnotatedPdf(d.originalBytes, list)
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

    // ⚠️ 参数名用 **camelCase**：Tauri v2 按前端 camelCase → Rust snake_case
    //    来匹配，写成 `make_backup` 会直接报 "missing required key"。
    const written = await invoke<string>('write_pdf_b64', {
      path: target,
      b64: bytesToBase64(bytes),
      makeBackup: overwrite,
    })
    done()
    showToast(
      `${overwrite ? '已覆盖原文件（原件备份为 .bak）' : '已保存'}${note}：${written}`,
      written,
    )
  } catch (e) {
    console.error('[save] 失败', e)
    errorText.value = `保存失败：${(e as Error).message}`
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

/**
 * 字节 → base64。
 *
 * ⚠️ 必须**分块**再 `fromCharCode`：一次性把 20 MB 展开成 apply 的参数
 *    会直接爆栈（V8 的参数个数上限）。8 KB 一块是常规做法。
 */
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
  if (!doc.value) return

  const ctrl = e.ctrlKey || e.metaKey
  if (ctrl && (e.key === '=' || e.key === '+')) {
    e.preventDefault()
    setScale(scale.value * 1.2)
  } else if (ctrl && e.key === '-') {
    e.preventDefault()
    setScale(scale.value / 1.2)
  } else if (ctrl && e.key === '0') {
    e.preventDefault()
    setScale(1)
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
    goTo(doc.value.numPages)
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
  window.addEventListener('pagehide', flushSave)
  // 应用形态判断 + 安装事件（见上面 installPrompt 的注释：只能在这儿挂）
  standalone.value = window.matchMedia?.('(display-mode: standalone)').matches ?? false
  window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
  window.addEventListener('appinstalled', onInstalled)

  // 主题要在挂载时就落到 DOM 上 —— 晚了会先闪一下暗色再变
  initTheme()

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

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('dragover', onDragOver)
  window.removeEventListener('dragleave', onDragLeave)
  window.removeEventListener('drop', onDrop)
  window.removeEventListener('beforeunload', onBeforeUnload)
  window.removeEventListener('pagehide', flushSave)
  window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
  window.removeEventListener('appinstalled', onInstalled)
  flushSave()
  void doc.value?.close()
})
</script>

<template>
  <div class="app">
    <TitleBar
      :file-name="fileName"
      :side-open="sideOpen"
      :panel="panel"
      :maximized="maximized"
      @toggle-side="sideOpen = !sideOpen"
      @set-panel="setPanel"
      @win="onWindowAction"
    />

    <ViewerToolbar
      :num-pages="doc?.numPages ?? 0"
      :page="page"
      :scale="scale"
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
        :outline="outline"
        :outline-loading="outlineLoading"
        :sizes="pageSizes"
        :current-page="page"
        :file-nodes="fileNodes"
        :current-file-id="currentFileId"
        :busy="busy"
        @go-dest="goToDest"
        @go-page="goTo"
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

      <div v-else class="welcome">
        <div class="welcome-box">
          <h1>edge-pdf-lite</h1>
          <p>把 PDF 拖进来，或者点顶栏的文件夹图标 / 左侧「文件」面板添加。</p>
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
            批注：<kbd>Ctrl</kbd>+<kbd>Z</kbd> 撤销 ·
            <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> 重做 ·
            <kbd>Delete</kbd> 删除所选 ·
            <kbd>Esc</kbd> 退出工具
          </p>
        </div>
      </div>
    </div>

    <!-- 下面这些是覆盖层（position: fixed），留在 .app 下而不是侧边栏的 .main 里 -->
    <div v-if="dragging" class="drop-hint">松手打开 PDF</div>
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
      accept="application/pdf,.pdf"
      hidden
      @change="onPickFile"
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
