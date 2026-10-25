/**
 * 界面状态记忆：侧边栏**开着没有**、停在**哪个面板**。
 *
 * 和 `settings.ts` 的区别要说清楚，否则以后会有人把两者合并：
 *   · `settings` 是**用户偏好** —— 他在设置面板里主动选的东西（主题、保存方式）；
 *   · 这里是**上次离开时的样子** —— 用户从没"设置"过它，只是希望重开还是那样。
 * 混在一起写会让"重置设置"把布局也一起重置，那不是用户想要的。
 *
 * 三条约定：
 *
 * 1. **只存布尔和枚举**，不存像素尺寸。窗口大小、DPI 都可能变，存下来的
 *    宽高在新环境里往往毫无意义（而且会把窗口撑出屏幕）。
 *
 * 2. **`settings` 面板不记**。重开应用停在"设置"页会让人以为程序出了问题；
 *    真从设置里退出的用户，想要的也是它背后那个面板（`panelBeforeSettings`）。
 *
 * 3. **只恢复 `files` / `search`**。启动时**一份文档都还没打开**，
 *    大纲和缩略图没有内容可显示 —— 恢复过去就是一面空白，比回到文件列表更糟。
 *    （文档打开之后用户切到大纲，那是"当场状态"，不需要跨启动记住。）
 *
 * 4. 脏数据一律回落到默认值。一段手改坏的 localStorage 不该让界面变成空白
 *    —— 顶多丢掉一次记忆。
 */

import type { SidePanelKind } from './types'

/** 可以被恢复的面板：启动时不需要文档的那两个 */
export type RestorablePanel = 'files' | 'search'

export interface UiState {
  /** 侧边栏是否展开 */
  sideOpen: boolean
  /** 侧边栏停在哪个面板 */
  panel: RestorablePanel
}

const KEY = 'epl:ui-state'

/** 默认 = 收起 + 文件列表（跟 Obsidian 一样，先从列表挑书） */
const DEFAULTS: UiState = { sideOpen: false, panel: 'files' }

function normalizePanel(v: unknown): RestorablePanel {
  // `outline` / `thumbs` / `settings` 在这里全部落回 files —— 理由见文件头第 3 条
  return v === 'search' ? 'search' : 'files'
}

export function loadUiState(): UiState {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const o = JSON.parse(raw) as Partial<UiState>
    return {
      // ⚠️ 逐字段兜底：老版本存的 JSON 可能缺字段，直接展开会把新字段变成 undefined
      sideOpen: o.sideOpen === true,
      panel: normalizePanel(o.panel),
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveUiState(state: UiState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* 隐私模式 / 配额满 —— 记不住就记不住，不该影响阅读 */
  }
}

/**
 * 这次的面板值**值不值得记**。
 *
 * `files` / `search` 能跨启动恢复；`outline` / `thumbs` 需要文档，启动时恢复过去
 * 只会是一面空白 —— 返回 `null` 表示"别用它覆盖上次记住的值"，
 * 这样"昨天停在搜索、今天顺手点了一下大纲就退出"不会把搜索的记忆冲掉。
 *
 * 导出这个小函数是为了让调用方（App.vue）不必重复这套规则 ——
 * 面板一旦新增（比如以后加"历史"），只改这里。
 */
export function restorablePanel(
  panel: SidePanelKind,
  beforeSettings: SidePanelKind,
): RestorablePanel | null {
  const p = panel === 'settings' ? beforeSettings : panel
  return p === 'files' || p === 'search' ? p : null
}
