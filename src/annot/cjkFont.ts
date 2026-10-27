/**
 * 系统中文字体 —— 「把中文画进 PDF」唯一的前提。
 *
 * ## 为什么需要
 *
 * PDF 的标准 14 字体（Helvetica / Times …）**没有 CJK 字形**。往 `/AP` 里硬写中文，
 * 结果只有两种：乱码，或者一整片豆腐块 / 灰条。想真的画出中文，就必须把字体**嵌入**。
 *
 * ## 字体从哪来
 *
 * **运行时从系统读**（`%WINDIR%\Fonts\simhei.ttf` 等），不打包进安装包：
 *    · 完整中文字体 10 MB 左右，跟"lite"的定位冲突；
 *    · 用户机器上本来就有（Windows 从 Vista 起都带黑体）。
 *
 * 读进来之后由 pdf-lib 做**子集化**：最终写出的 PDF 只带用到的那几十个字，
 * 实测一份三行中文的 PDF 只多 ~3 KB。所以"嵌入字体"不会让文件变大。
 *
 * ## 拿不到会怎样
 *
 * **浏览器版**（没有 Tauri、读不到系统字体）返回 `null`，writer 会退回"占位横线"。
 * 那不是静默降级 —— 调用方（`App.exportAnnotated`）会弹提示告诉用户去用桌面版。
 *
 * ⚠️ 缓存 Promise 而不是结果：并发调用（连点两次保存）只会读一次磁盘。
 */

import { IS_TAURI } from '@/platform'

let pending: Promise<Uint8Array | null> | null = null

/** 读一份可用的中文字体；拿不到返回 `null`（**不抛异常**，调用方按降级处理） */
export function loadCjkFont(): Promise<Uint8Array | null> {
  if (!pending) pending = fetchFont()
  return pending
}

/** 测试 / 换机器时把缓存清掉（正常路径不需要） */
export function resetCjkFontCache(): void {
  pending = null
}

async function fetchFont(): Promise<Uint8Array | null> {
  if (!IS_TAURI) return null
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    /*
     * Rust 侧用 `tauri::ipc::Response` 返回**原始字节**，前端拿到的是 ArrayBuffer。
     * 但同一个 bug 修过两次（`readBytesByPath` 那边），所以这里把三种形态都接住 ——
     * 真退化成数组时也不能悄悄返回 null。
     */
    const raw = await invoke<ArrayBuffer | Uint8Array | number[]>('read_system_font')
    if (raw instanceof ArrayBuffer) return raw.byteLength ? new Uint8Array(raw) : null
    if (raw instanceof Uint8Array) return raw.length ? raw : null
    if (Array.isArray(raw)) return raw.length ? Uint8Array.from(raw) : null
    return null
  } catch (e) {
    // 读不到不是错误（老系统 / 精简版 Windows 可能真的没有这些字体）——
    // 降级成占位横线，让保存流程继续走完
    console.warn('[cjk] 读系统字体失败，中文文本框将退回占位横线：', e)
    return null
  }
}
