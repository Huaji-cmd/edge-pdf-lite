<script setup lang="ts">
/**
 * 「文件」面板：树形列表 + 右键添加。
 *
 * ⚠️ 浏览器版限制（界面里必须说清楚，否则用户以为下次还在）：
 *    列表只活在本次会话，刷新就没。原因是 `<input type=file>` 只给临时
 *    File 对象，拿不到真实路径。（打包成 exe 后才有路径，才能持久化）
 */
import { computed, ref } from 'vue'
import Icon from './Icon.vue'
import {
  addFiles,
  addFolder,
  addFilesViaDialog,
  addFolderViaDialog,
  loadChildren,
  removeNode,
  type FileNode,
} from './fileList'
import { IS_TAURI } from '@/platform'

const props = defineProps<{
  nodes: readonly FileNode[]
  /** 当前打开的文件 id（用于高亮） */
  currentId: string | null
  /** 有没有正在打开的动作（防止重复点） */
  busy: boolean
}>()

const emit = defineEmits<{
  /** 用户点了一个文件 —— 由上层去读字节并打开（桌面端走 Rust 读，浏览器端读 File） */
  open: [node: FileNode]
  /** 列表内容变了 */
  change: []
}>()

// ---------------- 展开状态（这是纯 UI 状态，不是"懒加载完成了"）

const expanded = ref<Set<string>>(new Set())

function isOpen(id: string): boolean {
  return expanded.value.has(id)
}

/**
 * 展开 / 收起一个文件夹。
 *
 * ⚠️ 只在**第一次展开**时去扫目录（桌面端 `loadChildren`）——
 *    这就是"懒加载"：用户误加一个大目录也不会一上来就卡住。
 */
async function toggle(node: FileNode): Promise<void> {
  if (node.kind !== 'folder') return
  const next = new Set(expanded.value)
  if (next.has(node.id)) {
    next.delete(node.id)
  } else {
    next.add(node.id)
    // 扫大目录会有一点延迟，不给反馈的话点箭头像"没反应"
    markLoading(node.id, true)
    try {
      await loadChildren(node) // 内部有 loaded 标记，扫过就不再重复扫
    } finally {
      markLoading(node.id, false)
    }
  }
  // ⚠️ Set 是引用类型，必须换一个新 Set 才会触发 Vue 更新
  expanded.value = next
}

/** 正在扫盘的文件夹（显示"…"用） */
const loading = ref<Set<string>>(new Set())

function markLoading(id: string, on: boolean): void {
  const next = new Set(loading.value)
  on ? next.add(id) : next.delete(id)
  loading.value = next
}

// ---------------- 添加

const fileInput = ref<HTMLInputElement | null>(null)
const dirInput = ref<HTMLInputElement | null>(null)

function pickFiles(): void {
  fileInput.value?.click()
}

function pickFolder(): void {
  dirInput.value?.click()
}

function onFilesPicked(e: Event): void {
  const el = e.target as HTMLInputElement
  const list = [...(el.files ?? [])]
  el.value = '' // 允许连续选同一个文件
  if (!list.length) return
  addFiles(list)
  emit('change')
}

function onFolderPicked(e: Event): void {
  const el = e.target as HTMLInputElement
  const list = [...(el.files ?? [])]
  el.value = ''
  if (!list.length) return
  addFolder(list)
  // 刚加进来的根文件夹默认展开 —— 不然用户看到的是"点了一下什么都没发生"
  for (const n of props.nodes) if (n.kind === 'folder') expanded.value.add(n.id)
  emit('change')
}

// ---------------- 右键菜单

const menu = ref<{ x: number; y: number } | null>(null)

function openMenu(e: MouseEvent): void {
  e.preventDefault()
  // 菜单要贴着鼠标，但不能超出右/下边界
  menu.value = { x: Math.min(e.clientX, window.innerWidth - 170), y: Math.min(e.clientY, window.innerHeight - 90) }
}

function closeMenu(): void {
  menu.value = null
}

/**
 * 菜单里的「添加文件…」/「添加文件夹…」。
 *
 * ⚠️ 桌面端和浏览器端是**两套**：桌面端弹系统对话框拿**真实路径**
 *    （可持久化、可懒加载），浏览器端只能调 `<input>` 拿临时 File。
 */
async function menuPick(which: 'file' | 'folder'): Promise<void> {
  closeMenu()
  if (IS_TAURI) {
    const n = which === 'file' ? await addFilesViaDialog() : await addFolderViaDialog()
    if (n > 0) emit('change')
    return
  }
  which === 'file' ? pickFiles() : pickFolder()
}

// ---------------- 打开 / 删除

function openNode(n: FileNode): void {
  if (n.kind === 'folder') {
    void toggle(n)
    return
  }
  emit('open', n)
}

function dropNode(n: FileNode): void {
  if (removeNode(n.id)) emit('change')
}

// ---------------- 拍平成带缩进的列表

/**
 * 把树拍成一行行，缩进用 padding 表示。
 *
 * 比"递归组件"简单：不用自己 import 自己，也不用担心深度限制 ——
 * 而且折叠逻辑只影响这一个 computed，模板里是平的。
 */
const rows = computed(() => {
  const out: Array<{ node: FileNode; depth: number }> = []
  const walk = (list: readonly FileNode[], depth: number): void => {
    for (const n of list) {
      out.push({ node: n, depth })
      if (n.kind === 'folder' && isOpen(n.id) && n.children) walk(n.children, depth + 1)
    }
  }
  walk(props.nodes, 0)
  return out
})
</script>

<template>
  <div class="files" data-tid="files-panel" @contextmenu="openMenu" @click="closeMenu">
    <!-- 隐藏的文件选择器：右键菜单点完才触发 -->
    <input
      ref="fileInput"
      class="hidden-input"
      type="file"
      accept="application/pdf,.pdf"
      multiple
      @change="onFilesPicked"
    />
    <input
      ref="dirInput"
      class="hidden-input"
      type="file"
      webkitdirectory
      multiple
      @change="onFolderPicked"
    />

    <p v-if="!nodes.length" class="empty">
      列表还是空的。<br />
      <b>在空白处点右键</b> → 添加文件 / 添加文件夹。
    </p>

    <template v-else>
      <div
        v-for="r in rows"
        :key="r.node.id"
        class="row"
        :class="{ cur: r.node.id === currentId }"
        :style="{ paddingLeft: `${6 + r.depth * 14}px` }"
        :data-node-id="r.node.id"
        :data-kind="r.node.kind"
        :title="r.node.name"
        @click.stop="openNode(r.node)"
      >
        <span v-if="r.node.kind === 'folder'" class="twisty" :class="{ open: isOpen(r.node.id) }">
          <Icon name="chevron-right" />
        </span>
        <span v-else class="twisty" />

        <Icon :name="r.node.kind === 'folder' ? 'folder' : 'file'" class="leaf" />
        <span class="name">{{ r.node.name }}</span>
        <span v-if="loading.has(r.node.id)" class="busy" title="正在读这一层…">…</span>

        <button
          class="rm"
          title="从列表移除（不会删磁盘上的文件）"
          @click.stop="dropNode(r.node)"
        >
          <Icon name="close" />
        </button>
      </div>
    </template>

    <p class="hint">
      <template v-if="!IS_TAURI">
        浏览器版：这里的条目只在本次会话有效，<b>刷新后要重新添加</b>（浏览器拿不到文件真实路径）。
      </template>
      <template v-else>桌面版：列表会记住，下次打开还在。</template>
    </p>

    <!-- 右键菜单 -->
    <div
      v-if="menu"
      class="ctx"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      @click.stop
    >
      <button data-tid="add-files" @click="menuPick('file')">
        <Icon name="file" /> 添加文件…
      </button>
      <button data-tid="add-folder" @click="menuPick('folder')">
        <Icon name="folder" /> 添加文件夹…
      </button>
    </div>
  </div>
</template>

<style scoped>
.files {
  flex: 1 1 auto;
  min-width: 0;
  overflow: auto;
  padding: 6px 4px 40px;
  position: relative;
}

.hidden-input {
  display: none;
}

.empty {
  margin: 14px 10px;
  font-size: 12px;
  line-height: 1.9;
  color: var(--mute);
}
.empty b {
  color: var(--dim);
}

.row {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 6px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 13px;
  color: var(--fg);
}
.row:hover {
  background: var(--btn);
}
.row.cur {
  background: var(--sel-bg);
  color: var(--sel-fg);
}

.busy {
  flex: 0 0 auto;
  color: var(--mute);
  animation: pulse 1s ease-in-out infinite;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 0.3;
  }
  50% {
    opacity: 1;
  }
}

/* 缩进用行内 padding-left 给（见模板），这里不写死层级 */

.twisty {
  width: 13px;
  height: 13px;
  flex: 0 0 13px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--dim-2);
  transition: transform 0.12s;
}
.twisty.open {
  transform: rotate(90deg);
}
.twisty :deep(.ic) {
  width: 13px;
  height: 13px;
}

.leaf {
  width: 15px;
  height: 15px;
  color: var(--dim-2);
}
.row.cur .leaf {
  color: var(--sel-fg);
}

.name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rm {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  display: none;
  align-items: center;
  justify-content: center;
  background: none;
  border: 0;
  border-radius: 3px;
  color: var(--dim-2);
  cursor: pointer;
  padding: 0;
}
.row:hover .rm {
  display: inline-flex;
}
.rm:hover {
  background: var(--err-bg);
  color: var(--err);
}
.rm :deep(.ic) {
  width: 12px;
  height: 12px;
}

.hint {
  margin: 14px 10px 0;
  font-size: 11px;
  line-height: 1.7;
  color: var(--mute);
}
.hint b {
  color: var(--dim);
}

.ctx {
  position: fixed;
  z-index: 300;
  min-width: 160px;
  padding: 4px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 8px 26px var(--shadow);
  display: flex;
  flex-direction: column;
}
.ctx button {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  background: none;
  border: 0;
  border-radius: 5px;
  color: var(--fg);
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.ctx button:hover {
  background: var(--btn);
}
.ctx :deep(.ic) {
  width: 15px;
  height: 15px;
  color: var(--dim);
}
</style>
