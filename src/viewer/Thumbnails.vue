<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import type { PdfDocument } from './pdfDocument'
import type { PageSize } from './types'

const props = defineProps<{
  doc: PdfDocument
  /** 各页尺寸（基准单位）—— 没有就说明版面还没算出来 */
  sizes: PageSize[] | null
  currentPage: number
  /** 缩略图宽度（CSS px） */
  width?: number
}>()

const emit = defineEmits<{ go: [pageNumber: number] }>()

const THUMB_W = 96

/**
 * 缩略图的渲染策略。
 *
 * ⚠️ 600 页的书**不能**一上来全渲染，两个原因都不容商量：
 *   · **时间** —— 每页都要解析一次页面、跑一遍 opList，几百页就是几秒卡死；
 *   · **内存** —— 600 张位图哪怕只有 100×140，也要 30MB 起步。
 *
 * 所以只渲染**滚动到附近**的（IntersectionObserver + rootMargin 预取），
 * 并用 LRU 保住最近看得见的那批；更远的把位图尺寸**归零**但保留占位框 ——
 * 这样内存恒定，列表高度也不会跳来跳去。
 */
const MAX_CACHED = 120

const canvases = new Map<number, HTMLCanvasElement>()
const done = new Set<number>()
/** LRU 顺序，末尾是最近用过的 */
const lru: number[] = []
const queue: number[] = []
const visible = new Set<number>()
let busy = false
let io: IntersectionObserver | null = null
const scrollRoot = ref<HTMLElement | null>(null)

function touch(pn: number): void {
  const i = lru.indexOf(pn)
  if (i >= 0) lru.splice(i, 1)
  lru.push(pn)
}

/** 超出上限就丢掉最久没看的那张位图 */
function evict(): void {
  while (lru.length > MAX_CACHED) {
    const old = lru.shift()
    if (old === undefined) break
    done.delete(old)
    const c = canvases.get(old)
    if (c) {
      c.width = 0
      c.height = 0
    }
  }
}

async function renderThumb(pn: number): Promise<void> {
  const canvas = canvases.get(pn)
  const size = props.sizes?.[pn - 1]
  if (!canvas || !size || !size.width) return

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = props.width ?? THUMB_W
  const h = Math.round((size.height / size.width) * w)
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`
  canvas.width = Math.max(1, Math.round(w * dpr))
  canvas.height = Math.max(1, Math.round(h * dpr))

  const page = await props.doc.getPage(pn)
  const vp = page.getViewport({ scale: (w * dpr) / size.width })
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  // ⚠️ pdf.js 6 里 `canvas` 是必填的；缩略图也是给人看的，用 display intent
  await page.render({ canvas, canvasContext: ctx, viewport: vp, intent: 'display' }).promise

  done.add(pn)
  touch(pn)
  evict()
}

/**
 * 串行消费队列。
 *
 * 为什么串行而不是并发几张：pdf.js 的 render 要占 worker，
 * 并发不但不会更快，还会把**主页面**的渲染挤到后面 ——
 * 用户在缩略图里翻的时候正文反而变白，本末倒置。
 */
async function pump(): Promise<void> {
  if (busy) return
  busy = true
  try {
    while (queue.length) {
      const pn = queue.shift()!
      if (!visible.has(pn)) continue // 已经划走了，别画
      if (done.has(pn)) continue
      await renderThumb(pn)
    }
  } catch {
    /* 单张失败不该连累后面的 */
  } finally {
    busy = false
  }
}

function setupObserver(): void {
  io?.disconnect()
  const root = scrollRoot.value
  if (!root || typeof IntersectionObserver === 'undefined') return
  io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const pn = Number((e.target as HTMLElement).dataset.page)
        if (!pn) continue
        if (e.isIntersecting) {
          visible.add(pn)
          if (!done.has(pn)) {
            queue.push(pn)
            void pump()
          }
        } else {
          visible.delete(pn)
        }
      }
    },
    // 上下各预取一段，滚动起来更跟手
    { root, rootMargin: '300px 0px' },
  )
  for (const el of root.querySelectorAll('canvas[data-page]')) io.observe(el)
}

function bindItem(el: Element | ComponentPublicInstance | null): void {
  const html = el as HTMLCanvasElement | null
  if (!html) return
  const pn = Number(html.dataset.page)
  if (pn) canvases.set(pn, html)
}

/** 换文档：整批作废 */
function reset(): void {
  queue.length = 0
  visible.clear()
  done.clear()
  lru.length = 0
  canvases.clear()
}

watch(
  () => props.sizes,
  async () => {
    reset()
    await nextTick()
    setupObserver()
  },
  { immediate: true },
)

/*
 * 诊断钩子。
 * 懒渲染到底生效没有，**光看截图看不出来**（缩略图画出来了 = 功能正常，
 * 但可能是一次性全画完的）。所以把内部计数暴露出来，测试直接读。
 */
;(globalThis as unknown as Record<string, unknown>).__eplThumbs = () => ({
  visible: visible.size,
  rendered: done.size,
  queued: queue.length,
  cached: lru.length,
})

onBeforeUnmount(() => {
  io?.disconnect()
  io = null
})
</script>

<template>
  <div ref="scrollRoot" class="thumb-panel">
    <div v-if="!sizes" class="empty dim">正在准备缩略图…</div>
    <div v-else class="grid">
      <button
        v-for="(s, i) in sizes"
        :key="i"
        class="thumb"
        :class="{ current: currentPage === i + 1 }"
        :style="{ height: Math.round((s.height / s.width) * (width ?? 96)) + 'px' }"
        :title="`跳到第 ${i + 1} 页`"
        @click="emit('go', i + 1)"
      >
        <canvas :ref="bindItem" :data-page="i + 1" class="cv" />
        <span class="pn">{{ i + 1 }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.thumb-panel {
  padding: 8px 6px;
  /* ⚠️ 自己滚 —— 缩略图的 IntersectionObserver 拿这个元素当 root，
     它必须真的是滚动容器，否则懒渲染不生效 */
  overflow: auto;
  height: 100%;
}

.grid {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.thumb {
  position: relative;
  padding: 0;
  border: 1px solid #333a45;
  border-radius: 3px;
  background: #2a2f38;
  cursor: pointer;
  overflow: hidden;
  /* ⚠️ 高度由 inline style 按宽高比预设好 —— canvas 还没渲染时也能占位，
     否则缩略图一张张画出来会把整个列表顶得来回跳 */
  display: block;
  width: 96px;
}
.thumb:hover {
  border-color: #4a86c8;
}
.thumb.current {
  border-color: #4aa3ff;
  box-shadow: 0 0 0 1px #4aa3ff;
}

.cv {
  display: block;
}

.pn {
  position: absolute;
  left: 0;
  bottom: 0;
  padding: 0 4px;
  background: rgba(10, 12, 16, 0.72);
  color: #b9c1cd;
  font-size: 10.5px;
  line-height: 15px;
  font-variant-numeric: tabular-nums;
}
.thumb.current .pn {
  color: #cfe4ff;
}

.empty {
  padding: 18px 12px;
  font-size: 12.5px;
}
.dim {
  color: #7d8593;
}
</style>
