/**
 * 左侧「文件」面板的数据源。
 *
 * ⚠️ **浏览器里这个列表只活在本次会话。**
 *    `<input type=file>` 给的是一个临时 File 对象 —— 拿不到真实路径
 *    （`C:\Users\...\书.pdf`），也没法持久化：刷新就全没了。
 *    所以浏览器版必须把这件事**明确写在界面上**，而不是让用户以为下次还在。
 *
 * 打包成 exe（Tauri）后才有真实路径，那时才能：
 *   - 存下来（跨会话保留列表）
 *   - 懒加载目录（点开箭头才扫一层，避免误加大目录卡死）
 * 这两件事等接上 Tauri 再做（用 `IS_TAURI` 分流），
 * 现在只实现**能在浏览器里验证**的部分。
 */
import { computed, ref } from 'vue'

export interface FileNode {
  id: string
  name: string
  kind: 'file' | 'folder'
  /** 浏览器：会话内的 File 对象（点开时读它的字节） */
  file?: File
  /** 文件夹的子项 */
  children?: FileNode[]
  /** 去重键 */
  key: string
}

/** 只收 PDF —— 这是 PDF 阅读器，混进一堆 docx 只会让列表变噪音 */
function isPdf(name: string): boolean {
  return /\.pdf$/i.test(name)
}

const nodes = ref<FileNode[]>([])
let seq = 0
const newId = (): string => `n${++seq}`

function keyOfFile(f: File): string {
  return `${f.name}|${f.size}|${f.lastModified}`
}

/** 递归数一共多少个**文件**（文件夹不算） */
export function countFiles(list: readonly FileNode[]): number {
  let n = 0
  for (const it of list) {
    if (it.kind === 'file') n++
    else if (it.children) n += countFiles(it.children)
  }
  return n
}

/** 把文件塞进指定层级（按 key 去重） */
function pushFile(file: File, into: FileNode[]): boolean {
  const key = keyOfFile(file)
  if (into.some((n) => n.kind === 'file' && n.key === key)) return false
  into.push({ id: newId(), name: file.name, kind: 'file', file, key })
  return true
}

/** 找同名的直接子文件夹，没有就建一个 */
function ensureFolder(into: FileNode[], name: string, key: string): FileNode {
  let f = into.find((n) => n.kind === 'folder' && n.name === name)
  if (!f) {
    f = { id: newId(), name, kind: 'folder', children: [], key }
    into.push(f)
  }
  return f
}

/** 把「添加文件」的结果（平铺）加进列表 */
export function addFiles(files: readonly File[]): number {
  let added = 0
  for (const f of files) {
    if (!isPdf(f.name)) continue
    if (pushFile(f, nodes.value)) added++
  }
  return added
}

/**
 * 把「添加文件夹」的结果加进列表，按相对路径还原目录结构。
 *
 * ⚠️ 浏览器只能一次性拿到**整个目录的文件**（`webkitdirectory` 没有目录句柄，
 *    拿不到"点开才读"的能力），所以这里直接建成树，而不是懒加载。
 *    真正的懒加载要等 Tauri（`fs.readDir`）。
 */
export function addFolder(files: readonly File[]): number {
  let added = 0
  for (const f of files) {
    if (!isPdf(f.name)) continue
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
    const parts = rel.split('/').filter(Boolean)
    // 最后一段是文件名；前面的是各级目录（第一段是用户选的根目录名）
    const dirs = parts.slice(0, -1)
    let cur = nodes.value
    for (let i = 0; i < dirs.length; i++) {
      cur = ensureFolder(cur, dirs[i]!, `d:${dirs.slice(0, i + 1).join('/')}`).children!
    }
    if (pushFile(f, cur)) added++
  }
  return added
}

/** 清空列表 */
export function clearFiles(): void {
  nodes.value = []
}

/** 删掉一个条目（文件夹带走里面的） */
export function removeNode(id: string, list: readonly FileNode[] = nodes.value): boolean {
  for (let i = 0; i < list.length; i++) {
    if (list[i]!.id === id) {
      // ⚠️ nodes.value 是响应式数组，必须用 splice 原地改；
      //    重建数组会让 <template v-for> 里的展开状态全部丢掉
      ;(list as FileNode[]).splice(i, 1)
      return true
    }
    const kids = list[i]!.children
    if (kids && removeNode(id, kids)) return true
  }
  return false
}

export function useFileList() {
  return {
    nodes,
    fileCount: computed(() => countFiles(nodes.value)),
  }
}
