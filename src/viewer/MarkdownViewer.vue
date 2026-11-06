<script setup lang="ts">
/**
 * Markdown 只读阅读器。
 *
 * ## 它**不是** PdfViewer 的兄弟
 * PdfViewer 是"页式版面 + canvas + 文本层 + 批注层"，2900 行；
 * 这里是"一列会重排的文字"。两者唯一的共同点是"能滚动、能缩放"——
 * 那点共性不值得抽一层抽象，硬抽会把 PDF 的页式假设带进来（页码、单双页、页高缓存…）。
 *
 * ## 缩放是**字号缩放并重排**
 * 改的是根字号（`--md-fs`），所有间距用 `em` 跟着走；正文按版心宽度重新断行，
 * 所以**不会**出现整页横向滚动。表格和代码块自己横向滚（它们是"内容块"，
 * 不该为了迁就它们把整篇文字缩小）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from './Icon.vue'
import ImageAllowDialog from './ImageAllowDialog.vue'
import { mdImgBlockedText } from './markdownDocument'
import type { MdImgReason, MarkdownDocument } from './markdownDocument'
import { anchorOf, clampMdScale } from './mdReadingState'
import type { MdReadingState } from './mdReadingState'
import { IS_TAURI } from '@/platform'
import {
  canPickDirectory,
  ensurePermission,
  getStoredRoot,
  pickRoot,
  readAsset,
} from './mdBrowserAssets'

const props = defineProps<{
  doc: MarkdownDocument
  /** 1 = 100%（正文 16px） */
  scale: number
}>()

const emit = defineEmits<{
  /** 首次排版完成（含图片尝试加载）—— App 收到后才恢复阅读位置 */
  ready: []
  /** 滚动位置变了（已节流）。App 用它排一次防抖落盘 */
  scroll: []
  /** 当前所在标题变了（大纲高亮） */
  'heading-change': [id: string | null]
  /** Ctrl+滚轮 / Ctrl+加减 要求改缩放 */
  'set-scale': [scale: number]
  /** 点了一个外部链接 */
  'open-link': [href: string]
  toast: [msg: string]
}>()

const scroller = ref<HTMLElement | null>(null)
const body = ref<HTMLElement | null>(null)

/*
 * 桌面端：绝对路径图片（Typora 场景）的授权状态，按**文档指纹**记在会话里。
 * module 级（不是组件级）：同一篇文档重新打开（组件重建）不应该再弹一次；
 * 应用重启自然清空 —— "仅本次运行有效"的承诺就靠这个兑现。
 */
const absApprovedDocs = new Set<string>()
/** 非 null 时显示授权确认框；answered 防止"取消"后同一篇反复弹 */
const absDialogPaths = ref<string[] | null>(null)
let absDialogAnswered = false

/** 缩放进 style 用对象形式绑，避免 `--md-fs` 这种自定义属性进 TS 的类型检查 */
const pageStyle = computed<Record<string, string>>(() => ({
  '--md-fs': `${Math.round(16 * clampMdScale(props.scale) * 100) / 100}px`,
}))

// ---------------------------------------------------------------- 图片

/** 已经创建的 Blob URL —— 换文档 / 卸载时必须逐个回收，否则内存不会退 */
let blobUrls: string[] = []

/**
 * 单篇最多自动加载多少张本地图片。
 *
 * 不是安全限制（Rust 那边有大小和路径闸门），而是**低配机的体验限制**：
 * 一份带两百张截图的长笔记，一次读两百个文件会把磁盘和 DOM 都拖住。
 * 超出的显示"未自动加载"，而不是静默空白。
 */
const MAX_IMAGES = 100

function mimeOf(rel: string): string {
  const ext = rel.toLowerCase().split('.').pop() ?? ''
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'bmp':
      return 'image/bmp'
    default:
      return 'image/jpeg'
  }
}

function blockedText(reason: string): string {
  switch (reason) {
    // 文档层拦下的四种：文案统一走 markdownDocument（占位创建时就写在字面上）
    case 'remote':
    case 'absolute':
    case 'scheme':
    case 'empty':
      return mdImgBlockedText(reason as MdImgReason)
    case 'desktop-only':
      return '本地图片只在桌面版显示'
    /*
     * ⚠️ 桌面版拖进来的文件**没有真实路径**（HTML5 的 File 对象只带字节），
     *    读不到同目录的图。这种情况必须和"浏览器版不支持"分开说 ——
     *    否则用户在桌面版看到"本地图片只在桌面版显示"，第一反应是"我就是桌面版啊，坏了"。
     *    顺带把出路写清楚：从左侧文件列表打开就有路径了。
     */
    case 'no-path':
      return '这个文件是拖进来的，拿不到真实路径，本地图片读不到 —— 请从左侧「文件」列表打开'
    case 'missing':
      return '找不到这张图片'
    case 'limit':
      return '图片太多，这张未自动加载'
    default:
      return '图片未加载'
  }
}

function markBlocked(el: HTMLElement, reason: string, alt: string): void {
  el.classList.add('blocked')
  el.setAttribute('data-md-blocked', reason)
  el.textContent = alt ? `${alt}（${blockedText(reason)}）` : blockedText(reason)
}

/** 占位变成"点我授权"的形态（浏览器版专用） */
function markPickNeeded(el: HTMLElement, kind: 'pick' | 'perm'): void {
  el.classList.add('pickable')
  el.setAttribute('data-md-need-pick', kind)
  el.textContent =
    kind === 'pick'
      ? '点击选择笔记所在文件夹，显示本地图片'
      : '点击允许访问上次选择的文件夹，显示本地图片'
}

/**
 * 浏览器版的图片装载。
 *
 * 三种状态：
 *   · 没选过文件夹 / 权限回落到 'prompt' → 占位变成**可点击的授权入口**；
 *   · 已授权 → 逐个解析相对路径（`..` 在 API 层面就进不来，逃不出授权目录）；
 *   · 读不到 → "找不到"，同时保留**重新选文件夹**的点击出路（可能选错了目录）。
 */
async function loadBrowserImages(slots: HTMLElement[]): Promise<void> {
  const root = await getStoredRoot()
  if (!root) {
    for (const el of slots) markPickNeeded(el, 'pick')
    return
  }
  if (!(await ensurePermission(root))) {
    for (const el of slots) markPickNeeded(el, 'perm')
    return
  }
  let n = 0
  for (const el of slots) {
    const alt = el.getAttribute('data-md-alt') ?? ''
    if (n >= MAX_IMAGES) {
      markBlocked(el, 'limit', alt)
      continue
    }
    const rel = el.getAttribute('data-md-img') ?? ''
    if (!rel) {
      markBlocked(el, 'empty', alt)
      continue
    }
    n++
    try {
      const file = await readAsset(root, rel)
      const url = URL.createObjectURL(file)
      blobUrls.push(url)
      const img = new Image()
      img.src = url
      img.alt = alt
      const title = el.getAttribute('data-md-title')
      if (title) img.title = title
      img.loading = 'lazy'
      img.addEventListener('load', markOffsetsDirty, { once: true })
      el.replaceWith(img)
    } catch {
      markBlocked(el, 'missing', alt)
      // 读不到多半是"选错了文件夹" —— 保留重新选择的出路，别让用户卡死
      el.classList.add('pickable')
      el.setAttribute('data-md-need-pick', 'repick')
    }
  }
}

/** 占位的点击入口：授权（或重新授权）后把整篇的图重新装一遍 */
let picking = false
async function enableBrowserImages(): Promise<void> {
  if (picking) return
  picking = true
  try {
    let root = await getStoredRoot()
    if (!root || !(await ensurePermission(root))) root = await pickRoot()
    if (!root) {
      // 用户关掉了选择框 —— 占位保持，不打扰
      emit('toast', '没有选择文件夹，本地图片保持隐藏')
      return
    }
    const slots = [...(body.value?.querySelectorAll<HTMLElement>('[data-md-img]') ?? [])]
    await loadBrowserImages(slots)
  } finally {
    picking = false
  }
}

/** 把占位 span 换成真正的 `<img>`；失败就改成"说清原因"的占位 */
async function loadImages(): Promise<void> {
  const root = body.value
  if (!root) return
  const slots = [...root.querySelectorAll<HTMLElement>('[data-md-img]')]

  /*
   * 🔴 绝对路径图片（Typora 场景）必须**先于**"没有相对路径槽就早退"处理：
   *    一篇只有绝对路径图的笔记，`slots` 是空的，早退会把弹窗整个跳过
   *    （[7d] 就是这么红的——弹窗永远不出现）。它不依赖相对路径槽，
   *    闸门是授权弹窗 + 会话清单，与打开方式无关；**仅桌面端**有这条链路。
   */
  const absSlots = [
    ...root.querySelectorAll<HTMLElement>('span[data-md-blocked="absolute"][data-md-src]'),
  ]
  const absReady =
    IS_TAURI && absSlots.length > 0 && absApprovedDocs.has(props.doc.fingerprint)
  if (IS_TAURI && absSlots.length > 0 && !absReady && !absDialogAnswered) {
    absDialogPaths.value = absSlots
      .map((el) => el.getAttribute('data-md-src') ?? '')
      .filter((p) => p.length > 0)
  }

  if (!slots.length) {
    if (IS_TAURI && absReady) await loadAbsoluteImages(absSlots)
    return
  }

  if (!IS_TAURI) {
    /*
     * 浏览器版：File System Access API —— 用户授权一个文件夹，就能读到里面的图。
     * 不支持的浏览器（Firefox / Safari）才退回"仅桌面版"的死文案。
     */
    if (!canPickDirectory()) {
      for (const el of slots) {
        markBlocked(el, 'desktop-only', el.getAttribute('data-md-alt') ?? '')
      }
      return
    }
    await loadBrowserImages(slots)
    return
  }
  // 桌面版拖进来的文件：有字节、没路径 —— **相对路径**图只能标记 no-path
  // （没有真实路径就解析不出"文档所在目录"）；绝对路径图走上面的弹窗，不受影响。
  if (!props.doc.path) {
    for (const el of slots) {
      markBlocked(el, 'no-path', el.getAttribute('data-md-alt') ?? '')
    }
    if (absReady) await loadAbsoluteImages(absSlots)
    return
  }

  let n = 0
  /*
   * 并发读图（4 路）。
   *
   * 串行读 100 张图 = 100 次 IPC 往返，在机械盘 / 网盘目录上能拖到好几秒；
   * 一次全开又会把磁盘队列打满。4 是个不折腾的折中。
   */
  const queue = [...slots]
  const worker = async (): Promise<void> => {
    for (;;) {
      const el = queue.shift()
      if (!el) return
      const alt = el.getAttribute('data-md-alt') ?? ''
      if (n >= MAX_IMAGES) {
        markBlocked(el, 'limit', alt)
        continue
      }
      const rel = el.getAttribute('data-md-img') ?? ''
      if (!rel) {
        markBlocked(el, 'empty', alt)
        continue
      }
      n++
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const res = await invoke<ArrayBuffer | number[]>('read_doc_asset', {
          docPath: props.doc.path,
          relPath: rel,
        })
        const bytes = res instanceof ArrayBuffer ? new Uint8Array(res) : new Uint8Array(res)
        const url = URL.createObjectURL(
          new Blob([bytes as unknown as BlobPart], { type: mimeOf(rel) }),
        )
        blobUrls.push(url)
        const img = new Image()
        img.src = url
        img.alt = alt
        const title = el.getAttribute('data-md-title')
        if (title) img.title = title
        img.loading = 'lazy'
        /*
         * 图片一落地，后面所有标题都会往下移 —— 缓存的标题偏移必须作废，
         * 否则"跳转到第 N 节"会落到旧位置（差一张图的高度，而且越往后越偏）。
         */
        img.addEventListener('load', markOffsetsDirty, { once: true })
        el.replaceWith(img)
      } catch {
        markBlocked(el, 'missing', alt)
      }
    }
  }

  await Promise.all(Array.from({ length: 4 }, worker))

  /*
   * 相对路径已处理完（或没有）。这里收尾绝对路径那批（已授权的情况）。
   * 未授权的情况在前面已经弹了确认框。
   */
  if (absReady) await loadAbsoluteImages(absSlots)
}

/** 把已授权的绝对路径图片换成真正的 `<img>`（读走 Rust 的会话清单） */
async function loadAbsoluteImages(absSlots: HTMLElement[]): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  for (const el of absSlots) {
    const alt = el.getAttribute('data-md-alt') ?? ''
    const p = el.getAttribute('data-md-src') ?? ''
    if (!p) continue
    try {
      const res = await invoke<ArrayBuffer | number[]>('read_absolute_image', { path: p })
      const bytes = res instanceof ArrayBuffer ? new Uint8Array(res) : new Uint8Array(res)
      const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mimeOf(p) }))
      blobUrls.push(url)
      const img = new Image()
      img.src = url
      img.alt = alt
      const title = el.getAttribute('data-md-title')
      if (title) img.title = title
      img.loading = 'lazy'
      img.addEventListener('load', markOffsetsDirty, { once: true })
      el.replaceWith(img)
    } catch {
      markBlocked(el, 'missing', alt)
    }
  }
}

/** 弹窗"允许"：把清单交给 Rust 校验登记，然后整篇重装一遍图 */
/** Rust 侧的授权结果（部分成功语义，见 ImageAllowResult） */
interface ImageAllowResult {
  authorized: string[]
  failed: { path: string; reason: string }[]
}

async function approveAbsImages(): Promise<void> {
  const paths = absDialogPaths.value ?? []
  absDialogPaths.value = null
  absDialogAnswered = true
  if (!paths.length) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const res = (await invoke<unknown>('allow_image_paths', { paths })) as ImageAllowResult
    if (res.authorized.length > 0) {
      absApprovedDocs.add(props.doc.fingerprint)
      await loadImages()
    }
    if (res.failed.length > 0) {
      emit(
        'toast',
        `${res.failed.length} 张图片无法显示（文件可能已不存在或格式不支持），占位上有说明`,
      )
    }
  } catch {
    emit('toast', '授权失败：请确认图片存在且是 png/jpg/webp/gif/bmp，然后重试')
  }
}

function cancelAbsDialog(): void {
  absDialogPaths.value = null
  absDialogAnswered = true
}

function revokeAll(): void {
  for (const u of blobUrls) {
    try {
      URL.revokeObjectURL(u)
    } catch {
      /* 已经被回收过，忽略 */
    }
  }
  blobUrls = []
}

// ---------------------------------------------------------------- 位置度量

/**
 * 每个标题在**内容坐标**里的位置（px，从内容顶部算）。
 *
 * ⚠️ 用 `getBoundingClientRect().top - 内容原点` 而不是 `offsetTop`：
 *    `offsetTop` 是相对 offsetParent 的，而正文里套着列表/引用/表格容器，
 *    offsetParent 会变 —— 拿到的值会莫名其妙地小一截。
 *
 * 🔴 **必须缓存**：滚动高亮每帧都要这份数据。4778 个标题的长文档如果每帧做
 *    4778 次 `getBoundingClientRect`，就是每帧一次强制同步布局 —— 8 GB 机器上
 *    滚起来会明显发涩。内容不重排时这些坐标是常量，缓存住就够。
 *    失效点：缩放、图片落地、容器尺寸变化（见 ResizeObserver）。
 */
let cachedOffsets: number[] | null = null
let offsetsDirty = true

function markOffsetsDirty(): void {
  offsetsDirty = true
}

function headingOffsets(): number[] {
  const sc = scroller.value
  const b = body.value
  if (!sc || !b) return []
  if (!offsetsDirty && cachedOffsets && cachedOffsets.length === props.doc.headings.length) {
    return cachedOffsets
  }
  // 内容坐标原点：视口顶部在内容里的位置 = rect.top - scrollTop
  const originY = sc.getBoundingClientRect().top - sc.scrollTop
  const out = props.doc.headings.map((h) => {
    const el = b.querySelector(`#${CSS.escape(h.id)}`)
    return el ? el.getBoundingClientRect().top - originY : 0
  })
  cachedOffsets = out
  offsetsDirty = false
  return out
}

/** 视口顶部在内容坐标里的位置 */
function contentTop(): number {
  return scroller.value?.scrollTop ?? 0
}

// ---------------------------------------------------------------- 滚动 / 高亮

let rafPending = false
let lastHeading: string | null = null

function onScroll(): void {
  if (rafPending) return
  rafPending = true
  requestAnimationFrame(() => {
    rafPending = false
    // 高亮：视口上方 1/4 处"正压着"的那一节，比顶边更接近人的阅读焦点
    const probe = contentTop() + (scroller.value ? scroller.value.clientHeight * 0.25 : 0)
    const offs = headingOffsets()
    let idx = -1
    for (let i = 0; i < offs.length; i++) {
      if (offs[i]! <= probe) idx = i
      else break
    }
    const id = idx >= 0 ? (props.doc.headings[idx]?.id ?? null) : null
    if (id !== lastHeading) {
      lastHeading = id
      emit('heading-change', id)
    }
    emit('scroll')
  })
}

// ---------------------------------------------------------------- 缩放（Ctrl+滚轮）

function onWheel(e: WheelEvent): void {
  if (!e.ctrlKey && !e.metaKey) return
  // 必须 preventDefault：否则 WebView / 浏览器自己会缩放整个界面
  // （监听器用 addEventListener(..., { passive: false }) 挂，见 onMounted）
  e.preventDefault()
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
  emit('set-scale', clampMdScale(props.scale * factor))
}

// ---------------------------------------------------------------- 链接

function onClick(e: MouseEvent): void {
  // 浏览器版：点占位 → 授权文件夹 → 装图（必须在链接判断之前）
  if ((e.target as HTMLElement | null)?.closest('[data-md-need-pick]')) {
    void enableBrowserImages()
    return
  }
  const a = (e.target as HTMLElement | null)?.closest('a')
  if (!a) return
  const ext = a.getAttribute('data-md-href')
  if (ext) {
    // 一律不让 WebView 自己导航：外链交给系统浏览器（Rust 侧还会校验协议）
    e.preventDefault()
    emit('open-link', ext)
    return
  }
  const href = a.getAttribute('href') ?? ''
  if (href.startsWith('#')) {
    e.preventDefault()
    let id = href.slice(1)
    try {
      id = decodeURIComponent(id)
    } catch {
      /* 畸形转义就按原文找 */
    }
    scrollToHeading(id, true)
  }
}

// ---------------------------------------------------------------- 对外能力

function headingOffsetOf(id: string): number | null {
  const b = body.value
  const sc = scroller.value
  if (!b || !sc) return null
  const el = b.querySelector(`#${CSS.escape(id)}`)
  if (!el) return null
  const originY = sc.getBoundingClientRect().top - sc.scrollTop
  return el.getBoundingClientRect().top - originY
}

/** 跳到某个标题。`smooth` 只用于用户点击（恢复位置必须瞬时，否则会看到一段滑动） */
function scrollToHeading(id: string, smooth = false): void {
  const sc = scroller.value
  const top = headingOffsetOf(id)
  if (!sc || top === null) return
  // 留一点呼吸空间：标题贴着窗口顶边会被工具栏压住，看着像"没跳到位"
  sc.scrollTo({ top: Math.max(0, top - 16), behavior: smooth ? 'smooth' : 'auto' })
}

/** 当前位置（供 App 落盘 / 切文档前 flush） */
function snapshot(): Omit<MdReadingState, 'updatedAt'> {
  const sc = scroller.value
  if (!sc) {
    return { scrollRatio: 0, anchorId: null, anchorOffsetRatio: 0, scale: props.scale }
  }
  const a = anchorOf(
    props.doc.headings,
    headingOffsets(),
    sc.scrollTop,
    Math.max(1, sc.scrollHeight),
  )
  return { ...a, scale: clampMdScale(props.scale) }
}

/**
 * 恢复到某个位置。
 *
 * ⚠️ 恢复必须在**图片加载尝试之后**：一张本地图片从 0 高变成 800 高，
 *    会把后面所有标题往下推；先按文字位置恢复，图片一进来就全错位了。
 *    （调用方在 `ready` 之后调这里。）
 */
function restore(state: Pick<MdReadingState, 'scrollRatio' | 'anchorId' | 'anchorOffsetRatio'>): void {
  const sc = scroller.value
  if (!sc) return
  // 恢复前先作废缓存：调用方可能刚改过字号 / 刚插完图片
  markOffsetsDirty()
  const b = body.value
  const anchorTop = state.anchorId && b ? headingOffsetOf(state.anchorId) : null
  if (anchorTop !== null && state.anchorId) {
    // 用"到下一个标题的距离"当比例尺：这是内容坐标，换字号也不会漂
    const offs = headingOffsets()
    const i = props.doc.headings.findIndex((h) => h.id === state.anchorId)
    const start = anchorTop
    const end = i >= 0 && i + 1 < offs.length ? offs[i + 1]! : Math.max(start + 1, sc.scrollHeight)
    const target = start + Math.max(0, end - start) * state.anchorOffsetRatio
    sc.scrollTop = Math.max(0, target)
    return
  }
  // 没有锚点（比如停在文首、标题之前）就按整篇比例恢复。
  // 比例的定义是 `scrollTop / scrollHeight`（不是 / 最大滚动量），
  // 存和取必须是同一个公式，否则底部永远差一屏。
  sc.scrollTop = Math.max(0, state.scrollRatio * Math.max(1, sc.scrollHeight))
}

/** 按整屏滚动（PageUp / PageDown / 空格）。留 10% 重叠，眼睛有落点 */
function scrollByPage(dir: 1 | -1): void {
  const sc = scroller.value
  if (!sc) return
  sc.scrollBy({ top: dir * sc.clientHeight * 0.9 })
}

/** 方向键的小步滚动（一行多一点，跟浏览器默认手感接近） */
function scrollByStep(dir: 1 | -1): void {
  const sc = scroller.value
  if (!sc) return
  sc.scrollBy({ top: dir * 64 })
}

function scrollToEdge(edge: 'start' | 'end'): void {
  const sc = scroller.value
  if (!sc) return
  sc.scrollTop = edge === 'start' ? 0 : sc.scrollHeight
}

defineExpose({
  snapshot,
  restore,
  scrollToHeading,
  headingOffsetOf,
  scrollByPage,
  scrollByStep,
  scrollToEdge,
  openFind,
  closeFind,
  toggleFind,
  closeFindIfOpen,
  /** 「转 PDF」要用：这篇文档的绝对路径图片过没过授权弹窗（授权状态按指纹记在 module 级） */
  isAbsApproved: () => absApprovedDocs.has(props.doc.fingerprint),
})

// ---------------------------------------------------------------- 页内查找

/**
 * 页内查找用 **CSS Custom Highlight API**，不往正文里插 `<mark>`。
 *
 * 为什么不插标记：正文是 `v-html` 渲染的，缩放时会整段重排；插进去的 DOM
 * 既要在关闭时逐个还原，又会被下一次 patch 抹掉 —— 这类"改用户内容"的做法
 * 出错时的表现是"搜过一次之后正文排版变了"。Highlight API 只画高亮、不动 DOM，
 * 天然没有这个问题。WebView2 / Edge 都支持；不支持时**退化成只跳转、不高亮**
 * （功能不坏，只是看不见黄底）。
 */
const findOpen = ref(false)
const findQuery = ref('')
const findIndex = ref(0)
const findCount = ref(0)
const findInput = ref<HTMLInputElement | null>(null)

interface HighlightLike {
  add(r: Range): void
  clear(): void
}
type HighlightCtor = new (...ranges: Range[]) => HighlightLike
interface HighlightRegistry {
  set(name: string, h: HighlightLike): void
  delete(name: string): void
  get(name: string): HighlightLike | undefined
}

/*
 * 这两个全局对象在 TS 的 lib.dom 里还不一定有类型，所以自己描述最小形状 +
 * 运行时探测。⚠️ 不能写 `CSS.highlights!` 直接当它存在：老 WebView 上会抛。
 */
const highlightCtor = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight
const highlightRegistry = (
  globalThis as unknown as { CSS?: { highlights?: HighlightRegistry } }
).CSS?.highlights
const canHighlight = !!highlightCtor && !!highlightRegistry

/** 最多高亮多少个匹配。上千个 Range 在低配机上会让滚动明显变涩 */
const FIND_CAP = 1000

let findRanges: Range[] = []
let findTimer: number | null = null

/**
 * 在正文里找出所有匹配（大小写不敏感）。
 *
 * ⚠️ 已知局限：**跨行的词找不到**。`**粗**体`、`行内代码` 之类在 DOM 里被拆成多个
 *    文本节点，一个 Range 不能跨节点包住。要支持就得自己拼节点区间，
 *    复杂度和收益不成比例 —— 先按"绝大多数查找是单个词/短语"来做。
 */
function collectRanges(q: string): Range[] {
  const root = body.value
  const needle = q.trim().toLowerCase()
  if (!root || !needle) return []
  const out: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue ?? ''
    if (!text) continue
    const lower = text.toLowerCase()
    let i = lower.indexOf(needle)
    while (i >= 0 && out.length < FIND_CAP) {
      const r = document.createRange()
      r.setStart(n, i)
      r.setEnd(n, i + needle.length)
      out.push(r)
      i = lower.indexOf(needle, i + needle.length)
    }
    if (out.length >= FIND_CAP) break
  }
  return out
}

function paintFind(): void {
  if (!canHighlight || !highlightRegistry || !highlightCtor) return
  if (!findRanges.length) {
    highlightRegistry.delete('md-find')
    highlightRegistry.delete('md-find-active')
    return
  }
  highlightRegistry.set('md-find', new highlightCtor(...findRanges))
  const active = findRanges[findIndex.value]
  if (active) highlightRegistry.set('md-find-active', new highlightCtor(active))
  else highlightRegistry.delete('md-find-active')
}

function clearFind(): void {
  findRanges = []
  findCount.value = 0
  findIndex.value = 0
  paintFind()
}

function scrollToActive(): void {
  const sc = scroller.value
  const r = findRanges[findIndex.value]
  if (!sc || !r) return
  const rect = r.getBoundingClientRect()
  const scRect = sc.getBoundingClientRect()
  // 落在视口 1/4 处：上下都留出上下文，比贴顶好读
  const target = sc.scrollTop + (rect.top - scRect.top) - Math.min(140, sc.clientHeight * 0.25)
  sc.scrollTop = Math.max(0, target)
}

function runFind(): void {
  findRanges = collectRanges(findQuery.value)
  findCount.value = findRanges.length
  findIndex.value = 0
  paintFind()
  scrollToActive()
}

/** 输入时不要每敲一个字就全篇扫一遍：140ms 的防抖在长文上差别很明显 */
function scheduleFind(): void {
  if (findTimer !== null) clearTimeout(findTimer)
  findTimer = window.setTimeout(() => {
    findTimer = null
    runFind()
  }, 140)
}

watch(findQuery, scheduleFind)

function stepFind(dir: 1 | -1): void {
  if (!findRanges.length) return
  findIndex.value = (findIndex.value + dir + findRanges.length) % findRanges.length
  paintFind()
  scrollToActive()
}

async function openFind(): Promise<void> {
  findOpen.value = true
  /*
   * 浏览器惯例：选中了一段文字再按 Ctrl+F，就把它带进查找框 —— 省得用户再打一遍。
   * ⚠️ 只认**正文里**的选区：侧栏/工具栏里的选中不该被当成"要搜的词"。
   */
  const sel = window.getSelection()
  const text = sel?.toString().trim() ?? ''
  if (
    text &&
    text.length <= 80 &&
    !findQuery.value &&
    sel?.anchorNode &&
    body.value?.contains(sel.anchorNode)
  ) {
    findQuery.value = text
  }
  await nextTick()
  findInput.value?.focus()
  findInput.value?.select()
}

function closeFind(): void {
  findOpen.value = false
  findQuery.value = ''
  clearFind()
}

function toggleFind(): void {
  if (findOpen.value) closeFind()
  else void openFind()
}

/** 给 App 的 Esc 分支用：开着就关掉，并告诉调用方"这次 Esc 已被消费" */
function closeFindIfOpen(): boolean {
  if (!findOpen.value) return false
  closeFind()
  return true
}

// ---------------------------------------------------------------- 代码高亮

/**
 * 代码高亮 = **按需加载**的 highlight.js（common 语言包，约 35 种常用语言）。
 *
 * 为什么动态 import：这个项目最重的东西都不进首屏（pdf-lib 570 KB 也是点保存才拉）。
 * 大多数笔记根本没有代码块，为它们常驻 100 KB+ 的语言包违背 lite。
 * 首个带代码块的文档打开时拉一次，之后常驻内存。
 *
 * ⚠️ 只高亮**标注了语言**的块（```ts 这种）：
 *    highlightAuto 是纯 CPU 的猜测，长代码在 8 GB 机器上能卡出感知，还常猜错。
 *    没标语言的块保持等宽纯文本 —— 这是刻意的产品取舍，不是漏做。
 *
 * 安全：高亮对象是**已转义的纯文本**（markdownDocument 里过完 DOMPurify），
 * highlight.js 自己再转义一遍输出 —— 它不会把任何用户字符串变成元素。
 */
interface HljsApi {
  highlightElement(el: HTMLElement): void
  getLanguage(name: string): unknown
}

let hljsPromise: Promise<HljsApi | null> | null = null

function loadHljs(): Promise<HljsApi | null> {
  hljsPromise ??= import('highlight.js/lib/common')
    .then((m) => (m.default as unknown) as HljsApi)
    .catch(() => null)
  return hljsPromise
}

async function highlightCode(): Promise<void> {
  const root = body.value
  if (!root) return
  const blocks = [...root.querySelectorAll<HTMLElement>('pre code')]
  if (!blocks.length) return
  const hljs = await loadHljs()
  if (!hljs) return
  for (const el of blocks) {
    if (el.dataset.highlighted === 'yes') continue
    const lang = [...el.classList].find((c) => c.startsWith('language-'))?.slice(9) ?? ''
    if (!lang) continue
    try {
      // 未知语言（写错了名字）不强求 —— 保持纯文本，比报错或猜错都好
      if (!hljs.getLanguage(lang)) continue
      hljs.highlightElement(el)
    } catch {
      /* 单块高亮失败不影响整篇 */
    }
  }
}

// ---------------------------------------------------------------- 公式渲染（KaTeX 按需加载）

/**
 * 把文档里 texmath 留下的**公式占位**换成真正的 KaTeX 渲染结果。
 *
 * 为什么占位 → 后填：KaTeX 全家（JS + CSS + 字体引用）约 280KB，
 * 只在文档里**真的出现公式**才加载 —— 和 pdf-lib / highlight.js 同一条
 * "只在必须付的时候付一次"的纪律。占位本身是空 span，不会闪出原始 TeX。
 *
 * 安全：KaTeX 输出**不经过 DOMPurify**，直接 innerHTML —— 这是有意的：
 *   · 输入是 TeX 源码（从 data 属性解码回来），不是用户 HTML；
 *   · KaTeX 默认 `trust: false`，不许 \href 等逃逸构造，输出是固定结构；
 *   · 反过来，DOMPurify 的 FORBID_ATTR 会剥掉 KaTeX 排版必需的内联 style。
 * 也就是说"绕过净化器"在这里不是漏洞，是唯一正确的管线。
 */
interface KatexApi {
  renderToString(tex: string, opts?: Record<string, unknown>): string
}

let katexPromise: Promise<KatexApi | null> | null = null

function loadKatex(): Promise<KatexApi | null> {
  katexPromise ??= Promise.all([
    import('katex'),
    // CSS（含字体引用）跟着 JS chunk 一起懒加载；CSP 的 style/font-src 都是 'self'，够用
    import('katex/dist/katex.min.css'),
  ])
    .then(([m]) => (m.default as unknown) as KatexApi)
    .catch(() => null)
  return katexPromise
}

async function renderMath(): Promise<void> {
  const root = body.value
  if (!root) return
  const slots = [...root.querySelectorAll<HTMLElement>('[data-md-math]')]
  if (!slots.length) return
  const katex = await loadKatex()
  // 加载失败（极端网络/磁盘问题）：占位显示原始 TeX —— 比空白好，也比整篇报错好
  for (const el of slots) {
    let tex = ''
    try {
      tex = decodeURIComponent(el.dataset.mdMath ?? '')
    } catch {
      tex = el.dataset.mdMath ?? ''
    }
    const display = el.dataset.mdDisplay === '1'
    if (!katex) {
      el.textContent = tex
      el.classList.add('md-math-raw')
      continue
    }
    try {
      el.innerHTML = katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
        strict: false, // 老式 TeX 写法的警告不弹（console 噪音而已）
        trust: false, // 🔴 关掉 \href / \includegraphics 等可逃逸构造 —— 安全闸门
      })
    } catch {
      el.textContent = tex
      el.classList.add('md-math-raw')
    }
  }
}

// ---------------------------------------------------------------- 生命周期

/** 首次排版完成前不要响应缩放（否则会和"恢复阅读位置"抢滚动条） */
let mounted = false
/** 正文尺寸观察器（见 onMounted 里的说明） */
let ro: ResizeObserver | null = null

/**
 * 改字号时**保住当前读到的那一段**。
 *
 * 字号缩放是重排：内容高度整个变了，如果只是让 `scrollTop` 保持不变，
 * 放大 2.5 倍之后用户会被甩到完全不相干的地方（同一段文字跑到了几屏之外）。
 * 所以先按**内容坐标**记下当前锚点，重排完再按锚点落回去 ——
 * 这正是 `mdReadingState.ts` 里那套"标题 + 偏移"的用处，只是这里不落盘。
 */
let pendingAnchor: ReturnType<typeof snapshot> | null = null
let adjustScheduled = false

watch(
  () => props.scale,
  async (next, prev) => {
    if (!mounted || !scroller.value || Math.abs(next - prev) < 1e-6) return
    /*
     * 🔴 连续点缩放（或按住 Ctrl+滚轮）时必须**合并成一次校正**。
     *
     * 每次 scale 变化都要"量锚点 → 等重排 → 滚回去"，这三步跨帧。
     * 如果每一下都各排一次，第二步量到的已经是上一步重排后、但还没被校正的布局 ——
     * 于是误差会累积（实测连点两下就从顶部漂出 264px）。
     * 所以只记住**第一次**（也就是用户真正看到的那一刻）的锚点，最后统一校正一次。
     */
    if (!pendingAnchor) pendingAnchor = snapshot()
    if (adjustScheduled) return
    adjustScheduled = true
    await nextTick()
    await new Promise<void>((r) => requestAnimationFrame(() => r()))
    const anchor = pendingAnchor
    pendingAnchor = null
    adjustScheduled = false
    if (anchor) restore(anchor)
  },
)

onMounted(async () => {
  // wheel 必须是**非被动**监听才能 preventDefault（Ctrl+滚轮缩放要靠它）
  scroller.value?.addEventListener('wheel', onWheel, { passive: false })
  /*
   * 内容一重排（图片落地 / 窗口变宽变窄 / 字体加载完成），缓存的标题位置就过期了。
   * 用 ResizeObserver 盯正文高度，比自己猜"什么时候该重算"可靠。
   * ⚠️ 它只标记"脏"，真正的重算留到下一次需要时 —— 滚动中不做事。
   */
  if (typeof ResizeObserver !== 'undefined' && body.value) {
    ro = new ResizeObserver(markOffsetsDirty)
    ro.observe(body.value)
  }
  /*
   * 调试抓手（沿用 `__eplViewer` 的约定）：直接读状态，别靠猜。
   * Markdown 这边"位置恢复跳歪了"这类问题，没有抓手时只能靠肉眼对比截图。
   */
  ;(window as unknown as Record<string, unknown>).__mdViewer = {
    snapshot,
    restore,
    scrollToHeading,
    headingOffsetOf,
    scrollByPage,
    scrollByStep,
    scrollToEdge,
    el: () => body.value,
    scroller: () => scroller.value,
  }
  await nextTick()
  await loadImages()
  /*
   * 高亮只把文本换成等长的 span（字形不变、行高不变），理论上不动布局；
   * 但它要拉一个动态 chunk —— 放在 ready **之前**，保证恢复位置时一切就绪。
   */
  await highlightCode()
  /*
   * 公式和图片一样会**改变布局**（display 公式有可观的高度），
   * 必须也在 ready 之前落地 —— 否则恢复阅读位置时锚点偏移是旧的。
   */
  await renderMath()
  // 图片尺寸变化会把后面内容顶下去 —— 再等一帧让布局稳定，再告诉 App "可以恢复了"
  await nextTick()
  mounted = true
  emit('ready')
})

onBeforeUnmount(() => {
  scroller.value?.removeEventListener('wheel', onWheel)
  // 高亮是**全局注册表**，组件没了它还在 —— 必须自己清
  highlightRegistry?.delete('md-find')
  highlightRegistry?.delete('md-find-active')
  ro?.disconnect()
  ro = null
  delete (window as unknown as Record<string, unknown>).__mdViewer
  revokeAll()
})
</script>

<template>
  <!--
    `.md-shell` 只是给查找条一个定位参照：查找条必须**浮在阅读区上**，
    不能放进滚动容器里 —— 否则一滚就跟着内容跑掉了。
  -->
  <div class="md-shell">
    <div
      ref="scroller"
      class="md-view"
      data-tid="md-viewer"
      :data-md-headings="doc.headings.length"
      @scroll.passive="onScroll"
      @click="onClick"
    >
      <div class="md-page" :style="pageStyle">
        <!--
          v-html 的内容已经在 `markdownDocument.ts` 里过完 DOMPurify + URL 重写。
          这里**不要**再拼任何用户字符串 —— 那是绕开那套闸门的唯一方式。
        -->
        <article ref="body" class="md-body" role="document" v-html="doc.html" />
        <div class="md-foot">
          只读视图 · 需要批注请先用外部工具转成 PDF，再把 PDF 拖回来
        </div>
      </div>
    </div>

    <!-- 页内查找（Ctrl+F）。输入框自己吃掉键盘事件，别让全局快捷键抢走 -->
    <div v-if="findOpen" class="findbar" data-tid="md-find">
      <input
        ref="findInput"
        v-model="findQuery"
        class="find-input"
        data-tid="md-find-input"
        type="text"
        placeholder="在本文中查找"
        spellcheck="false"
        autocomplete="off"
        @keydown.enter.prevent="stepFind($event.shiftKey ? -1 : 1)"
        @keydown.esc.prevent.stop="closeFind"
      />
      <span class="find-count" data-tid="md-find-count">
        {{ findQuery.trim() ? (findCount ? `${findIndex + 1} / ${findCount}` : '无匹配') : '' }}
      </span>
      <button
        class="find-btn"
        data-tid="md-find-prev"
        :disabled="!findCount"
        title="上一个 (Shift+Enter)"
        @click="stepFind(-1)"
      >
        <Icon name="prev" />
      </button>
      <button
        class="find-btn"
        data-tid="md-find-next"
        :disabled="!findCount"
        title="下一个 (Enter)"
        @click="stepFind(1)"
      >
        <Icon name="next" />
      </button>
      <button class="find-btn" data-tid="md-find-close" title="关闭 (Esc)" @click="closeFind">
        <Icon name="close" />
      </button>
    </div>

    <!-- 桌面端：绝对路径图片的授权确认（安全模型的一部分，见 ImageAllowDialog） -->
    <ImageAllowDialog
      v-if="absDialogPaths"
      :file-name="doc.name"
      :paths="absDialogPaths"
      @allow="approveAbsImages"
      @cancel="cancelAbsDialog"
    />
  </div>
</template>

<style scoped>
/* 外壳：只提供"相对定位"和布局，不参与滚动 */
.md-shell {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
}

.md-view {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  /*
   * 整个阅读区就是"纸面"（用户定的：左右不露灰边，只有代码块是灰的）。
   * ⚠️ 不用 --viewport-bg —— 那是 PDF 的"灰底托白纸"结构，Markdown 没有页，
   *    铺灰底会变成"整片灰"。
   */
  background: var(--md-page-bg);
  /* 滚动的容器必须能拿到焦点链上的滚动锚定；关掉自动锚定，
     否则缩放后浏览器会自作主张保持某段文字不动，和"按比例恢复"打架 */
  overflow-anchor: none;
}

.md-page {
  /*
   * 版心：最宽 820px。再宽一行就 40+ 个汉字，眼睛回行会累。
   * 缩放改的是 `--md-fs`，下面所有尺寸都用 em —— 一起放大，但**版心不变**，
   * 所以不会因为放大就冒横向滚动条（那正是"字号缩放"和"画布缩放"的区别）。
   *
   * 🔴 纸面（--md-page-bg）是**必须的**：阅读区是灰底（和 PDF 共用一套设计，
   *    PDF 灰底上飘着白纸），Markdown 没有纸面的话整片都是灰的 ——
   *    用户看到的第一反应就是"整个背景怎么是灰的"。
   */
  background: var(--md-page-bg);
  max-width: 820px;
  margin: 0 auto;
  padding: 40px 32px 80px;
  font-size: var(--md-fs, 16px);
  line-height: 1.75;
  color: var(--fg);
  font-family: 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', system-ui,
    sans-serif;
  /* 阅读区可以选中、复制（只是不能编辑） */
  user-select: text;
  -webkit-user-select: text;
}

.md-body {
  /* 内容里的表格 / 代码块靠这个限制宽度，超出时自己滚 */
  min-width: 0;
  overflow-wrap: break-word;
}

/* ---------------------------------------------------------------- 查找条 */

.findbar {
  position: absolute;
  top: 10px;
  right: 18px;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  background: var(--surface-2);
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  box-shadow: 0 6px 20px var(--shadow);
}

.find-input {
  width: 180px;
  height: 26px;
  padding: 0 8px;
  background: var(--btn);
  color: var(--fg);
  border: 1px solid var(--line-strong);
  border-radius: 5px;
  font: inherit;
  font-size: 12.5px;
  outline: none;
}
.find-input:focus {
  border-color: var(--accent-solid);
}
.find-input::placeholder {
  color: var(--mute);
}

.find-count {
  min-width: 54px;
  text-align: center;
  font-size: 11.5px;
  color: var(--dim);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.find-btn {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: transparent;
  color: var(--dim);
  border: 0;
  border-radius: 5px;
  cursor: pointer;
}
.find-btn:hover:not(:disabled) {
  background: var(--btn-hover);
  color: var(--fg);
}
.find-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.find-btn :deep(svg) {
  width: 15px;
  height: 15px;
}

.md-foot {
  margin-top: 4em;
  padding-top: 1em;
  border-top: 1px solid var(--line);
  font-size: 0.78em;
  color: var(--mute);
  user-select: none;
}

/* ---------------------------------------------------------------- 排版 */

.md-body :deep(h1),
.md-body :deep(h2),
.md-body :deep(h3),
.md-body :deep(h4),
.md-body :deep(h5),
.md-body :deep(h6) {
  margin: 1.6em 0 0.6em;
  line-height: 1.35;
  font-weight: 650;
  color: var(--fg);
  /* 跳转目标落到标题上时别被顶边切掉 */
  scroll-margin-top: 16px;
}
.md-body :deep(h1) {
  font-size: 1.9em;
  margin-top: 0.6em;
}
.md-body :deep(h2) {
  font-size: 1.5em;
  padding-bottom: 0.24em;
  border-bottom: 1px solid var(--line);
}
.md-body :deep(h3) {
  font-size: 1.25em;
}
.md-body :deep(h4) {
  font-size: 1.08em;
}
.md-body :deep(h5),
.md-body :deep(h6) {
  font-size: 1em;
  color: var(--fg-2);
}

.md-body :deep(p) {
  margin: 0.85em 0;
}
.md-body :deep(strong) {
  font-weight: 650;
  color: var(--fg);
}
.md-body :deep(em) {
  font-style: italic;
}
.md-body :deep(del),
.md-body :deep(s) {
  color: var(--dim);
}

.md-body :deep(a) {
  color: var(--accent);
  text-decoration: none;
  border-bottom: 1px solid transparent;
  cursor: pointer;
}
.md-body :deep(a:hover) {
  border-bottom-color: var(--accent);
}
.md-body :deep(a.md-link-dead) {
  color: var(--dim);
  cursor: help;
  text-decoration: line-through dotted;
}

.md-body :deep(ul),
.md-body :deep(ol) {
  margin: 0.7em 0;
  padding-left: 1.6em;
}
.md-body :deep(li) {
  margin: 0.28em 0;
}
.md-body :deep(li > ul),
.md-body :deep(li > ol) {
  margin: 0.24em 0;
}

/* 任务列表：check box 被换成 span（见 markdownDocument.ts），纯 CSS 画勾 */
.md-body :deep(li.task-list-item) {
  list-style: none;
  margin-left: -1.35em;
}
.md-body :deep(.md-task) {
  display: inline-block;
  width: 0.95em;
  height: 0.95em;
  margin-right: 0.45em;
  vertical-align: -0.08em;
  border: 1.5px solid var(--line-strong);
  border-radius: 0.22em;
  background: var(--surface-2);
  position: relative;
}
.md-body :deep(.md-task.on) {
  border-color: var(--accent-solid);
  background: var(--accent-solid);
}
.md-body :deep(.md-task.on::after) {
  content: '';
  position: absolute;
  left: 0.22em;
  top: 0.02em;
  width: 0.26em;
  height: 0.5em;
  border: solid var(--on-accent);
  border-width: 0 0.14em 0.14em 0;
  transform: rotate(42deg);
}

.md-body :deep(blockquote) {
  margin: 1em 0;
  padding: 0.2em 0 0.2em 1em;
  border-left: 3px solid var(--line-strong);
  color: var(--dim);
  background: transparent;
}

.md-body :deep(code) {
  font-family: 'Cascadia Mono', 'Consolas', 'JetBrains Mono', monospace;
  font-size: 0.9em;
  background: var(--btn);
  border-radius: 4px;
  padding: 0.12em 0.34em;
}
.md-body :deep(pre) {
  margin: 1em 0;
  padding: 0.9em 1em;
  /* 日间模式下用户反馈"再灰一点"：变量在 base.css 里按主题取值 */
  background: var(--md-code-bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  /* 代码块自己横向滚：不让长行把整篇撑开 */
  overflow-x: auto;
  line-height: 1.6;
}
.md-body :deep(pre code) {
  background: transparent;
  padding: 0;
  font-size: 0.88em;
  white-space: pre;
}

/*
 * token 颜色**全部映射主题变量**，不用官方主题 —— 那些是死色值，
 * 夜间模式下白底黑字的规则会把浅色变量搞乱，日间/夜间得各配一份。
 * 现在这套只调了对比度、没调色相，两套主题自动都对。
 */
.md-body :deep(.hljs-comment),
.md-body :deep(.hljs-quote) {
  color: var(--mute);
  font-style: italic;
}
.md-body :deep(.hljs-keyword),
.md-body :deep(.hljs-selector-tag),
.md-body :deep(.hljs-literal),
.md-body :deep(.hljs-doctag) {
  color: var(--accent);
}
.md-body :deep(.hljs-string),
.md-body :deep(.hljs-regexp),
.md-body :deep(.hljs-addition) {
  color: var(--ok);
}
.md-body :deep(.hljs-number),
.md-body :deep(.hljs-symbol),
.md-body :deep(.hljs-bullet),
.md-body :deep(.hljs-attr),
.md-body :deep(.hljs-attribute),
.md-body :deep(.hljs-variable),
.md-body :deep(.hljs-template-variable) {
  color: var(--warn);
}
.md-body :deep(.hljs-title),
.md-body :deep(.hljs-name),
.md-body :deep(.hljs-selector-id),
.md-body :deep(.hljs-selector-class) {
  color: var(--fg);
  font-weight: 600;
}
.md-body :deep(.hljs-type),
.md-body :deep(.hljs-built_in),
.md-body :deep(.hljs-class) {
  color: var(--fg-2);
}
.md-body :deep(.hljs-meta) {
  color: var(--dim);
}
.md-body :deep(.hljs-deletion) {
  color: var(--err);
}
.md-body :deep(.hljs-emphasis) {
  font-style: italic;
}
.md-body :deep(.hljs-strong) {
  font-weight: 650;
}

/*
 * 公式：行内公式跟正文基线走；`$$` 块级公式居中、上下留呼吸空间。
 * KaTeX 自己的字体大小跟随容器（em），所以缩放字号公式一起变大。
 */
.md-body :deep(.md-math) {
  white-space: normal;
}
.md-body :deep(.md-math[data-md-display]) {
  display: block;
  margin: 1.2em 0;
  text-align: center;
  overflow-x: auto; /* 超宽公式横向滚，不撑破版心（和代码块同一策略） */
  overflow-y: hidden;
  padding-bottom: 2px; /* 给下标留一点，别被 overflow 裁掉 */
}
/* KaTeX 挂了/没加载出来时显示原始 TeX —— 等宽 + 弱化，一眼知道"这是没渲染的源码" */
.md-body :deep(.md-math-raw) {
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 0.88em;
  color: var(--mute);
}

/* 表格：外面那层 wrap 是渲染时加的（table 自己滚动会破坏列宽） */
.md-body :deep(.md-table-wrap) {
  margin: 1em 0;
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 8px;
}
.md-body :deep(table) {
  border-collapse: collapse;
  width: 100%;
  font-size: 0.94em;
}
.md-body :deep(th),
.md-body :deep(td) {
  padding: 0.5em 0.8em;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
}
.md-body :deep(thead th) {
  background: var(--surface);
  font-weight: 600;
  white-space: nowrap;
}
.md-body :deep(tbody tr:last-child td) {
  border-bottom: 0;
}

.md-body :deep(hr) {
  margin: 2em 0;
  border: 0;
  border-top: 1px solid var(--line);
}

.md-body :deep(img) {
  max-width: 100%;
  height: auto;
  display: block;
  margin: 1em auto;
  border-radius: 6px;
}

/* 图片占位：说清"为什么没显示"，而不是留一个裂图图标 */
.md-body :deep(.md-img-ph) {
  display: block;
  margin: 1em 0;
  padding: 0.9em 1em;
  border: 1px dashed var(--line-strong);
  border-radius: 8px;
  background: var(--surface);
  color: var(--mute);
  font-size: 0.86em;
  text-align: center;
}
/* 浏览器版：占位即按钮（点它授权文件夹）。实线 + 强调色 = "这是能点的" */
.md-body :deep(.md-img-ph.pickable) {
  border-style: solid;
  border-color: var(--accent-solid);
  color: var(--accent);
  cursor: pointer;
}
.md-body :deep(.md-img-ph.pickable:hover) {
  background: var(--accent-wash);
}
</style>

<!--
  ⚠️ 这个块**不能加 scoped**：`::highlight(name)` 是伪元素，Vue 的 scoped 会
  给它拼上 `[data-v-xxx]` 属性选择器，浏览器直接当无效规则丢掉 ——
  表现是"查找有计数、能跳转，但一个字都不高亮"，而且控制台一句提示都没有。
-->
<style>
/* 全部匹配：浅黄；当前这一个：橙一点，方便在满屏黄底里找到"现在跳到哪了" */
::highlight(md-find) {
  background-color: rgba(255, 205, 60, 0.38);
}
::highlight(md-find-active) {
  background-color: rgba(255, 150, 20, 0.78);
}
</style>
