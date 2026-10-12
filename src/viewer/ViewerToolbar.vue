<script setup lang="ts">
/**
 * 功能区（图标工具栏）。
 *
 * 布局（用户定的）：左半是**阅读相关**，右边缘从右到左是
 * `保存 · 未保存标记 · 撤销 · 重做 · 批注`。
 *
 * ⚠️ 批注工具组默认**收起**：阅读是主要场景，8 个批注工具一直占着地方没意义。
 *    点「批注」向左展开，展开时把左边的「视图组」「模式组」收起来腾地方 ——
 *    实测功能区总宽需要约 1290px，而侧边栏占掉 260px 后只剩约 1150px，
 *    不腾地方一行放不下（放不下就会压扁「未保存」标记、冒横向滚动条）。
 */
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import type { ViewMode } from './types'
import type { ToolKind, ToolColors, PointerMode, Rgb } from '@/annot/types'
import { swatchesFor, POINTER_MODES, isColorTool } from '@/annot/types'
import type { SelectedInfo } from '@/annot/types'
import { rgbCss } from '@/annot/draw'

const props = defineProps<{
  numPages: number
  page: number
  scale: number
  mode: ViewMode
  spreadOffset: 0 | 1
  tool: ToolKind
  annotCount: number
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

// ---------------------------------------------------------------- 批注面板开合

const annotOpen = ref(false)

/** 点同一个工具就退回阅读模式 —— 省掉"忘了关工具导致误画" */
function pickTool(t: ToolKind): void {
  emit('set-tool', props.tool === t ? 'none' : t)
}

// ---------------------------------------------------------------- 缩放

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

// ---------------------------------------------------------------- 颜色

const KIND_LABEL: Record<SelectedInfo['kind'], string> = {
  highlight: '高亮',
  area: '区域高亮',
  underline: '下划线',
  strikeout: '删除线',
  ink: '手写',
  rect: '方框',
  freetext: '文本框',
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
  return (
    !!cur &&
    Math.abs(cur[0] - c[0]) < 1e-3 &&
    Math.abs(cur[1] - c[1]) < 1e-3 &&
    Math.abs(cur[2] - c[2]) < 1e-3
  )
}

/** 批注按钮上那个小圆点：一眼看出"现在会画什么颜色" */
const dotStyle = computed(() => ({
  background: currentColor.value ? rgbCss(currentColor.value) : 'transparent',
}))

// ---------------------------------------------------------------- 颜色菜单

const colorMenuOpen = ref(false)
const annotBtnRef = ref<HTMLElement | null>(null)
const menuPos = ref<{ top: number; left: number }>({ top: 0, left: 0 })

/**
 * 菜单位置用 fixed 算 —— 不能让它呆在功能区里做绝对定位：
 * 功能区为了容纳图标开了横向溢出，绝对定位的子元素会被裁掉。
 */
function openColorMenu(): void {
  if (!annotOpen.value) annotOpen.value = true
  if (colorMenuOpen.value) {
    colorMenuOpen.value = false
    return
  }
  const el = annotBtnRef.value
  if (el) {
    const r = el.getBoundingClientRect()
    menuPos.value = { top: r.bottom + 6, left: Math.max(8, r.right - 168) }
  }
  colorMenuOpen.value = true
}

function pickColor(c: Rgb): void {
  emit('pick-color', c)
  colorMenuOpen.value = false
}

function onDocClick(e: MouseEvent): void {
  if (!colorMenuOpen.value) return
  const t = e.target as Node
  if (annotBtnRef.value?.contains(t)) return
  const menu = document.getElementById('epl-color-menu')
  if (menu?.contains(t)) return
  colorMenuOpen.value = false
}

onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))

// ---------------------------------------------------------------- 图标名

const POINTER_ICON = { select: 'cursor', scroll: 'hand', pan: 'grab' } as const
const POINTER_MODE_TIP: Record<PointerMode, string> = {
  select: '选择：点批注可选中并拖动、改大小（高亮类只能平移）',
  scroll: '滚动：纯阅读，批注点不动，避免翻页时误拖',
  pan: '拖动：按住左键抓手平移，放大后最好用（会自动退出批注工具）',
}
</script>

<template>
  <div class="ribbon" :class="{ 'annot-open': annotOpen }">
    <!-- ============================================ 左半：阅读 -->
    <button class="rb" data-tid="open" title="打开 PDF" @click="emit('open')">
      <Icon name="folder" />
    </button>
    <span class="sep" />

    <template v-if="numPages">
      <button class="rb" data-tid="prev" title="上一页 (PageUp)" @click="emit('step-page', -1)">
        <Icon name="prev" />
      </button>
      <span class="pager">
        <input
          class="page-input"
          data-tid="page-input"
          type="number"
          min="1"
          :max="numPages"
          :value="page"
          title="输入页码后回车跳转"
          @change="onPageInput"
          @keydown.enter="onPageInput"
        />
        <span class="total">/ {{ numPages }}</span>
      </span>
      <button class="rb" data-tid="next" title="下一页 (PageDown)" @click="emit('step-page', 1)">
        <Icon name="next" />
      </button>
      <span class="sep" />
    </template>

    <button class="rb" data-tid="zoom-out" title="缩小 (Ctrl+-)" @click="stepZoom(-1)">
      <Icon name="minus" />
    </button>
    <button class="rb" data-tid="zoom-in" title="放大 (Ctrl++)" @click="stepZoom(1)">
      <Icon name="plus" />
    </button>
    <button class="rb" data-tid="fit-width" title="适应宽度" @click="emit('fit-width')">
      <Icon name="fitw" />
    </button>
    <button class="rb" data-tid="fit-page" title="适应整页" @click="emit('fit-page')">
      <Icon name="fitp" />
    </button>
    <button
      class="rb pct"
      data-tid="zoom"
      title="当前缩放，点一下回到 100%"
      @click="emit('set-scale', 1)"
    >
      {{ Math.round(scale * 100) }}%
    </button>

    <!-- 展开批注时收起这两组，给批注工具腾地方 -->
    <span class="sep grp-optional" />
    <span class="grp grp-optional">
      <button
        class="rb"
        :class="{ on: mode === 'single' }"
        data-tid="mode-single"
        title="单页"
        @click="emit('set-mode', 'single')"
      >
        <Icon name="single" />
      </button>
      <button
        class="rb"
        :class="{ on: mode === 'dual' }"
        data-tid="mode-dual"
        title="双页并排"
        @click="emit('set-mode', 'dual')"
      >
        <Icon name="dual" />
      </button>
      <button
        class="rb"
        data-tid="spread-offset"
        :title="spreadOffset === 1 ? '当前：封面单独占一页' : '当前：直接两两配对'"
        @click="emit('set-spread-offset', spreadOffset === 1 ? 0 : 1)"
      >
        <Icon name="file" />
      </button>
    </span>

    <span class="sep grp-optional" />
    <span class="grp grp-optional">
      <button
        v-for="m in POINTER_MODES"
        :key="m"
        class="rb"
        :class="{ on: pointerMode === m }"
        :data-tid="`pm-${m}`"
        :title="POINTER_MODE_TIP[m]"
        @click="emit('set-pointer-mode', m)"
      >
        <Icon :name="POINTER_ICON[m]" />
      </button>
    </span>

    <!-- ============================================ 右边缘（从右到左：保存·未保存·撤销·重做·批注） -->
    <span class="spacer" />
    <span class="sep" />

    <!-- 批注工具组：默认收起，点「批注」向左展开 -->
    <span class="grp annot-group" :class="{ open: annotOpen }">
      <button
        class="rb"
        :class="{ on: tool === 'highlight' }"
        data-tid="tool-highlight"
        title="高亮：先在页面上选中文字，再松开鼠标"
        @click="pickTool('highlight')"
      >
        <Icon name="highlight" />
      </button>
      <button
        class="rb"
        :class="{ on: tool === 'underline' }"
        data-tid="tool-underline"
        title="下划线：先选中文字"
        @click="pickTool('underline')"
      >
        <Icon name="underline" />
      </button>
      <button
        class="rb"
        :class="{ on: tool === 'strikeout' }"
        data-tid="tool-strikeout"
        title="删除线：先选中文字"
        @click="pickTool('strikeout')"
      >
        <Icon name="strike" />
      </button>
      <button
        class="rb"
        :class="{ on: tool === 'ink' }"
        data-tid="tool-ink"
        title="自由手写（扫描件没有文字层，这个最实用）"
        @click="pickTool('ink')"
      >
        <Icon name="pen" />
      </button>
      <button
        class="rb"
        :class="{ on: tool === 'area' }"
        data-tid="tool-area"
        title="区域高亮：拖一个框直接盖住一块，不需要文字层（扫描件用这个）"
        @click="pickTool('area')"
      >
        <Icon name="area" />
      </button>
      <button
        class="rb"
        :class="{ on: tool === 'rect' }"
        data-tid="tool-rect"
        title="矩形框：拖出一个框"
        @click="pickTool('rect')"
      >
        <Icon name="rect" />
      </button>
      <button
        class="rb"
        :class="{ on: tool === 'freetext' }"
        data-tid="tool-freetext"
        title="浮动文本框（画完可以拖动、拉大；双击可改文字）"
        @click="pickTool('freetext')"
      >
        <Icon name="text" />
      </button>
      <button
        class="rb"
        :class="{ on: tool === 'eraser' }"
        data-tid="tool-eraser"
        title="擦除：点中哪条就删哪条，可用 Ctrl+Z 撤销"
        @click="pickTool('eraser')"
      >
        <Icon name="eraser" />
      </button>
      <button
        class="rb"
        data-tid="delete-selected"
        :disabled="!selected"
        title="删除选中的批注 (Delete)"
        @click="emit('delete-selected')"
      >
        <Icon name="trash" />
      </button>
    </span>

    <button
      ref="annotBtnRef"
      class="rb annot-btn"
      :class="{ on: annotOpen }"
      data-tid="annot-toggle"
      :title="annotOpen ? '收起批注工具' : '展开批注工具'"
      @click="annotOpen = !annotOpen"
    >
      <!--
        箭头指向**动作方向**（用户定的）：收起时 `<` 表示"点我从左边展开"，
        展开时 `>` 表示"点我收回去"。不要改成 ∨/∧ —— 那会丢掉方向暗示。
      -->
      <Icon :name="annotOpen ? 'chevron-right' : 'chevron-left'" class="caret" />
      <span class="annot-label">批注</span>
      <!-- 批注总数。0 条时不显示 —— 一个"0"占地方还容易误读成禁用 -->
      <span v-if="annotCount" class="badge" data-tid="annot-count" title="已有批注数">
        {{ annotCount }}
      </span>
      <span class="dot" :style="dotStyle" />
      <span
        class="color-caret"
        data-tid="color-caret"
        :title="colorHint"
        @click.stop="openColorMenu"
      >
        <Icon name="chevron-down" />
      </span>
    </button>

    <!--
      顺序：撤销在左、重做在右。
      这是"时间轴"方向的直觉 —— 左=往回、右=往前，也跟 Office / Edge 一致。
      ⚠️ 屏幕上的左右由这里的 DOM 顺序决定，改一个就得改另一个。
    -->
    <button class="rb" data-tid="undo" :disabled="!canUndo" title="撤销 (Ctrl+Z)" @click="emit('undo')">
      <Icon name="undo" />
    </button>
    <button
      class="rb"
      data-tid="redo"
      :disabled="!canRedo"
      title="重做：把刚撤销的收回来 (Ctrl+Shift+Z / Ctrl+Y)"
      @click="emit('redo')"
    >
      <Icon name="redo" />
    </button>

    <span
      v-if="unsaved"
      class="unsaved"
      data-tid="unsaved"
      title="这些批注还没写回文件。关掉页面 / 刷新 / 打开别的 PDF 之前记得先保存 —— 否则会丢"
    >
      ● 未保存
    </span>

    <button
      class="rb"
      data-tid="save"
      title="把批注写回 PDF，另存为一份新文件（不会改动原文件）"
      @click="emit('export-annot')"
    >
      <Icon name="save" />
    </button>

  </div>

  <!-- 颜色菜单：fixed 定位，避免被功能区的横向溢出裁掉 -->
  <div
    v-if="colorMenuOpen"
    id="epl-color-menu"
    class="color-menu"
    :style="{ top: `${menuPos.top}px`, left: `${menuPos.left}px` }"
  >
    <div class="menu-label">{{ colorHint }}</div>
    <button
      v-for="c in swatches"
      :key="c.join()"
      class="sw"
      :class="{ on: isOn(c) }"
      :style="{ background: rgbCss(c) }"
      :title="colorHint"
      @click="pickColor(c)"
    />
  </div>
</template>

<style scoped>
.ribbon {
  flex: 0 0 44px;
  height: 44px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 8px;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
  /* 放不下时兜底可滚；正常窗口下不该出现滚动条 */
  overflow-x: auto;
  overflow-y: hidden;
}

/* ⚠️ 所有子项不许被压扁 —— 否则「● 未保存」会被挤成竖排文字 */
.ribbon > * {
  flex-shrink: 0;
}

.grp {
  display: flex;
  align-items: center;
  gap: 2px;
}
.sep {
  width: 1px;
  height: 22px;
  background: var(--line);
  margin: 0 6px;
}
.spacer {
  flex: 1 1 auto;
  min-width: 0;
}

/* 展开批注时收起这两个可选组（腾出约 200px，理由见文件头） */
.ribbon.annot-open .grp-optional {
  display: none;
}

.rb {
  height: 40px;
  min-width: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 0 6px;
  background: transparent;
  color: var(--dim);
  border: 1px solid transparent;
  border-radius: 6px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.rb:hover {
  background: var(--btn-hover);
  color: var(--fg);
}
.rb.on {
  background: var(--sel-bg);
  color: var(--sel-fg);
}
.rb:disabled {
  opacity: 0.35;
  cursor: default;
}
.rb:disabled:hover {
  background: transparent;
}

.pct {
  min-width: 52px;
  font-variant-numeric: tabular-nums;
  color: var(--dim-2);
}

.pager {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  white-space: nowrap;
}
.page-input {
  width: 46px;
  height: 26px;
  background: var(--surface-2);
  color: var(--fg);
  border: 1px solid var(--line);
  border-radius: 4px;
  text-align: center;
  font: inherit;
  font-size: 12px;
}
.page-input:focus {
  outline: none;
  border-color: var(--accent);
}
.total {
  color: var(--dim-2);
  font-size: 11px;
}

.annot-group {
  display: none;
}
.annot-group.open {
  display: flex;
}

.annot-btn {
  min-width: 0;
  padding: 0 8px;
  font-size: 12.5px;
}
.annot-btn .caret {
  width: 13px;
  height: 13px;
}
.annot-btn .badge {
  min-width: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--accent-solid);
  color: var(--on-accent);
  font-size: 10.5px;
  line-height: 15px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.annot-btn .dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 1px solid var(--hairline);
}
.annot-btn .color-caret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 20px;
  border-radius: 3px;
}
.annot-btn .color-caret:hover {
  background: var(--hairline);
}
.annot-btn .color-caret :deep(.ic) {
  width: 11px;
  height: 11px;
}

.unsaved {
  display: inline-flex;
  align-items: center;
  color: var(--warn);
  font-size: 11px;
  padding: 0 6px;
  white-space: nowrap;
}

/* 颜色菜单 */
.color-menu {
  position: fixed;
  z-index: 200;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px;
  box-shadow: 0 8px 26px var(--shadow);
  display: grid;
  grid-template-columns: repeat(5, 22px);
  gap: 6px;
}
.menu-label {
  grid-column: 1 / -1;
  font-size: 10.5px;
  color: var(--dim);
  padding: 0 2px 3px;
  white-space: nowrap;
}
.sw {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  padding: 0;
}
.sw.on {
  border-color: var(--on-accent);
}
</style>
