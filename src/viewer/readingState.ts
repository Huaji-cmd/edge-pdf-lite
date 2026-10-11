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
