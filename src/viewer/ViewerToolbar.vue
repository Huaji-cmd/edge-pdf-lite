<script setup lang="ts">
import { computed } from 'vue'
import type { ViewMode } from './types'
import type { RendererStats } from './pageRenderer'
import type { ToolKind, ToolColors, PointerMode, Rgb } from '@/annot/types'
import { swatchesFor, POINTER_MODES, POINTER_MODE_LABEL, isColorTool } from '@/annot/types'
import type { SelectedInfo } from '@/annot/types'
import { rgbCss } from '@/annot/draw'

const props = defineProps<{
  fileName: string
  numPages: number
  page: number
  scale: number
  mode: ViewMode
  spreadOffset: 0 | 1
  stats: RendererStats | null
  tool: ToolKind
  annotCount: number
  /** 侧边栏（目录 / 缩略图）是否展开 */
  sideOpen: boolean
  /**
   * 有没有还没写回文件的批注。
   *
   * ⚠️ 这个标记**不能省**。浏览器在 beforeunload 时只会显示它自己那句
   * "你确定要离开吗"，不会显示我们给的任何文字 —— 所以"还有东西没存"
   * 这件事只能靠页面内的可见标记提前传达，等拦截弹窗出来已经晚了。
   */
  unsaved: boolean
  /** 指针模式：选择 / 滚动 / 拖动 */
  pointerMode: PointerMode
  /** 各工具的当前配色 */
  colors: ToolColors
  /** 选中的批注；null = 没有选中 */
  selected: SelectedInfo | null
  canUndo: boolean
  canRedo: boolean
}>()

const emit = defineEmits<{
  open: []
  /** 展开 / 收起侧边栏（目录 / 缩略图） */
  'toggle-side': []
  'go-to': [pageNumber: number]
  /** 按行翻页（双页模式一次翻一屏） */
  'step-page': [dir: -1 | 1]
  'set-scale': [scale: number]
  'fit-width': []
  'fit-page': []
  'set-mode': [mode: ViewMode]
  'set-spread-offset': [offset: 0 | 1]
  'set-tool': [tool: ToolKind]
  'set-pointer-mode': [mode: PointerMode]
  /** 点色板。有选中项时改选中项，否则改当前工具的默认色 */
  'pick-color': [color: Rgb]
  undo: []
  redo: []
  'delete-selected': []
  'export-annot': []
}>()

/** 点同一个工具就退回阅读模式 —— 省掉"忘了关工具导致误画" */
function pickTool(t: ToolKind): void {
  emit('set-tool', props.tool === t ? 'none' : t)
}

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8]

function stepZoom(dir: 1 | -1): void {
  const cur = props.scale
  let next = cur
  if (dir > 0) next = ZOOM_STEPS.find((s) => s > cur + 1e-4) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!
  else next = [...ZOOM_STEPS].reverse().find((s) => s < cur - 1e-4) ?? ZOOM_STEPS[0]!
  emit('set-scale', next)
}

function onPageInput(e: Event): void {
  const v = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(v)) emit('go-to', Math.min(Math.max(1, Math.round(v)), props.numPages || 1))
}

// ---------------------------------------------------------------- 色板

const KIND_LABEL: Record<SelectedInfo['kind'], string> = {
  highlight: '高亮',
  area: '区域高亮',
  underline: '下划线',
  strikeout: '删除线',
  ink: '手写',
  rect: '方框',
  freetext: '文本框',
}

const POINTER_MODE_TIP: Record<PointerMode, string> = {
  select: '选择：点批注可选中并拖动、改大小（高亮类只能平移）',
  scroll: '滚动：纯阅读，批注点不动，避免翻页时误拖',
  pan: '拖动：按住左键抓手平移，放大后最好用（会自动退出批注工具）',
}

/** 当前"色板正在表示"的颜色：有选中项就显示选中项的，否则显示当前工具的默认色 */
const currentColor = computed<Rgb | null>(() => {
  if (props.selected) return props.selected.color
  return isColorTool(props.tool) ? props.colors[props.tool] : null
})

/** 有选中项时改的是"这一条"，没有时改的是"下一次画出来的" */
const colorHint = computed(() =>
  props.selected ? `改「${KIND_LABEL[props.selected.kind]}」的颜色` : '设置新批注的颜色',
)

/**
 * 色板内容取决于"这次要给谁上色"：改选中的高亮，就按高亮的规矩来。
 * 高亮挡掉黑/白 —— 黑会把整行乘黑（字消失），白等于没画。
 */
const swatches = computed<readonly Rgb[]>(() => {
  const kind = props.selected ? props.selected.kind : isColorTool(props.tool) ? props.tool : null
  return kind ? swatchesFor(kind) : []
})

function isOn(c: Rgb): boolean {
  const cur = currentColor.value
  return !!cur && Math.abs(cur[0] - c[0]) < 1e-3 && Math.abs(cur[1] - c[1]) < 1e-3 && Math.abs(cur[2] - c[2]) < 1e-3
}
</script>

<template>
  <div class="toolbar">
    <button class="btn primary" @click="emit('open')">打开 PDF</button>
    <button
      class="btn"
      :class="{ on: sideOpen }"
      title="目录 / 缩略图（PDF 没书签时这边是空的，用缩略图翻页）"
      @click="emit('toggle-side')"
    >
      目录
    </button>

    <span class="sep" />

    <div class="pager" v-if="numPages">
      <!-- ⚠️ 走 `step-page`（按行翻），不是 `go-to`(page±1)。
           双页模式下 page+1 停在同一行，会变成"点两次才翻一屏" -->
      <button class="btn icon" title="上一页 (PageUp)" @click="emit('step-page', -1)">‹</button>
      <input
        class="page-input"
        type="number"
        :value="page"
        min="1"
        :max="numPages"
        @change="onPageInput"
      />
      <span class="dim">/ {{ numPages }}</span>
      <button class="btn icon" title="下一页 (PageDown)" @click="emit('step-page', 1)">
        ›
      </button>
    </div>

    <span class="sep" />

    <button class="btn icon" title="缩小 (Ctrl+-)" @click="stepZoom(-1)">−</button>
    <span class="zoom-label">{{ Math.round(scale * 100) }}%</span>
    <button class="btn icon" title="放大 (Ctrl++)" @click="stepZoom(1)">+</button>
    <button class="btn" title="适应宽度" @click="emit('fit-width')">适宽</button>
    <button class="btn" title="适应页面" @click="emit('fit-page')">整页</button>
    <button class="btn" @click="emit('set-scale', 1)">100%</button>

    <span class="sep" />

    <div class="seg">
      <button
        :class="['btn', 'seg-btn', mode === 'single' ? 'on' : '']"
        @click="emit('set-mode', 'single')"
      >
        单页
      </button>
      <button
        :class="['btn', 'seg-btn', mode === 'dual' ? 'on' : '']"
        @click="emit('set-mode', 'dual')"
      >
        双页
      </button>
    </div>
    <button
      v-if="mode === 'dual'"
      class="btn"
      :title="spreadOffset === 1 ? '当前：封面单独占一页' : '当前：直接两两配对'"
      @click="emit('set-spread-offset', spreadOffset === 1 ? 0 : 1)"
    >
      {{ spreadOffset === 1 ? '封面对齐' : '直接配对' }}
    </button>

    <span class="sep" />

    <!--
      指针模式。这是"左键在页面上做什么"的总开关，与下面的批注工具是两套状态：
        · 选择 —— 点批注可选中、拖动、改大小
        · 滚动 —— 纯阅读，批注点不动（避免翻页时把批注拖走）
        · 拖动 —— 抓手平移，放大之后最好用
      互斥由 App.vue 保证：选工具自动回「选择」，切「拖动」自动清工具。
    -->
    <div class="seg">
      <button
        v-for="m in POINTER_MODES"
        :key="m"
        :class="['btn', 'seg-btn', pointerMode === m ? 'on' : '']"
        :title="POINTER_MODE_TIP[m]"
        @click="emit('set-pointer-mode', m)"
      >
        {{ POINTER_MODE_LABEL[m] }}
      </button>
    </div>

    <span class="sep" />

    <!-- 批注工具。标记类（先选文字）和绘制类分两组，视觉上区分开 -->
    <div class="seg">
      <button
        :class="['btn', 'seg-btn', tool === 'highlight' ? 'on' : '']"
        title="高亮：先在页面上选中文字，再松开鼠标"
        @click="pickTool('highlight')"
      >
        高亮
      </button>
      <button
        :class="['btn', 'seg-btn', tool === 'underline' ? 'on' : '']"
        title="下划线：先选中文字"
        @click="pickTool('underline')"
      >
        下划线
      </button>
      <button
        :class="['btn', 'seg-btn', tool === 'strikeout' ? 'on' : '']"
        title="删除线：先选中文字"
        @click="pickTool('strikeout')"
      >
        删除线
      </button>
    </div>
    <div class="seg">
      <button
        :class="['btn', 'seg-btn', tool === 'ink' ? 'on' : '']"
        title="自由手写（扫描件上没有文字层，这个最实用）"
        @click="pickTool('ink')"
      >
        手写
      </button>
      <!--
        区域高亮：**不依赖文本层**。
        扫描件（《现代操作系统教程》就是整页图片）上文字类高亮一条都画不出来，
        而这个工具只认"拖出来的这块区域"，正好补上那个缺口。
      -->
      <button
        :class="['btn', 'seg-btn', tool === 'area' ? 'on' : '']"
        title="区域高亮：拖一个框直接盖住一块，不需要文字层（扫描件用这个）"
        @click="pickTool('area')"
      >
        区域高亮
      </button>
      <button
        :class="['btn', 'seg-btn', tool === 'rect' ? 'on' : '']"
        title="矩形框：拖出一个框"
        @click="pickTool('rect')"
      >
        方框
      </button>
      <button
        :class="['btn', 'seg-btn', tool === 'freetext' ? 'on' : '']"
        title="浮动文本框（画完可以拖动、拉大；双击可改文字）"
        @click="pickTool('freetext')"
      >
        文字
      </button>
      <button
        :class="['btn', 'seg-btn', tool === 'eraser' ? 'on' : '']"
        title="擦除：点中哪条就删哪条，可用 Ctrl+Z 撤销"
        @click="pickTool('eraser')"
      >
        擦除
      </button>
    </div>

    <!-- 色板：工具需要颜色，或者有选中项要改色时才出现 -->
    <div v-if="currentColor" class="swatches" :title="colorHint">
      <button
        v-for="c in swatches"
        :key="c.join()"
        class="sw"
        :class="{ on: isOn(c) }"
        :style="{ background: rgbCss(c) }"
        :title="colorHint"
        @click="emit('pick-color', c)"
      />
    </div>

    <button class="btn" :disabled="!canUndo" title="撤销 (Ctrl+Z)" @click="emit('undo')">撤销</button>
    <button
      class="btn"
      :disabled="!canRedo"
      title="重做：把刚撤销的收回来 (Ctrl+Shift+Z / Ctrl+Y)"
      @click="emit('redo')"
    >
      重做
    </button>
    <button
      v-if="selected"
      class="btn danger"
      title="删除选中的批注 (Delete)"
      @click="emit('delete-selected')"
    >
      删除所选
    </button>
    <span v-if="annotCount" class="badge">{{ annotCount }}</span>
    <span
      v-if="unsaved"
      class="badge unsaved"
      title="这些批注还没写回文件。关掉页面 / 刷新 / 打开别的 PDF 之前记得先保存 —— 否则会丢"
    >
      ● 未保存
    </span>
    <button
      class="btn save"
      :class="{ attention: unsaved }"
      title="把批注写回 PDF，另存为一份新文件（不会改动原文件）"
      @click="emit('export-annot')"
    >
      保存批注
    </button>

    <span class="grow" />

    <span class="status dim" v-if="stats">
      <template v-if="stats.running > 0 || stats.queued > 0">
        渲染中 {{ stats.running }} · 排队 {{ stats.queued }}
      </template>
      <template v-else-if="stats.lastRenderMs > 0">
        单页 {{ stats.lastRenderMs.toFixed(0) }} ms
      </template>
      <template v-else>就绪</template>
    </span>
    <span class="file dim" :title="fileName">{{ fileName }}</span>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: #1b1e24;
  border-bottom: 1px solid #2b313a;
  flex-wrap: wrap;
  font-size: 13px;
  flex: 0 0 auto;
}

.btn {
  background: #262b33;
  color: #dfe4ec;
  border: 1px solid #333a45;
  border-radius: 6px;
  padding: 5px 10px;
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.btn:hover:not(:disabled) {
  background: #2f353f;
}
.btn:active:not(:disabled) {
  background: #262b33;
}
.btn:disabled {
  opacity: 0.42;
  cursor: default;
}
.btn.primary {
  background: #2b6cb0;
  border-color: #2b6cb0;
}
/* 侧边栏开着时，"目录"按钮要亮着 —— 否则用户不知道去哪儿关 */
.btn.on {
  background: #2b3d57;
  border-color: #4aa3ff;
  color: #cfe4ff;
}
.btn.primary:hover {
  background: #3478c0;
}
.btn.icon {
  padding: 5px 9px;
  min-width: 30px;
}
.btn.save {
  background: #2f5d43;
  border-color: #2f5d43;
}
.btn.save:hover {
  background: #366b4d;
}
/* 有未保存的批注时让保存按钮更显眼一点 —— 它是此时唯一能留住批注的出口 */
.btn.save.attention {
  background: #3d7a55;
  border-color: #4d9a6c;
  box-shadow: 0 0 0 1px rgba(120, 220, 160, 0.35);
}
.btn.danger {
  background: #6b2b30;
  border-color: #6b2b30;
}
.btn.danger:hover {
  background: #7d343a;
}

.seg {
  display: flex;
}
.seg-btn {
  border-radius: 0;
}
.seg-btn:first-child {
  border-radius: 6px 0 0 6px;
}
.seg-btn:last-child {
  border-radius: 0 6px 6px 0;
  border-left: none;
}
.seg-btn.on {
  background: #2b6cb0;
  border-color: #2b6cb0;
}

/* ---- 色板 ---- */

.swatches {
  display: flex;
  gap: 3px;
  padding: 3px 5px;
  background: #14161a;
  border: 1px solid #333a45;
  border-radius: 7px;
}
.sw {
  width: 17px;
  height: 17px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 4px;
  cursor: pointer;
  box-sizing: border-box;
}
.sw:hover {
  border-color: #fff;
}
.sw.on {
  /* 选中态用外描边，不占用色块本身 —— 白色/浅色块上也看得见 */
  outline: 2px solid #4aa3ff;
  outline-offset: 1px;
  border-color: #fff;
}

.pager {
  display: flex;
  align-items: center;
  gap: 4px;
}
.page-input {
  width: 56px;
  text-align: center;
  background: #14161a;
  color: #dfe4ec;
  border: 1px solid #333a45;
  border-radius: 6px;
  padding: 4px 6px;
  font: inherit;
}

.zoom-label {
  min-width: 46px;
  text-align: center;
  color: #8b93a1;
  font-variant-numeric: tabular-nums;
}

.sep {
  width: 1px;
  height: 18px;
  background: #2b313a;
  margin: 0 2px;
}
.grow {
  flex: 1;
}
.badge {
  background: #2b6cb0;
  color: #fff;
  border-radius: 10px;
  padding: 1px 8px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
/* 未保存标记：琥珀色，跟"计数"的蓝区分开 —— 这两件事性质不同，
   一个是"有多少"，一个是"还没落盘" */
.badge.unsaved {
  background: #8a5a12;
  color: #ffd88a;
}
.dim {
  color: #8b93a1;
}
.status {
  font-variant-numeric: tabular-nums;
}
.file {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
