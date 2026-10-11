/**
 * 批注绘制。
 *
 * 纯函数：给定 ctx + 坐标变换 + 批注数组，画出来。
 * 不持有状态、不碰 DOM 结构 —— 这样"正在编辑的临时图形"和"已保存的批注"
 * 可以走同一条绘制路径（临时图形只是多传一个对象进数组而已）。
 *
 * 已知取舍：**这里画的是"编辑中的浮层"，不是最终效果**。
 * PDF 里已有的批注由 pdf.js 的 `AnnotationMode.ENABLE` 直接画进页面 canvas
 * （含用户以前的笔记）；本层只负责"还没写回文件的那部分"。
 * 保存后重新加载，浮层清空，改由 pdf.js 统一渲染 —— 两边外观可能有一两像素差异，
 * 这是可接受的（写回时生成的 /AP 才是权威外观）。
 *
 * ⚠️ **高亮分两层画，且必须以 alpha=1 走 Multiply**（见 `blendGroupOf`）。
 * 曾经的写法是"在字上面盖一层 alpha=0.55 的黄色半透明板" —— 结果黑字被冲成
 * 灰橄榄色，高亮反而让正文更难读。Multiply 的数学恰好是"只染背景"：
 *   白底 (1,1,1) × 黄 (1,.92,.23) = 黄  → 背景上色
 *   黑字 (0,0,0) × 黄               = 黑  → 文字一个像素都不变
 * 但前提是 **alpha 必须为 1**：alpha<1 时混合结果会在"原色"和"乘积"之间插值，
 * 字还是会被冲淡。这也是写回 PDF 时 `/AP` 用 `ca=1` 的同一个理由。
 */

import type { Annotation, Rgb } from './types'
import { isMarkup } from './types'
import type { PageTransform } from './coords'

export function rgbCss(c: Rgb, alpha = 1): string {
  const r = Math.round(c[0] * 255)
  const g = Math.round(c[1] * 255)
  const b = Math.round(c[2] * 255)
  return alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * 画一条 Z 序四边形。
 * 顶点顺序：0 左上 · 1 右上 · 2 左下 · 3 右下
 */
function traceQuad(ctx: CanvasRenderingContext2D, v: number[], i: number): void {
  ctx.moveTo(v[i]!, v[i + 1]!)
  ctx.lineTo(v[i + 2]!, v[i + 3]!)
  ctx.lineTo(v[i + 6]!, v[i + 7]!)
  ctx.lineTo(v[i + 4]!, v[i + 5]!)
  ctx.closePath()
}

/** 画一条横线：`at` 0=顶部 1=底部 0.5=中间（用于下划线/删除线） */
function strokeAcrossQuad(
  ctx: CanvasRenderingContext2D,
  v: number[],
  i: number,
  at: number,
  width: number,
): void {
  const lx = v[i]! + (v[i + 4]! - v[i]!) * at
  const ly = v[i + 1]! + (v[i + 5]! - v[i + 1]!) * at
  const rx = v[i + 2]! + (v[i + 6]! - v[i + 2]!) * at
  const ry = v[i + 3]! + (v[i + 7]! - v[i + 3]!) * at
  ctx.beginPath()
  ctx.lineWidth = width
  ctx.moveTo(lx, ly)
  ctx.lineTo(rx, ry)
  ctx.stroke()
}

/**
 * 批注该画在哪一层。
 *
 * - `under`：高亮。整层 canvas 带 `mix-blend-mode: multiply`，于是它"染背景"而不是"盖色板"。
 * - `over`：其余（下划线/删除线/手写/方框/文本框）。这些本来就该压在内容之上。
 *
 * 为什么要分层而不是整层 multiply：删除线压在黑字上时 multiply 会让线**变黑看不见**
 * （0 × 红 = 0），手写在字上同理。只有高亮是"背景"语义。
 */
export type BlendGroup = 'under' | 'over'

export function blendGroupOf(a: Annotation): BlendGroup {
  // 区域高亮同样是"背景"语义：它染的是底色，不是压在内容上
  return a.kind === 'highlight' || a.kind === 'area' ? 'under' : 'over'
}

/**
 * 把一个批注画到页内 CSS 坐标系里。
 *
 * 调用前 ctx 的变换必须已经设成 `setTransform(dpr, 0, 0, dpr, 0, 0)`
 * （即：后续所有坐标都按 CSS px 给）。
 */
export function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  tf: PageTransform,
  a: Annotation,
): void {
  const scale = tf.scale
  ctx.save()
  // 走 multiply 那层（文本高亮 / 区域高亮）靠 CSS 混合达成"只染背景"，alpha 必须满格
  ctx.globalAlpha = a.kind === 'highlight' || a.kind === 'area' ? 1 : a.opacity
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  if (isMarkup(a)) {
    const v = tf.quadsToView(a.quads)
    if (a.kind === 'highlight') {
      ctx.fillStyle = rgbCss(a.color)
      ctx.beginPath()
      for (let i = 0; i < v.length; i += 8) traceQuad(ctx, v, i)
      ctx.fill()
    } else {
      ctx.strokeStyle = rgbCss(a.color)
      // 线宽按四边形高度取比例 —— 这样在不同字号上粗细都协调
      const h0 = v.length >= 8 ? Math.abs(v[5]! - v[1]!) : 8
      const w = Math.max(1, h0 * 0.075) * (a.kind === 'strikeout' ? 1.15 : 1)
      for (let i = 0; i < v.length; i += 8) {
        strokeAcrossQuad(ctx, v, i, a.kind === 'underline' ? 0.94 : 0.5, w)
      }
    }
  } else if (a.kind === 'ink') {
    ctx.strokeStyle = rgbCss(a.color)
    ctx.lineWidth = Math.max(0.5, a.lineWidth * scale)
    for (const stroke of a.strokes) {
      const v = tf.quadsToView(stroke)
      if (v.length < 4) {
        // 单点：画个圆点，否则"点一下"什么都不出现
        if (v.length === 2) {
          ctx.beginPath()
          ctx.arc(v[0]!, v[1]!, Math.max(0.5, a.lineWidth * scale) / 2, 0, Math.PI * 2)
          ctx.fillStyle = rgbCss(a.color)
          ctx.fill()
        }
        continue
      }
      ctx.beginPath()
      ctx.moveTo(v[0]!, v[1]!)
      for (let i = 2; i < v.length; i += 2) ctx.lineTo(v[i]!, v[i + 1]!)
      ctx.stroke()
    }
  } else if (a.kind === 'area') {
    const [l, t, w, h] = tf.rectToView(a.rect)
    ctx.fillStyle = rgbCss(a.color)
    ctx.fillRect(l, t, w, h)
  } else if (a.kind === 'rect') {
    const [l, t, w, h] = tf.rectToView(a.rect)
    ctx.strokeStyle = rgbCss(a.color)
    ctx.lineWidth = Math.max(0.5, a.lineWidth * scale)
    ctx.strokeRect(l, t, w, h)
  } else if (a.kind === 'freetext') {
    const [l, t, w, h] = tf.rectToView(a.rect)
    const fs = a.fontSize * scale
    ctx.strokeStyle = rgbCss(a.color, 0.55)
    ctx.lineWidth = 1
    ctx.fillStyle = 'rgba(255,255,255,0.88)'
    ctx.beginPath()
    ctx.rect(l, t, w, h)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = rgbCss(a.color)
    ctx.font = `${fs}px "Microsoft YaHei", system-ui, sans-serif`
    ctx.textBaseline = 'top'
    const pad = Math.min(4, fs * 0.3)
    const lines = a.text.split('\n')
    lines.forEach((ln, i) => {
      ctx.fillText(ln, l + pad, t + pad + i * fs * 1.3, w - pad * 2)
    })
  }

  ctx.restore()
}

/** 一次画完一页的所有批注（含正在编辑的临时对象） */
export function drawPage(
  canvas: HTMLCanvasElement,
  tf: PageTransform,
  annotations: Annotation[],
  dpr: number,
): void {
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (!annotations.length) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  for (const a of annotations) drawAnnotation(ctx, tf, a)
}
