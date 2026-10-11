/**
 * 从浏览器选区里取出「文本高亮的四边形」。
 *
 * 这是整个批注功能里最容易出错、也最值得单独讲的一段。
 *
 * 思路：`Range.getClientRects()` 会把一段跨行的选中拆成**每行一个矩形**，
 * 这正好就是 PDF 里多行高亮需要的多个四边形。逐行把矩形转成 Z 序的四个角即可。
 *
 * 两个必须注意的点：
 *
 * 1. **顺序必须是 Z 序**（左上→右上→左下→右下）。
 *    实测过：逆时针顺序在 Edge 里会**错位**（P2 正常 / P3 错位）。
 *    ISO 的措辞容易被读成逆时针，别照着写。
 *
 * 2. **转页面坐标时 y 会翻转**，所以「左上角」在页面空间里 y 更大。
 *    不能想当然地把 `top` 当 y 小的一边 —— 必须两个角点各自过一遍
 *    `convertToPdfPoint`，不能手算。
 */

import type { PageTransform } from './coords'

export interface HarvestResult {
  /** Z 序四边形，页面坐标，每 8 个数一个 */
  quads: number[]
  /** 覆盖的原文（存进 /Contents 与批注列表） */
  text: string
  /** 页面空间包围盒 */
  rect: [number, number, number, number]
}

/**
 * 读取当前选区并转成本页的四边形。
 * 选区不在 `slotEl` 内、或为空时返回 null。
 */
export function harvestSelection(
  slotEl: HTMLElement,
  tf: PageTransform,
): HarvestResult | null {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null

  const range = sel.getRangeAt(0)
  const text = sel.toString()
  if (!text.trim()) return null

  // 选区必须整体落在本页里
  if (!slotEl.contains(range.commonAncestorContainer)) return null

  const slotRect = slotEl.getBoundingClientRect()
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5)
  if (!rects.length) return null

  const quads: number[] = []
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const r of rects) {
    const l = r.left - slotRect.left
    const t = r.top - slotRect.top
    const rr = r.right - slotRect.left
    const b = r.bottom - slotRect.top
    if (rr <= l || b <= t) continue

    const tl = tf.toPage(l, t)
    const tr = tf.toPage(rr, t)
    const bl = tf.toPage(l, b)
    const br = tf.toPage(rr, b)

    // Z 序：左上 → 右上 → 左下 → 右下
    quads.push(tl[0], tl[1], tr[0], tr[1], bl[0], bl[1], br[0], br[1])

    for (const p of [tl, tr, bl, br]) {
      if (p[0] < minX) minX = p[0]
      if (p[0] > maxX) maxX = p[0]
      if (p[1] < minY) minY = p[1]
      if (p[1] > maxY) maxY = p[1]
    }
  }

  if (!quads.length) return null
  return { quads, text, rect: [minX, minY, maxX, maxY] }
}

/**
 * 高亮矩形常常比文字行高略窄（`getClientRects` 给的是行盒）。
 * 稍微上下撑开一点，看起来更接近 Edge 的高亮观感。
 */
export function expandQuadsVertically(quads: number[], padPt: number): number[] {
  if (padPt <= 0) return quads
  const out = quads.slice()
  for (let i = 0; i < out.length; i += 8) {
    // Z 序：0/2 是上方两点，4/6 是下方两点
    out[i + 1] = out[i + 1]! + padPt
    out[i + 3] = out[i + 3]! + padPt
    out[i + 5] = out[i + 5]! - padPt
    out[i + 7] = out[i + 7]! - padPt
  }
  return out
}

/** 清掉当前选区（创建完高亮之后调，避免蓝底一直挂着） */
export function clearSelection(): void {
  window.getSelection()?.removeAllRanges()
}
