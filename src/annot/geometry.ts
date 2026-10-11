/**
 * 批注几何变换：平移 / 缩放。
 *
 * 为什么单独成文件：这是"选中批注后拖动、拉手柄"这条新交互的全部数学，
 * 而它有个容易写错的地方 —— **高亮类批注不只有 rect，还有 quads（每个字一行四边形）**。
 * 只改 rect 不改 quads，视觉上就是"框动了、黄底没动"，而且写回 PDF 后
 * `/Rect` 和 `/QuadPoints` 会不一致（严格查看器按 /Rect 裁 /AP → 高亮被截断）。
 *
 * 所以这里的做法是**统一的**：把 from 框线性映射到 to 框，
 * 批注里所有坐标（quads / strokes / rect）一起走同一个映射。
 */

import type { Annotation, Rect } from './types'
import { isMarkup, bboxOfQuads, bboxOfPoints, normalizeRect } from './types'

/** 8 个控制手柄。命名用**屏幕方向**（n=上），但 rect 的 y 轴是**向上**的，换算时别弄反 */
export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export const HANDLES: readonly HandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** 最小尺寸（pt）—— 再小就拖不动也点不中了 */
export const MIN_SIZE = 6

/**
 * 按手柄拖动一个矩形。
 *
 * ⚠️ y 轴向上：屏幕上的「上」(n) 对应 rect 的 **y1**（较大值），不是 y0。
 * 第一次写反会导致"往上拖结果框往下长"，而且只在拖动时可见，很容易漏掉。
 */
export function resizeRect(r: Rect, h: HandleId, dx: number, dy: number): Rect {
  let x0 = r[0]
  let y0 = r[1]
  let x1 = r[2]
  let y1 = r[3]
  if (h.includes('w')) x0 += dx
  if (h.includes('e')) x1 += dx
  if (h.includes('n')) y1 += dy
  if (h.includes('s')) y0 += dy

  // 拖过头会翻转。夹住而不是让它翻 —— 翻转后的 rect 会让 bbox 计算和 /AP 都变味
  if (x1 - x0 < MIN_SIZE) {
    if (h.includes('w')) x0 = x1 - MIN_SIZE
    else x1 = x0 + MIN_SIZE
  }
  if (y1 - y0 < MIN_SIZE) {
    if (h.includes('s')) y0 = y1 - MIN_SIZE
    else y1 = y0 + MIN_SIZE
  }
  return [x0, y0, x1, y1]
}

export function translateRect(r: Rect, dx: number, dy: number): Rect {
  return [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]
}

/**
 * 把批注从 from 框**整体线性映射**到 to 框。
 *
 * `from` 必须是变换前的真实包围盒（通常就是 `a.rect`），否则会整体漂移。
 * 平移就是 `to = from + (dx, dy)`，缩放就是任意 from→to。
 */
export function mapAnnotToRect(a: Annotation, from: Rect, to: Rect): Annotation {
  const w0 = from[2] - from[0]
  const h0 = from[3] - from[1]
  const sx = Math.abs(w0) < 1e-6 ? 1 : (to[2] - to[0]) / w0
  const sy = Math.abs(h0) < 1e-6 ? 1 : (to[3] - to[1]) / h0
  if (sx === 1 && sy === 1 && from[0] === to[0] && from[1] === to[1]) return a

  const mx = (x: number): number => to[0] + (x - from[0]) * sx
  const my = (y: number): number => to[1] + (y - from[1]) * sy

  if (isMarkup(a)) {
    const quads = a.quads.slice()
    for (let i = 0; i < quads.length; i += 2) {
      quads[i] = mx(quads[i]!)
      quads[i + 1] = my(quads[i + 1]!)
    }
    // ⚠️ rect 必须跟着 quads 重算 —— 它是所有四边形的包围盒，
    // 写回 PDF 后查看器按 /Rect 裁 /AP，不一致就会"高亮被截断"
    return { ...a, quads, rect: bboxOfQuads(quads) }
  }

  if (a.kind === 'ink') {
    const strokes = a.strokes.map((s) => {
      const o = s.slice()
      for (let i = 0; i < o.length; i += 2) {
        o[i] = mx(o[i]!)
        o[i + 1] = my(o[i + 1]!)
      }
      return o
    })
    const all: number[] = []
    for (const s of strokes) for (const v of s) all.push(v)
    return { ...a, strokes, rect: bboxOfPoints(all, a.lineWidth / 2 + 0.5) }
  }

  // rect / freetext：本体就是 rect，直接换（字号/线宽保持不变 —— PDF 的 FreeText
  // 也不会因为框变大就把字撑大，保持与写回后一致）
  return { ...a, rect: normalizeRect(to) }
}

export function translateAnnot(a: Annotation, dx: number, dy: number): Annotation {
  return mapAnnotToRect(a, a.rect, translateRect(a.rect, dx, dy))
}
