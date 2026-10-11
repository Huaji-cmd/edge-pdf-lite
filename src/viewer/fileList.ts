/**
 * 左侧「文件」面板的数据源。**两套实现，按运行环境分流。**
 *
 * ## 桌面端（Tauri）
 * 能拿到**真实路径**，所以可以做三件浏览器做不到的事：
 *   1. 持久化 —— 路径是字符串，存 localStorage 就能跨会话记住
 *   2. 目录懒加载 —— 点开箭头才扫**那一层**（`list_dir` 命令）
 *   3. 直接读文件 —— `read_pdf_bytes` 命令，不用经过 `<input>`
 *
 * ## 浏览器端
 * `<input type=file>` 只给一个**临时 File 对象**：没有路径、刷新即丢。
 * 所以列表只活在本次会话，而且界面上必须写清楚（否则用户以为下次还在）。
 *
 * ⚠️ 所有 Tauri 的 import 都是**动态**的 —— 静态引入会让**浏览器版**
 *    也把这套桌面端 API 打进主包，跟"只在必须付的时候付一次"冲突。
 */
import { computed, ref } from 'vue'
import { IS_TAURI } from '@/platform'

export interface FileNode {
  id: string
  name: string
  kind: 'file' | 'folder'
  /** 浏览器：会话内的 File 对象（点开时读它的字节） */
  file?: File
  /** 桌面端：真实路径（可持久化、可懒加载） */
  path?: string
  /** 文件夹的子项 */
  children?: FileNode[]
  /** 文件夹是否已扫过（懒加载标记；只对桌面端有意义） */
  loaded?: boolean
  key: string
}

/** 只收 PDF —— 这是 PDF 阅读器，混进一堆 docx 只会让列表变噪音 */
function isPdf(name: string): boolean {
  return /\.pdf$/i.test(name)
}

const nodes = ref<FileNode[]>([])
let seq = 0
const newId = (): string => `n${++seq}`

const STORE_KEY = 'epl:file-list'

// ---------------------------------------------------------------- 桌面端 API

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import('@tauri-apps/api/core')
  return core.invoke<T>(cmd, args)
}

/** 弹系统文件/文件夹对话框，返回选中的**路径** */
async function pickPaths(directory: boolean): Promise<string[]> {
  const dlg = await import('@tauri-apps/plugin-dialog')
  const picked = await dlg.open({
    directory,
    multiple: !directory,
    filters: directory ? undefined : [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (!picked) return []
  return Array.isArray(picked) ? picked : [picked]
}

function baseName(p: string): string {
  // Windows 用 \，其他用 /；两个都处理
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

// ---------------------------------------------------------------- 持久化（仅桌面端）

interface StoredEntry {
  name: string
  path: string
  kind: 'file' | 'folder'
}

export function persistList(): void {
  if (!IS_TAURI) return
  const list: StoredEntry[] = nodes.value.map((n) => ({
    name: n.name,
    path: n.path ?? '',
    kind: n.kind,
  }))
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list))
  } catch {
    /* 存不下就算了，不影响使用 */
  }
}

/** 启动时恢复上次记住的列表。文件夹不预扫（`loaded=false`，点开才读） */
export function restoreList(): void {
  if (!IS_TAURI) return
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return
    const list = JSON.parse(raw) as StoredEntry[]
    nodes.value = list
      .filter((e) => e.path)
      .map((e) => ({
        id: newId(),
        name: e.name || baseName(e.path),
        kind: e.kind,
        path: e.path,
        children: e.kind === 'folder' ? [] : undefined,
        loaded: false,
        key: `p:${e.path}`,
      }))
  } catch {
    nodes.value = []
  }
}

/** 去掉一个已失效的条目（比如上次记住的文件被删了） */
function dropByKey(key: string): void {
  const i = nodes.value.findIndex((n) => n.key === key)
  if (i >= 0) nodes.value.splice(i, 1)
}

// ---------------------------------------------------------------- 添加（桌面端）

export async function addFilesViaDialog(): Promise<number> {
  const paths = await pickPaths(false)
  let added = 0
  for (const p of paths) {
    const name = baseName(p)
    if (!isPdf(name)) continue
    if (nodes.value.some((n) => n.kind === 'file' && n.path === p)) continue
    nodes.value.push({ id: newId(), name, kind: 'file', path: p, key: `p:${p}` })
    added++
  }
  if (added) persistList()
  return added
}

export async function addFolderViaDialog(): Promise<number> {
  const paths = await pickPaths(true)
  let added = 0
  for (const p of paths) {
    if (nodes.value.some((n) => n.kind === 'folder' && n.path === p)) continue
    nodes.value.push({
      id: newId(),
      name: baseName(p),
      kind: 'folder',
      path: p,
      children: [],
      loaded: false,
      key: `p:${p}`,
    })
    added++
  }
  if (added) persistList()
  return added
}

/**
 * 展开文件夹时扫**一层**。
 *
 * ⚠️ 只在第一次展开时真的去读（`loaded` 标记），之后再展开直接用缓存的子项 ——
 *    反复扫同一个目录在低配机上是很明显的浪费。
 */
export async function loadChildren(node: FileNode): Promise<void> {
  if (node.kind !== 'folder' || !node.path || node.loaded) return
  try {
    const entries = await invoke<Array<{ name: string; path: string; is_dir: boolean }>>(
      'list_dir',
      { path: node.path },
    )
    node.children = entries.map((e) => ({
      id: newId(),
      name: e.name,
      kind: e.is_dir ? 'folder' : 'file',
      path: e.path,
      children: e.is_dir ? [] : undefined,
      loaded: false,
      key: `p:${e.path}`,
    }))
    node.loaded = true
  } catch (e) {
    // 读不了（权限/目录被删）就标记成空，别让界面一直转
    node.children = []
    node.loaded = true
    console.warn('[fileList] 读目录失败：', e)
  }
}

/** 读一个文件的字节。桌面端走 Rust，浏览器端读 File 对象 */
export async function readPdfBytes(node: FileNode): Promise<Uint8Array> {
  if (node.path) {
    const bytes = await invoke<number[]>('read_pdf_bytes', { path: node.path })
    return new Uint8Array(bytes)
  }
  if (node.file) return new Uint8Array(await node.file.arrayBuffer())
  throw new Error('这个条目既没有路径也没有文件，读不了')
}

/** 桌面端打开前先确认文件还在（上次记住的可能已经被删了） */
export async function stillExists(node: FileNode): Promise<boolean> {
  if (!node.path) return true // 浏览器端没有路径可查，直接尝试
  try {
    return await invoke<boolean>('path_exists', { path: node.path })
  } catch {
    return true
  }
}

// ---------------------------------------------------------------- 添加（浏览器端）

/** 递归数一共多少个**文件**（文件夹不算） */
export function countFiles(list: readonly FileNode[]): number {
  let n = 0
  for (const it of list) {
    if (it.kind === 'file') n++
    else if (it.children) n += countFiles(it.children)
  }
  return n
}

function pushFile(file: File, into: FileNode[]): boolean {
  const key = `${file.name}|${file.size}|${file.lastModified}`
  if (into.some((n) => n.kind === 'file' && n.key === key)) return false
  into.push({ id: newId(), name: file.name, kind: 'file', file, key })
  return true
}

function ensureFolder(into: FileNode[], name: string, key: string): FileNode {
  let f = into.find((n) => n.kind === 'folder' && n.name === name)
  if (!f) {
    f = { id: newId(), name, kind: 'folder', children: [], key }
    into.push(f)
  }
  return f
}

/** 浏览器：把"添加文件"的结果（平铺）加进列表 */
export function addFiles(files: readonly File[]): number {
  let added = 0
  for (const f of files) {
    if (!isPdf(f.name)) continue
    if (pushFile(f, nodes.value)) added++
  }
  return added
}

/**
 * 浏览器：把"添加文件夹"的结果加进列表，按相对路径还原目录结构。
 *
 * ⚠️ 浏览器只能一次性拿到整个目录的文件（`webkitdirectory` 没有目录句柄），
 *    所以这里直接建成树，做不到"点开才读"。真正的懒加载只有桌面端有。
 */
export function addFolder(files: readonly File[]): number {
  let added = 0
  for (const f of files) {
    if (!isPdf(f.name)) continue
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
    const parts = rel.split('/').filter(Boolean)
    const dirs = parts.slice(0, -1)
    let cur = nodes.value
    for (let i = 0; i < dirs.length; i++) {
      cur = ensureFolder(cur, dirs[i]!, `d:${dirs.slice(0, i + 1).join('/')}`).children!
    }
    if (pushFile(f, cur)) added++
  }
  return added
}

// ---------------------------------------------------------------- 通用

export function clearFiles(): void {
  nodes.value = []
  persistList()
}

/** 删掉一个条目（文件夹带走里面的） */
export function removeNode(id: string, list: readonly FileNode[] = nodes.value): boolean {
  for (let i = 0; i < list.length; i++) {
    if (list[i]!.id === id) {
      // ⚠️ 必须用 splice 原地改；重建数组会让模板里的展开状态全部丢掉
      ;(list as FileNode[]).splice(i, 1)
      persistList()
      return true
    }
    const kids = list[i]!.children
    if (kids && removeNode(id, kids)) return true
  }
  return false
}

/** 桌面端：清掉已经不存在了的条目（启动时调一次） */
export async function pruneMissing(): Promise<number> {
  if (!IS_TAURI) return 0
  let removed = 0
  for (const n of [...nodes.value]) {
    if (!(await stillExists(n))) {
      dropByKey(n.key)
      removed++
    }
  }
  if (removed) persistList()
  return removed
}

export function useFileList() {
  return {
    nodes,
    fileCount: computed(() => countFiles(nodes.value)),
  }
}
