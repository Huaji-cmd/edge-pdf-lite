<script setup lang="ts">
/**
 * 「文件」面板：树形列表 + 右键添加。
 *
 * ⚠️ 浏览器版限制（界面里必须说清楚，否则用户以为下次还在）：
 *    列表只活在本次会话，刷新就没。原因是 `<input type=file>` 只给临时
 *    File 对象，拿不到真实路径。（打包成 exe 后才有路径，才能持久化）
 */
import { computed, nextTick, ref, watch } from 'vue'
import Icon from './Icon.vue'
import {
  addFiles,
  addFolder,
  addFilesViaDialog,
  addFolderViaDialog,
  copyPath,
  loadChildren,
  refreshList,
  removeNode,
  renameFile,
  splitExt,
  type FileNode,
} from './fileList'
import { IS_TAURI } from '@/platform'
import { revealInFolder } from './settings'

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
  /** 弹个提示（重命名成败、复制结果这类反馈） */
  toast: [msg: string]
}>()

// ---------------- 展开状态（这是纯 UI 状态，不是"懒加载完成了"）

/**
 * 展开状态要**跨面板切换、跨会话**记住（用户报的"打开大纲再回来，全塌了"）。
 *
 * ⚠️ 存的是 `node.key`（`p:<真实路径>`），**不是 `node.id`**。
 *    `id` 是会话内自增的 `n1/n2/…`：重启之后同一个文件夹会拿到完全不同的 id，
 *    存 id 等于每次启动都清空。
 */
const EXPAND_KEY = 'epl:files-expanded'

function loadExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPAND_KEY)
    if (!raw) return new Set()
    const arr: unknown = JSON.parse(raw)
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

const expanded = ref<Set<string>>(loadExpanded())

function saveExpanded(next: Set<string>): void {
  try {
    localStorage.setItem(EXPAND_KEY, JSON.stringify([...next]))
  } catch {
    /* 存不下就算了，不影响使用 */
  }
}

function isOpen(node: FileNode): boolean {
  return expanded.value.has(node.key)
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
  if (next.has(node.key)) {
    next.delete(node.key)
  } else {
    next.add(node.key)
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
  saveExpanded(next)
}

/**
 * 把上次记住的展开状态重新打开。
 *
 * 挂载时（=`v-if` 切回文件面板时）跑一遍。`loadChildren` 有 `loaded` 标记，
 * 所以反复切面板不会反复扫盘。
 */
let restoring = false

async function restoreExpanded(): Promise<void> {
  if (restoring) return
  restoring = true
  try {
    const walk = async (list: readonly FileNode[]): Promise<void> => {
      for (const n of list) {
        if (n.kind !== 'folder' || !expanded.value.has(n.key)) continue
        if (!n.loaded) {
          markLoading(n.id, true)
          try {
            await loadChildren(n)
          } finally {
            markLoading(n.id, false)
          }
        }
        await walk(n.children ?? [])
      }
    }
    await walk(props.nodes)
  } finally {
    restoring = false
  }
}

/*
 * 监听的是**引用**（不是深度）：`restoreList()` 恢复书单时是整体换数组，
 * 而"添加文件/文件夹"是往里 push —— 后者不需要重新恢复展开态（用户刚操作完，
 * 眼前就是展开的），深度监听只会平白多跑几遍扫盘。
 */
watch(() => props.nodes, () => void restoreExpanded(), { immediate: true })

/** 正在扫盘的文件夹（显示"…"用） */
const loading = ref<Set<string>>(new Set())

function markLoading(id: string, on: boolean): void {
  const next = new Set(loading.value)
  on ? next.add(id) : next.delete(id)
  loading.value = next
}

// ---------------- 刷新（重扫已展开的文件夹）

/**
 * 用户报的问题：另存为一个新 PDF、或者往已添加的文件夹里拷了一份，列表里看不见，
 * 必须重开应用。
 *
 * 这里只重扫**展开过**的目录 —— 没展开的还是懒加载（点开才读）。
 */
const refreshing = ref(false)

async function onRefresh(): Promise<void> {
  if (refreshing.value) return
  if (!IS_TAURI) {
    emit('toast', '浏览器版拿不到真实路径，刷新不了（重新添加一次即可）')
    return
  }
  refreshing.value = true
  try {
    const r = await refreshList()
    emit('change')
    if (r.scanned === 0) {
      emit('toast', '还没有展开过的文件夹，点开一个再刷新')
    } else if (r.added > 0) {
      emit('toast', `已刷新：新增 ${r.added} 项（扫了 ${r.scanned} 个文件夹）`)
    } else {
      emit('toast', `已刷新：没有新文件（扫了 ${r.scanned} 个文件夹）`)
    }
  } catch (e) {
    emit('toast', `刷新失败：${String(e)}`)
  } finally {
    refreshing.value = false
  }
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
  const next = new Set(expanded.value)
  for (const n of props.nodes) if (n.kind === 'folder') next.add(n.key)
  expanded.value = next
  saveExpanded(next)
  emit('change')
}

// ---------------- 右键菜单

/**
 * 菜单有两种内容：`node` 为空 = 在空白处右键（添加文件/文件夹）；
 * `node` 非空 = 在某个**文件**上右键（重命名 / 打开位置 / 复制路径）。
 *
 * ⚠️ 行上的右键必须 `stopPropagation`，否则会冒泡到面板空白处的处理器 ——
 *    那样在文件上右键也会弹出"添加文件"，看着像菜单点错了。
 */
const menu = ref<{ x: number; y: number; node: FileNode | null } | null>(null)

function menuPos(e: MouseEvent): { x: number; y: number } {
  // 菜单要贴着鼠标，但不能超出右/下边界
  return {
    x: Math.min(e.clientX, window.innerWidth - 180),
    y: Math.min(e.clientY, window.innerHeight - 150),
  }
}

function openBlankMenu(e: MouseEvent): void {
  e.preventDefault()
  menu.value = { ...menuPos(e), node: null }
}

function openFileMenu(e: MouseEvent, n: FileNode): void {
  e.preventDefault()
  e.stopPropagation()
  // 文件夹暂时没有自己的操作，就不弹菜单了（弹一个只有"添加"的菜单更奇怪）
  if (n.kind !== 'file') return
  menu.value = { ...menuPos(e), node: n }
}

function closeMenu(): void {
  menu.value = null
}

// ---------------- 文件操作（都要真实路径，浏览器版没有）

/** 某个条目能不能做"改磁盘文件"这类操作 */
function hasPath(n: FileNode): boolean {
  return IS_TAURI && !!n.path
}

async function onReveal(n: FileNode): Promise<void> {
  closeMenu()
  if (!(await revealInFolder(n.path ?? ''))) emit('toast', `打不开：${n.path ?? '（没有路径）'}`)
}

async function onCopyPath(n: FileNode): Promise<void> {
  closeMenu()
  const r = await copyPath(n)
  /*
   * ⚠️ 三种结果都要给反馈：剪贴板是"看不见"的操作，一声不响用户就不知道成没成
   *    （失败时还会以为程序坏了）。
   *    `no-response` 这一种尤其别写成"失败" —— 实测过这种情况下其实已经复制上了，
   *    只是剪贴板没回来报信；提示语里把路径带出来，用户想手动复制也有得抄。
   */
  if (r === 'ok') emit('toast', `已复制路径：${n.path}`)
  else if (r === 'denied') emit('toast', '复制失败，可能是浏览器不允许访问剪贴板')
  else emit('toast', `复制没有回应（路径已复制就绪）：${n.path}`)
}

// ---------------- 重命名

const renaming = ref<string | null>(null)
const renameDraft = ref('')

/**
 * 重命名输入框的引用。
 *
 * ⚠️ **不能用字符串 ref**（`ref="renameInput"`）：它在 `v-for` 里，
 *    Vue 会把同名 ref 收集成**数组**，于是 `.focus()` 报
 *    "value?.focus is not a function" —— 而且这条错误只在控制台里，
 *    界面上表现为"点了重命名但没聚焦，得再点一下输入框"，很容易被当成小毛病放过。
 *    改用**函数 ref** 就不会有这层歧义。
 */
let renameInput: HTMLInputElement | null = null
function bindRenameInput(el: unknown): void {
  renameInput = (el as HTMLInputElement | null) ?? null
}

async function startRename(n: FileNode): Promise<void> {
  closeMenu()
  renaming.value = n.id
  renameDraft.value = splitExt(n.name).base // 只改主文件名，后缀由代码拼回
  await nextTick()
  // 自动聚焦并全选 —— 不然用户还得再点一下输入框才能改
  renameInput?.focus()
  renameInput?.select()
}

function cancelRename(): void {
  renaming.value = null
}

async function commitRename(n: FileNode): Promise<void> {
  // ⚠️ Esc 之后还会再触发一次 blur，靠这行挡掉第二次提交
  const id = renaming.value
  if (id !== n.id) return
  renaming.value = null

  const r = await renameFile(n, renameDraft.value)
  if (!r.ok) {
    emit('toast', `重命名失败：${r.error ?? '未知错误'}`)
    return
  }
  if (r.name && r.name !== n.name) {
    emit('toast', `已重命名为 ${r.name}`)
    emit('change')
  }
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
      if (n.kind === 'folder' && isOpen(n) && n.children) walk(n.children, depth + 1)
    }
  }
  walk(props.nodes, 0)
  return out
})
</script>

<template>
  <div class="files" data-tid="files-panel" @contextmenu="openBlankMenu" @click="closeMenu">
    <!--
      顶部工具条：刷新。
      ⚠️ 粘在顶部（`position: sticky`），否则列表一长，刷新按钮就跟着滚走了。
    -->
    <div class="bar">
      <span class="bar-title">文件</span>
      <button
        class="bar-btn"
        :class="{ spin: refreshing }"
        data-tid="files-refresh"
        :title="IS_TAURI ? '刷新：重扫已展开的文件夹（新另存的文件也能出现）' : '浏览器版拿不到真实路径，刷新不了'"
        :disabled="!IS_TAURI"
        @click.stop="onRefresh"
      >
        <Icon name="refresh" />
      </button>
    </div>

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
        @contextmenu.stop="openFileMenu($event, r.node)"
      >
        <span v-if="r.node.kind === 'folder'" class="twisty" :class="{ open: isOpen(r.node) }">
          <Icon name="chevron-right" />
        </span>
        <span v-else class="twisty" />

        <Icon :name="r.node.kind === 'folder' ? 'folder' : 'file'" class="leaf" />

        <!--
          重命名：行内编辑，**只编辑主文件名**，后缀拼在旁边当固定后缀显示。
          这样"不允许改后缀"是界面本身就说清楚的事，不是靠报错拦。
        -->
        <span v-if="renaming === r.node.id" class="ren-wrap">
          <input
            :ref="bindRenameInput"
            v-model="renameDraft"
            class="ren"
            data-tid="rename-input"
            @keydown.enter.prevent="commitRename(r.node)"
            @keydown.esc.prevent="cancelRename()"
            @blur="commitRename(r.node)"
            @click.stop
          />
          <span class="ren-ext">{{ splitExt(r.node.name).ext }}</span>
        </span>
        <span v-else class="name">{{ r.node.name }}</span>

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

    <!--
      桌面版不再写"列表会记住" —— 那是**默认行为**，说出来反而是噪音
      （用户要求删）。浏览器版那条限制说明保留：它是"会丢东西"的警告，
      不说用户真的会以为下次还在。
    -->
    <p v-if="!IS_TAURI" class="hint">
      浏览器版：这里的条目只在本次会话有效，<b>刷新后要重新添加</b>（浏览器拿不到文件真实路径）。
    </p>

    <!-- 右键菜单：空白处 vs 文件上，内容不同 -->
    <div
      v-if="menu"
      class="ctx"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      @click.stop
    >
      <template v-if="!menu.node">
        <button data-tid="add-files" @click="menuPick('file')">
          <Icon name="file" /> 添加文件…
        </button>
        <button data-tid="add-folder" @click="menuPick('folder')">
          <Icon name="folder" /> 添加文件夹…
        </button>
      </template>

      <template v-else>
        <button
          data-tid="file-rename"
          :disabled="!hasPath(menu.node)"
          :title="hasPath(menu.node) ? '改名（后缀不会变）' : '浏览器版没有真实路径，改不了磁盘上的文件名'"
          @click="startRename(menu.node)"
        >
          <Icon name="file" /> 重命名…
        </button>
        <button
          data-tid="file-reveal"
          :disabled="!hasPath(menu.node)"
          :title="hasPath(menu.node) ? '在资源管理器里显示' : '浏览器版没有真实路径'"
          @click="onReveal(menu.node)"
        >
          <Icon name="folder-open" /> 在资源管理器打开
        </button>
        <button
          data-tid="file-copy-path"
          :disabled="!hasPath(menu.node)"
          :title="hasPath(menu.node) ? '复制磁盘上的绝对路径' : '浏览器版没有真实路径'"
          @click="onCopyPath(menu.node)"
        >
          <Icon name="file" /> 复制路径
        </button>
      </template>
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

/*
 * 顶部工具条。`sticky` 是必须的：文件多的时候列表会滚，
 * 刷新按钮不能跟着一起滚走（那就等于没有）。背景要用面板色盖住底下滚过去的行。
 */
.bar {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 2px 8px 6px;
  margin: -6px -4px 4px;
  background: var(--panel);
}
.bar-title {
  font-size: 11px;
  letter-spacing: 0.06em;
  color: var(--mute);
}
.bar-btn {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--dim);
  cursor: pointer;
  padding: 0;
}
.bar-btn:hover:not(:disabled) {
  background: var(--hover);
  color: var(--fg);
}
.bar-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.bar-btn.spin :deep(.ic) {
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
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

/* 重命名：输入框后面紧跟一个灰掉的后缀 —— 视觉上就说明了"后缀改不了" */
.ren-wrap {
  flex: 1 1 auto;
  min-width: 0;
  display: inline-flex;
  align-items: center;
}
.ren {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0 4px;
  border: 1px solid var(--accent);
  border-radius: 3px;
  background: var(--bg);
  color: var(--fg);
  font: inherit;
  font-size: 13px;
  outline: none;
}
.ren-ext {
  flex: 0 0 auto;
  font-size: 13px;
  color: var(--dim-2);
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
/*
 * 禁用的项要**看得出来是禁用的** —— 光是点了没反应，用户会以为程序坏了。
 * 浏览器版这三个操作都需要真实路径，做不到就得当场说清（title 里也写了原因）。
 */
.ctx button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.ctx button:disabled:hover {
  background: none;
}
.ctx :deep(.ic) {
  width: 15px;
  height: 15px;
  color: var(--dim);
}
</style>
