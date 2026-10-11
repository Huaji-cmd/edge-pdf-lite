/**
 * 坐标换算：PDF 页面空间 ↔ 页内 CSS 像素。
 *
 * **为什么统一走 pdf.js 的 viewport，而不是自己算 `y = pageHeight - y`：**
 * 那个简化公式只在"页面无旋转、CropBox 从原点开始"时成立。真实 PDF 里
 * 旋转页（`/Rotate 90/270`）很常见 —— 一旦有旋转，简单的上下翻转就会
 * 把批注画到完全错误的位置。`viewport.convertToViewportPoint` 已经把
 * 旋转 / CropBox 偏移 / scale 全考虑进去了，用它就是对的。
 *
 * 三个坐标系（别混）：
 *   · **页面空间** —— PDF 用户空间，原点左下，单位 pt。**批注数据一律存这个**。
 *   · **页内 CSS** —— 相对页元素左上角，单位 CSS px，已乘 scale。画 overlay 用这个。
 *   · **视口 CSS** —— 相对滚动容器。只在处理鼠标事件时短暂用到。
 *
 * 好在第二、三个是同一个原点（viewport 的原点就是页面左上角），
 * 所以 `convertToViewportPoint` 的输出可以直接当"页内 CSS"用。
 */

import type { PageViewport } from '@/pdfjs'

export class PageTransform {
  constructor(readonly viewport: PageViewport) {}

  get scale(): number {
    return this.viewport.scale
  }

  /** 页内 CSS 尺寸（= 页面尺寸 × scale） */
  get cssWidth(): number {
    return this.viewport.width
  }

  get cssHeight(): number {
    return this.viewport.height
  }

  /** 页面空间 → 页内 CSS */
  toView(x: number, y: number): [number, number] {
    const p = this.viewport.convertToViewportPoint(x, y) as number[]
    return [p[0]!, p[1]!]
  }

  /** 页内 CSS → 页面空间 */
  toPage(cssX: number, cssY: number): [number, number] {
    const p = this.viewport.convertToPdfPoint(cssX, cssY) as number[]
    return [p[0]!, p[1]!]
  }

  /** 批量转四边形（保持顺序，Z 序进 Z 序出） */
  quadsToView(quads: number[]): number[] {
    const out = new Array<number>(quads.length)
    for (let i = 0; i < quads.length; i += 2) {
      const p = this.toView(quads[i]!, quads[i + 1]!)
      out[i] = p[0]
      out[i + 1] = p[1]
    }
    return out
  }

  /** 批量转笔画（与 quads 同构，只是可读性更好） */
  strokesToView(strokes: number[][]): number[][] {
    return strokes.map((s) => this.quadsToView(s))
  }

  /** 把一个页面空间矩形转成页内 CSS 的 `[left, top, width, height]` */
  rectToView(rect: readonly [number, number, number, number]): [number, number, number, number] {
    const [x0, y0, x1, y1] = rect
    // 注意：y 轴方向翻转，所以用两个角点各自转换再取 min/max，别假设 y0<y1
    const a = this.toView(x0, y0)
    const b = this.toView(x1, y1)
    const left = Math.min(a[0], b[0])
    const top = Math.min(a[1], b[1])
    return [left, top, Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])]
  }
}

/** 鼠标/触摸事件 → 页内 CSS 坐标 */
export function eventToPageCss(
  e: { clientX: number; clientY: number },
  slotEl: HTMLElement,
): [number, number] {
  const r = slotEl.getBoundingClientRect()
  return [e.clientX - r.left, e.clientY - r.top]
}

/**
 * 把一条笔画按"最小间距"抽稀。
 *
 * 手写时 pointermove 可能一秒来 100+ 个点，原样存会让 InkList 变得很大
 * （写回文件、重绘都变慢），而人手的精度远没那么高。
 */
export function simplifyStroke(points: number[], minDist = 1.4): number[] {
  if (points.length <= 4) return points.slice()
  const out: number[] = [points[0]!, points[1]!]
  let lastX = points[0]!
  let lastY = points[1]!
  for (let i = 2; i < points.length; i += 2) {
    const x = points[i]!
    const y = points[i + 1]!
    if (Math.hypot(x - lastX, y - lastY) >= minDist) {
      out.push(x, y)
      lastX = x
      lastY = y
    }
  }
  // 末点必须保留，否则笔画会"缩水"
  const n = points.length
  if (out[out.length - 2] !== points[n - 2] || out[out.length - 1] !== points[n - 1]) {
    out.push(points[n - 2]!, points[n - 1]!)
  }
  return out
}
