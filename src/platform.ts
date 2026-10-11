/**
 * 运行环境判定。
 *
 * 同一套代码要同时跑在两个地方：
 * - **打包成 exe（Tauri）**：能拿到文件真实路径、能控制窗口
 * - **浏览器**：什么都拿不到（`<input type=file>` 只给一个临时 File 对象），
 *   也没有"窗口"这个概念 —— 最小化/最大化/关闭由浏览器自己管
 *
 * 所以凡是"只有 exe 才有意义"的功能，都要先问这里，而不是假定能用。
 * ⚠️ 判断依据必须是运行时特征，不能用 `import.meta.env.PROD` 之类 ——
 *    dev 模式下也能跑在 Tauri 里，生产模式下也可能只是普通网页。
 */

/** 是否运行在 Tauri（打包后的桌面应用）里 */
export const IS_TAURI: boolean = (() => {
  if (typeof globalThis === 'undefined') return false
  const w = globalThis as unknown as Record<string, unknown>
  // Tauri v2 挂 __TAURI_INTERNALS__，v1 挂 __TAURI__；两个都认，兼容升级
  return '__TAURI_INTERNALS__' in w || '__TAURI__' in w
})()

/** 是否为触屏设备（用于决定按钮尺寸、手势提示） */
export const IS_TOUCH: boolean = (() => {
  if (typeof globalThis === 'undefined' || typeof window === 'undefined') return false
  return (
    'ontouchstart' in window ||
    (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
  )
})()
