#!/usr/bin/env node
/**
 * 「高亮该怎么写才能**不盖住文字**」对照样本。
 *
 * 起因（实测）：写回的高亮在我们自己的渲染（pdf.js）里用 Multiply 混合、文字透出来；
 * 但拿同一份文件到 **Edge 内置查看器（PDFium）** 里看，那条高亮是**实心色块、文字看不见**。
 * 于是一个必须回答的问题：高亮的 /AP 到底该不该给？给的话怎么给？
 *
 * 四种写法放在同一页，肉眼一比就有答案：
 *   V1  /AP + ExtGState /BM /Multiply + ca=1     ← 当前实现
 *   V2  /AP 普通填充（不透明，盖住文字）
 *   V3  **不给 /AP**，只给 /QuadPoints + /C + /CA  ← 交给查看器自己画
 *   V4  /AP + Multiply 但 **ca=0.55**（alpha 不满格）
 *
 * V4 是专门加的一行：它是"用户在阅读器里看到高亮把字染灰了"的根因 ——
 * Multiply 本身只染背景（黑 × 任何色 = 黑），但一旦 ca<1，混合结果就会在
 * "原色"和"乘积"之间插值，黑字被拉向高亮色 → 看起来就是"蒙了层半透明的板"。
 *
 * 输出：public/testdata/hl-variants.pdf
 * 用法：node scripts/make-highlight-variants.mjs
 *       node scripts/edge-pdf-shot.mjs public/testdata/hl-variants.pdf
 */
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { PDFDocument, PDFName, PDFString, StandardFonts, rgb } = require('@cantoo/pdf-lib')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public', 'testdata', 'hl-variants.pdf')

const W = 595.28
const H = 841.89
const AUTHOR = 'edge-pdf-lite'

const pdf = await PDFDocument.create()
const font = await pdf.embedFont(StandardFonts.Helvetica)
const page = pdf.addPage([W, H])

const ROWS = [
  { key: 'V1', note: '/AP + /BM /Multiply, ca=1      (当前实现 — 只染背景)', y: 700 },
  { key: 'V4', note: '/AP + Multiply 但 ca=0.55     (alpha 不满格 — 字被冲淡)', y: 640, ca: 0.55 },
  { key: 'V2', note: '/AP 普通填充（不透明 — 把文字整片盖住）', y: 580 },
  { key: 'V3', note: '不给 /AP，只给 QuadPoints + /C + /CA', y: 520 },
]

page.drawText('Highlight appearance variants — which one keeps the text readable?', {
  x: 40,
  y: 780,
  size: 12,
  font,
  color: rgb(0.1, 0.1, 0.1),
})
page.drawText('在 Edge / Acrobat / 我们的阅读器里各看一遍：文字还在不在？', {
  x: 40,
  y: 760,
  size: 10,
  font,
  color: rgb(0.4, 0.4, 0.4),
})

const annots = []
for (const row of ROWS) {
  const text = `${row.key}  —  THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG 12345`
  page.drawText(text, { x: 44, y: row.y, size: 11, font, color: rgb(0, 0, 0) })
  page.drawText(row.note, { x: 44, y: row.y - 20, size: 8, font, color: rgb(0.45, 0.45, 0.45) })

  const w = font.widthOfTextAtSize(text, 11)
  const x0 = 42
  const x1 = 42 + w + 4
  const yBottom = row.y - 3
  const yTop = row.y + 11
  const rect = [x0, yBottom, x1, yTop]
  // Z 序：左上 → 右上 → 左下 → 右下
  const quads = [x0, yTop, x1, yTop, x0, yBottom, x1, yBottom]

  const dict = {
    Type: 'Annot',
    Subtype: 'Highlight',
    Rect: rect,
    QuadPoints: quads,
    C: [1, 0.92, 0.23],
    // 整条注释的 alpha。**必须 1**：<1 时查看器会在 /AP 之上再叠一层半透明，
    // 即使 /AP 内部是 Multiply，字也会被拉向高亮色（V4 那行就是 0.55 的效果）。
    CA: row.ca ?? 1,
    F: 4,
    Contents: PDFString.of(`${row.key}: ${row.note}`),
    T: PDFString.of(AUTHOR),
    M: PDFString.of('D:20261011130000+08\'00\''),
    NM: PDFString.of(`epl:variant-${row.key}`),
  }

  if (row.key !== 'V3') {
    const useMultiply = row.key === 'V1' || row.key === 'V4'
    const gsRef = useMultiply
      ? pdf.context.register(pdf.context.obj({ BM: 'Multiply', ca: row.ca ?? 1, CA: row.ca ?? 1 }))
      : null
    // 注释空间坐标：原点 = /Rect 左下角
    const content =
      `q\n${useMultiply ? '/GS_HL gs\n' : ''}1 0.92 0.23 rg\n` +
      `0 0 ${x1 - x0} ${yTop - yBottom} re\nf\nQ\n`
    const stream = pdf.context.stream(content, {
      Type: 'XObject',
      Subtype: 'Form',
      FormType: 1,
      BBox: [0, 0, x1 - x0, yTop - yBottom],
      // 单位矩阵 —— 由查看器把 bbox 映射到 /Rect
      Matrix: [1, 0, 0, 1, 0, 0],
      ...(gsRef ? { Resources: { ExtGState: { GS_HL: gsRef } } } : {}),
    })
    dict.AP = { N: pdf.context.register(stream) }
  }

  annots.push(pdf.context.register(pdf.context.obj(dict)))
}

const arr = pdf.context.obj([])
for (const a of annots) arr.push(a)
page.node.set(PDFName.of('Annots'), pdf.context.register(arr))

// ---------------------------------------------------------------- 第二页：手写（Ink）的三种写法
const page2 = pdf.addPage([W, H])
page2.drawText('Ink variants — which one does the viewer actually draw?', {
  x: 40,
  y: 780,
  size: 12,
  font,
  color: rgb(0.1, 0.1, 0.1),
})
page2.drawText('I1 = /AP（页面坐标换算到注释空间）· I2 = 不给 /AP · I3 = /AP 但点写成相对 Rect 的坐标（错的写法）', {
  x: 40,
  y: 760,
  size: 9,
  font,
  color: rgb(0.4, 0.4, 0.4),
})

/** 一条波浪线（页面坐标） */
function wave(yBase) {
  const pts = []
  for (let i = 0; i <= 40; i++) pts.push(80 + i * 8, yBase + Math.sin(i / 3) * 18)
  return pts
}

const INK_ROWS = [
  { key: 'I1', y: 660, mode: 'ap', note: '/AP，注释空间坐标（当前实现）' },
  { key: 'I2', y: 540, mode: 'none', note: '不给 /AP，让查看器拿 InkList 自己画' },
  { key: 'I3', y: 420, mode: 'badmatrix', note: '/AP 用 Matrix 自己平移（方案 v1 的错法 → 双重偏移）' },
]

const grid2 = []

for (const row of INK_ROWS) {
  const pts = wave(row.y)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < pts.length; i += 2) {
    minX = Math.min(minX, pts[i])
    maxX = Math.max(maxX, pts[i])
    minY = Math.min(minY, pts[i + 1])
    maxY = Math.max(maxY, pts[i + 1])
  }
  const pad = 3
  const rect = [minX - pad, minY - pad, maxX + pad, maxY + pad]

  page2.drawText(`${row.key}  ${row.note}`, {
    x: 40,
    y: row.y + 40,
    size: 9,
    font,
    color: rgb(0.35, 0.35, 0.35),
  })

  const dict = {
    Type: 'Annot',
    Subtype: 'Ink',
    Rect: rect,
    // ⚠️ InkList 一定是**页面坐标**（default user space）
    InkList: [pts],
    C: [0.9, 0.19, 0.19],
    F: 4,
    BS: { W: 2, S: 'S' },
    Contents: PDFString.of(`ink variant ${row.key}`),
    T: PDFString.of(AUTHOR),
    M: PDFString.of('D:20261011130000+08\'00\''),
    NM: PDFString.of(`epl:ink-${row.key}`),
  }

  if (row.mode !== 'none') {
    const [x0, y0] = [rect[0], rect[1]]
    // 'badmatrix'：内容流仍然写**页面坐标**，另外用 Matrix 平移 —— 查看器还会自己
    // 做一次 bbox→Rect 的映射，于是双重偏移（这就是方案 v1 犯的错）
    const shift = row.mode === 'badmatrix'
    let path = 'q\n0.9 0.19 0.19 RG\n2 w\n1 J\n1 j\n'
    for (let i = 0; i < pts.length; i += 2) {
      const x = shift ? pts[i] : pts[i] - x0
      const y = shift ? pts[i + 1] : pts[i + 1] - y0
      path += i === 0 ? `${x} ${y} m\n` : `${x} ${y} l\n`
    }
    path += 'S\nQ\n'
    const stream = pdf.context.stream(path, {
      Type: 'XObject',
      Subtype: 'Form',
      FormType: 1,
      BBox: [0, 0, rect[2] - x0, rect[3] - y0],
      Matrix: shift ? [1, 0, 0, 1, -x0, -y0] : [1, 0, 0, 1, 0, 0],
    })
    dict.AP = { N: pdf.context.register(stream) }
  }

  grid2.push(pdf.context.register(pdf.context.obj(dict)))
}

// 第二页的 /Annots
{
  const arr2 = pdf.context.obj([])
  for (const a of grid2) arr2.push(a)
  page2.node.set(PDFName.of('Annots'), pdf.context.register(arr2))
}

const bytes = await pdf.save({ useObjectStreams: false })
await mkdir(dirname(OUT), { recursive: true })
await writeFile(OUT, bytes)
console.log(`已生成 ${OUT}`)
console.log('  接下来：node scripts/edge-pdf-shot.mjs public/testdata/hl-variants.pdf')
