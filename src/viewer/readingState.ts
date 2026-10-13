import type { ViewMode } from './types'

/**
 * 阅读位置记忆。
 *
 * 键用 pdf.js 算出的 **文档指纹**（`PDFDocumentProxy.fingerprints[0]`）——
 * 它是基于文件内容算的，所以同一本书你改个文件名、换个目录，位置照样认得出来。
 * 用文件名当键的话，重命名一次记忆就丢了。
 */
export interface ReadingState {
  page: number
  scale: number
  mode: ViewMode
  spreadOffset: 0 | 1
  updatedAt: number
}

const PREFIX = 'epl:reading:'

/** 记忆的最大有效期（天）。太旧的记录没必要拿来感动自己 */
const MAX_AGE_DAYS = 180

export function readingKey(fingerprint: string): string {
  return PREFIX + fingerprint
}

export function loadReadingState(fingerprint: string): ReadingState | null {
  if (!fingerprint) return null
  try {
    const raw = localStorage.getItem(readingKey(fingerprint))
    if (!raw) return null
    const s = JSON.parse(raw) as Partial<ReadingState>
    if (typeof s.page !== 'number' || !Number.isFinite(s.page) || s.page < 1) return null
    if (typeof s.scale !== 'number' || !Number.isFinite(s.scale) || s.scale <= 0) return null
    const ageMs = Date.now() - (s.updatedAt ?? 0)
    if (ageMs > MAX_AGE_DAYS * 86400_000) return null
    return {
      page: Math.round(s.page),
      scale: s.scale,
      mode: s.mode === 'dual' ? 'dual' : 'single',
      spreadOffset: s.spreadOffset === 1 ? 1 : 0,
      updatedAt: s.updatedAt ?? 0,
    }
  } catch {
    return null
  }
}

export function saveReadingState(fingerprint: string, state: Omit<ReadingState, 'updatedAt'>): void {
  if (!fingerprint) return
  try {
    localStorage.setItem(
      readingKey(fingerprint),
      JSON.stringify({ ...state, updatedAt: Date.now() } satisfies ReadingState),
    )
  } catch {
    // localStorage 满了 / 隐私模式禁用 —— 存不上就算了，不该影响阅读
  }
}

export function clearReadingState(fingerprint: string): void {
  try {
    localStorage.removeItem(readingKey(fingerprint))
  } catch {
    /* ignore */
  }
}

/** 列出所有记住的文档（给"最近阅读"用，暂时只需要数量） */
export function listReadingStates(): string[] {
  const out: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith(PREFIX)) out.push(k.slice(PREFIX.length))
    }
  } catch {
    /* ignore */
  }
  return out
}

// ---------------------------------------------------------------- 上次打开的文档

/**
 * 上次打开的那份文档。
 *
 * **为什么不能只靠上面那套阅读位置**：位置是按**内容指纹**存的 ——
 * 指纹能证明"是同一份内容"，但**找不回文件**。重开应用时没有任何东西
 * 告诉我们该去读哪个文件，所以"记住读到哪一页"和"记住是哪一本"是两件事，
 * 必须各存一份。用户的原话就是这个：*"上次阅读的位置记录下来了，
 * 但是上次阅读的 pdf 没有记录下来"*。
 *
 * ⚠️ 只有桌面端存得了：浏览器拿不到真实路径（`<input type=file>` 只给一个临时
 *    File 对象），存了也没法重开 —— 那边界面上已经写明"不能跨会话记住"。
 */
export interface LastDocument {
  /** 真实路径（桌面端） */
  path: string
  /** 文件名，恢复失败时好让用户知道是哪一个 */
  name: string
  updatedAt: number
}

const LAST_KEY = 'epl:last-doc'

export function saveLastDocument(path: string, name: string): void {
  if (!path) return
  try {
    localStorage.setItem(
      LAST_KEY,
      JSON.stringify({ path, name, updatedAt: Date.now() } satisfies LastDocument),
    )
  } catch {
    /* 存不上就算了，不该影响阅读 */
  }
}

export function loadLastDocument(): LastDocument | null {
  try {
    const raw = localStorage.getItem(LAST_KEY)
    if (!raw) return null
    const o = JSON.parse(raw) as Partial<LastDocument>
    if (typeof o.path !== 'string' || !o.path) return null
    return {
      path: o.path,
      name: typeof o.name === 'string' && o.name ? o.name : o.path,
      updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
    }
  } catch {
    return null
  }
}

/**
 * 忘掉"上次打开的文档"。
 *
 * ⚠️ 文件不在了就**一定要清掉**：不然每次启动都会去读一个不存在的路径，
 *    既白费一次 IO，也会让用户反复看到同一条提示。
 */
export function clearLastDocument(): void {
  try {
    localStorage.removeItem(LAST_KEY)
  } catch {
    /* ignore */
  }
}
