/**
 * 用户设置：保存方式 / 保存位置 / 主题。
 *
 * 三条设计约定：
 *
 * 1. **存 localStorage 而不是 Tauri 的文件** —— 设置就 3 个值，
 *    没必要为此引入一套文件读写；而且浏览器版要共用同一份代码。
 *
 * 2. **默认值是"什么都不写"** —— `saveDir` 为空串表示"用默认目录"。
 *    这样默认目录将来改了（比如换到文档库），老用户也会跟着走，
 *    而不是被钉死在第一次运行时算出来的那个路径上。
 *
 * 3. **`theme: 'system'` 不落到 DOM** —— CSS 只认 light / dark。
 *    解析在 JS 里做，这样"未定"状态不需要 CSS 处理。
 */

import { ref, watch } from 'vue'
import { IS_TAURI } from '@/platform'

/** 保存方式：另存一份到指定目录 / 直接覆盖原文件 */
export type SaveMode = 'copy' | 'overwrite'

/** 主题：跟随系统 / 日间 / 夜间 */
export type ThemeMode = 'system' | 'light' | 'dark'

export interface Settings {
  /** 默认 `copy`：覆盖原文件不可逆，不该是默认行为 */
  saveMode: SaveMode
  /** 另存的目录。空串 = 用默认目录（由 Rust 侧算，见 defaultSaveDir） */
  saveDir: string
  theme: ThemeMode
}

const KEY = 'epl.settings.v1'

const DEFAULTS: Settings = {
  saveMode: 'copy',
  saveDir: '',
  theme: 'system',
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const o = JSON.parse(raw) as Partial<Settings>
    return {
      // ⚠️ 逐字段兜底：老版本存的 JSON 可能缺字段，直接展开会把新字段变成 undefined
      saveMode: o.saveMode === 'overwrite' ? 'overwrite' : 'copy',
      saveDir: typeof o.saveDir === 'string' ? o.saveDir : '',
      theme: o.theme === 'light' || o.theme === 'dark' ? o.theme : 'system',
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export const settings = ref<Settings>(load())

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings.value))
  } catch {
    /* 隐私模式下写不进去 —— 设置丢了还能用，不该因此崩掉 */
  }
}

/** 改任何一项都会立刻落盘（设置不需要"取消"，改了就是改了） */
watch(settings, persist, { deep: true })

// ---------------------------------------------------------------- 主题

/** 系统偏好（只在 theme==='system' 时才有意义） */
const systemDark = ref(
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : true,
)

if (typeof window !== 'undefined' && window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  // 旧 Safari 只有 addListener
  const onChange = (e: MediaQueryListEvent | MediaQueryList): void => {
    systemDark.value = 'matches' in e ? e.matches : false
  }
  if (mq.addEventListener) mq.addEventListener('change', onChange as EventListener)
  else mq.addListener(onChange as (e: MediaQueryListEvent) => void)
}

/** 实际生效的主题（'system' 已解析掉） */
function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  return mode === 'system' ? (systemDark.value ? 'dark' : 'light') : mode
}

export function applyTheme(): void {
  const t = resolveTheme(settings.value.theme)
  document.documentElement.dataset.theme = t
  // 让滚动条、下拉框这些浏览器自带的部件也跟着换
  document.documentElement.style.colorScheme = t
}

export function setTheme(mode: ThemeMode): void {
  settings.value = { ...settings.value, theme: mode }
  applyTheme()
}

/** 初始化时调一次；之后 system 模式要跟着系统变 */
export function initTheme(): void {
  applyTheme()
  watch([systemDark, () => settings.value.theme], applyTheme)
}

// ---------------------------------------------------------------- 保存位置

/**
 * 另存的目录。
 *
 * 桌面端：用户没指定就问 Rust 要默认目录（文档库/edge-pdf-lite/save）。
 * 浏览器端：没有"目录"这个概念，返回空串 —— 上层据此退回浏览器下载。
 */
export async function resolveSaveDir(): Promise<string> {
  if (settings.value.saveDir) return settings.value.saveDir
  if (!IS_TAURI) return ''
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return (await invoke<string>('default_save_dir')) ?? ''
  } catch {
    return ''
  }
}

/** 让用户挑一个目录（桌面端才有；网页上返回 null） */
export async function pickSaveDir(): Promise<string | null> {
  if (!IS_TAURI) return null
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const picked = await open({ directory: true, multiple: false, title: '选择一个保存目录' })
    return typeof picked === 'string' ? picked : null
  } catch {
    return null
  }
}

/** 在文件管理器里显示这个文件（桌面端才有） */
export async function revealInFolder(path: string): Promise<boolean> {
  if (!IS_TAURI) return false
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('reveal_in_folder', { path })
    return true
  } catch {
    return false
  }
}
