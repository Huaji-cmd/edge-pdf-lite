<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { PdfDocument } from './viewer/pdfDocument'
import PdfViewer from './viewer/PdfViewer.vue'
import ViewerToolbar from './viewer/ViewerToolbar.vue'
import { loadReadingState, saveReadingState } from './viewer/readingState'
import type { RendererStats } from './viewer/pageRenderer'
import type { ViewMode } from './viewer/types'
import type { ToolKind, ToolColors, PointerMode, Rgb, SelectedInfo } from './annot/types'
import { defaultToolColors, isColorTool } from './annot/types'
// ⚠️ 不静态 import：pdf-lib 打包后有 570 KB（gzip 248 KB），
// 而"打开就为阅读"的用户一条批注都不会画。只有真的点「保存批注」才去拉它。
const loadWriter = () => import('./annot/writer')

const doc = shallowRef<PdfDocument | null>(null)
const fileName = ref('')
const scale = ref(1.5)
const mode = ref<ViewMode>('single')
const spreadOffset = ref<0 | 1>(0)
const page = ref(1)
const stats = ref<RendererStats | null>(null)
const errorText = ref('')
const busy = ref(false)
const busyLabel = ref('正在打开…')
const dragging = ref(false)
const toast = ref('')

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

function showToast(msg: string): void {
  toast.value = msg
  window.setTimeout(() => {
    if (toast.value === msg) toast.value = ''
  }, 2600)
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

async function openBytes(bytes: Uint8Array, name: string): Promise<void> {
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
    return
  }

  errorText.value = ''
  busy.value = true
  try {
    const next = await PdfDocument.open(bytes, name)
    const prev = doc.value
    // 换文档前先把旧的阅读位置落盘
    flushSave()
    doc.value = next
    fileName.value = name
    page.value = 1
    scale.value = 1.5
    mode.value = 'single'
    spreadOffset.value = 0
    stats.value = null
    // 新文档接管之后再关掉旧的，避免中间出现空白
    if (prev) void prev.close()
  } catch (e) {
    errorText.value = (e as Error).message
  } finally {
    busy.value = false
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
 * 用"下载一份新文件"的方式交付结果，而不是原地覆盖。
 *
 * 原因：浏览器里想原地覆盖必须走 File System Access API（拿到文件句柄），
 * 那条路只在 Chromium 系可用、且需要用户先授权；而"另存为"在任何浏览器都稳，
 * 也天然满足了"覆盖不可逆，先留一份"的安全要求。
 * 等 M8 上了 Tauri，再换成真正的原地写回 + 自动 `.bak`。
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
    downloadBytes(bytes, name)
    // 已经落到文件里了 —— 之后退出不再拦截
    viewerRef.value?.markSaved()
    refreshUnsaved()
    showToast(`已导出 ${name}`)
  } catch (e) {
    console.error('[export] 失败', e)
    errorText.value = `导出失败：${(e as Error).message}`
  } finally {
    busy.value = false
  }
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
    <ViewerToolbar
      :file-name="fileName"
      :num-pages="doc?.numPages ?? 0"
      :page="page"
      :scale="scale"
      :mode="mode"
      :spread-offset="spreadOffset"
      :stats="stats"
      :tool="tool"
      :annot-count="annotCount"
      :unsaved="unsaved"
      :pointer-mode="pointerMode"
      :colors="colors"
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
      @undo="viewerRef?.undoAnnot()"
      @redo="viewerRef?.redoAnnot()"
      @delete-selected="deleteSelected"
      @export-annot="exportAnnotated"
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
      @page-change="(p) => (page = p)"
      @stats="(s) => (stats = s)"
      @ready="onViewerReady"
      @annot-count="onAnnotCount"
      @sel-change="(s) => (selected = s)"
      @history-change="onHistoryChange"
      @tool-auto-exit="tool = 'none'"
    />

    <div v-else class="welcome">
      <div class="welcome-box">
        <h1>edge-pdf-lite</h1>
        <p>把 PDF 拖进来，或者点左上角的「打开 PDF」。</p>
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
        <!--
          B3 的说明。文件里已有的注释不进 store（符合"只改自己画的"这个设计），
          但对用户来说那批批注是"看得见却点不动" —— 不说明就会被当成工具坏了。
        -->
        <p class="hint caveat">
          ⚠️ 只改自己画的：PDF 里<b>原有的</b>批注看得见，但擦不掉、也拖不动<br />
          ⚠️ <b>中文</b>文本框在别的查看器里只显示占位框（标准字体没有中文字形）——
          文字没丢，在应用内和注释面板里都能看全
        </p>
      </div>
    </div>

    <div v-if="dragging" class="drop-hint">松手打开 PDF</div>
    <div v-if="busy" class="overlay">{{ busyLabel }}</div>
    <div v-if="toast" class="toast">{{ toast }}</div>

    <div v-if="errorText" class="err" @click="errorText = ''">
      <pre>{{ errorText }}</pre>
      <span class="dim">（点击关闭）</span>
    </div>

    <a class="spike-link" href="/spike.html">M0 实验页</a>

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
  background: #14161a;
}

.btn {
  background: #262b33;
  color: #dfe4ec;
  border: 1px solid #333a45;
  border-radius: 6px;
  padding: 6px 12px;
  font: inherit;
  cursor: pointer;
}
.btn.primary {
  background: #2b6cb0;
  border-color: #2b6cb0;
}
.btn.primary:hover {
  background: #3478c0;
}

.welcome {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.welcome-box {
  text-align: center;
  color: #dfe4ec;
}
.welcome-box h1 {
  font-size: 22px;
  font-weight: 600;
  margin: 0 0 8px;
  letter-spacing: 0.02em;
}
.welcome-box p {
  color: #8b93a1;
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
  color: #c8cfda;
  font-weight: 600;
}
.hint {
  margin-top: 22px !important;
  font-size: 12px !important;
}
/* 这条是"限制说明"，不能跟普通快捷键提示一个观感 —— 它要能被当成警示 */
.hint.caveat {
  margin-top: 8px !important;
  color: #b9954f !important;
}
.hint.caveat b {
  color: #e0c07a;
  font-weight: 600;
}
kbd {
  background: #262b33;
  border: 1px solid #333a45;
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
  background: rgba(43, 108, 176, 0.18);
  border: 3px dashed #2b6cb0;
  color: #dfe4ec;
  font-size: 18px;
  pointer-events: none;
}

.overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(10, 12, 15, 0.6);
  color: #dfe4ec;
  font-size: 14px;
}

.err {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  max-width: min(720px, 90vw);
  background: #2a1d1f;
  border: 1px solid #6b2b30;
  border-left-width: 3px;
  border-radius: 8px;
  padding: 12px 16px;
  color: #f0c6c9;
  cursor: pointer;
  font-size: 13px;
}
.err pre {
  margin: 0;
  white-space: pre-wrap;
  font-size: 12px;
}
.dim {
  color: #8b93a1;
  font-size: 11px;
}

.spike-link {
  position: fixed;
  right: 10px;
  bottom: 8px;
  font-size: 11px;
  color: #4a5260;
  text-decoration: none;
}
.spike-link:hover {
  color: #8b93a1;
}

.toast {
  position: fixed;
  left: 50%;
  top: 62px;
  transform: translateX(-50%);
  background: #22303f;
  border: 1px solid #2b6cb0;
  border-radius: 8px;
  padding: 8px 16px;
  color: #cfe2f7;
  font-size: 13px;
  pointer-events: none;
  animation: toast-in 0.18s ease-out;
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
