/**
 * 浏览器版的本地图片 —— **File System Access API**（Chromium / WebView2 都支持）。
 *
 * ## 能力边界（刻意和桌面版对齐）
 * 桌面版读图走 `read_doc_asset`，边界是"文档所在目录"；浏览器版没有文件系统权限，
 * 唯一的合法入口是**用户亲手授权一个文件夹**（`showDirectoryPicker({ mode: 'read' })`）。
 * 授权之后：
 *   - 只能读到那个文件夹**之内**的文件 —— API 本身禁止 `..` 越界（`getDirectoryHandle('..')` 直接抛），
 *     和 Rust 侧的目录包含校验是同一道墙的两种砌法；
 *   - 授权是**每会话**的：刷新后 `queryPermission` 回 'prompt'，需要用户再点一次占位确认
 *     （浏览器规定 `requestPermission` 必须在用户手势里调用，点占位就是那个手势）。
 *
 * ## 为什么把句柄存 IndexedDB
 * `FileSystemDirectoryHandle` 是可克隆对象，存进 IndexedDB 就能"记住上次选的文件夹"，
 * 下次打开同一篇笔记只差一次点击确认，不用重新翻目录。
 */

export type FsDirHandle = FileSystemDirectoryHandle

/** 浏览器是否支持"选文件夹"这条链路（Firefox / Safari 没有 showDirectoryPicker） */
export function canPickDirectory(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
  )
}

interface PermHandle {
  queryPermission(desc?: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
  requestPermission(desc?: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
}

// ---------------------------------------------------------------- IndexedDB（只存一个句柄）

const DB_NAME = 'epl-md-assets'
const STORE = 'handles'
const KEY = 'root'

function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(STORE, mode)
      const r = fn(tx.objectStore(STORE))
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
      tx.oncomplete = () => db.close()
    }
  })
}

async function storeRoot(handle: FsDirHandle): Promise<void> {
  try {
    await withStore('readwrite', (st) => st.put(handle, KEY))
  } catch {
    /* 存不上（隐私模式/老浏览器）就没法跨会话记住 —— 每次重新选一次而已 */
  }
}

export async function getStoredRoot(): Promise<FsDirHandle | null> {
  try {
    const h = await withStore<FsDirHandle | undefined>('readonly', (st) => st.get(KEY))
    return h ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 选文件夹 / 权限 / 读文件

/**
 * 弹出系统目录选择器。**必须在用户手势里调用**（点占位/按钮）。
 * 返回 null = 用户取消或环境不支持 —— 这是正常结果，不是错误。
 */
export async function pickRoot(): Promise<FsDirHandle | null> {
  try {
    const picker = (window as unknown as { showDirectoryPicker?: (o?: { mode: 'read' }) => Promise<FsDirHandle> })
      .showDirectoryPicker
    if (typeof picker !== 'function') return null
    const handle = await picker.call(window, { mode: 'read' })
    if (handle) await storeRoot(handle)
    return handle ?? null
  } catch {
    /* AbortError（用户关掉选择框）或环境不支持 —— 都按"取消"处理 */
    return null
  }
}

/** 已授权 → true；'prompt' → 借当前手势请求一次；被拒 → false */
export async function ensurePermission(handle: FsDirHandle): Promise<boolean> {
  try {
    const h = handle as unknown as PermHandle
    if ((await h.queryPermission({ mode: 'read' })) === 'granted') return true
    return (await h.requestPermission({ mode: 'read' })) === 'granted'
  } catch {
    return false
  }
}

/**
 * 按相对路径从授权目录里读一张图，返回 File（可直接进 Blob / img）。
 *
 * 逐段 `getDirectoryHandle` 下钻 —— API 不接受含 `..` 的路径，
 * 所以"授权目录之外"在类型层面就进不来（和桌面版的 resolve_asset 同一语义）。
 * rel 已在 markdownDocument 解析阶段拒绝过绝对路径/越界，这里是第二道。
 */
export async function readAsset(root: FsDirHandle, rel: string): Promise<File> {
  const parts = rel.split('/').filter((p) => p.length > 0 && p !== '.')
  if (!parts.length) throw new Error('empty')
  let dir: FileSystemDirectoryHandle = root
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i]!, { create: false })
  }
  const file = await dir.getFileHandle(parts[parts.length - 1]!, { create: false })
  return file.getFile()
}
