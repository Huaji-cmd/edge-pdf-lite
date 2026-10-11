// 生成基准测试用的 PDF 语料（纯文字 / 图表两类），供性能实验使用。
// 用法：node scripts/make-testdata.mjs
import { PDFDocument, StandardFonts, rgb } from '@cantoo/pdf-lib'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 放进 public/ 是为了让 spike 页面能直接按 URL 取到样本，方便复现实验
const outDir = resolve(root, 'public/testdata')

const LOREM = [
  'A PDF viewer must render pages at the resolution the display actually has.',
  'Rasterizing a whole page at high zoom is what makes viewers stutter.',
  'Clipping the render to the visible region keeps the cost flat.',
  'Annotation dictionaries describe what a mark is, not how to paint it.',
  'The appearance stream is what every conforming reader actually paints.',
  'QuadPoints are ordered in Z order by most viewers, not counter-clockwise.',
  'Incremental save appends a new revision instead of rewriting the file.',
  'Text layers must share the exact viewport transform as the canvas.',
]

/** 纯文字页 */
async function makeTextPdf(path, pages) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)

  for (let p = 1; p <= pages; p++) {
    const page = doc.addPage([595.28, 841.89]) // A4
    const { height } = page.getSize()
    page.drawText(`Section ${p}`, {
      x: 56,
      y: height - 80,
      size: 20,
      font: bold,
      color: rgb(0.1, 0.1, 0.1),
    })
    let y = height - 120
    for (let i = 0; i < 34; i++) {
      const line = LOREM[(i + p) % LOREM.length]
      page.drawText(`${line} (p${p}-${i})`, {
        x: 56,
        y,
        size: 9.5,
        font,
        color: rgb(0.15, 0.15, 0.18),
      })
      y -= 15
    }
    page.drawText(`— page ${p} of ${pages} —`, {
      x: 56,
      y: 40,
      size: 9,
      font,
      color: rgb(0.5, 0.5, 0.5),
    })
  }

  const bytes = await doc.save()
  await writeFile(path, bytes)
  return bytes.length
}

/** 矢量密集页：大量线条与圆，模拟图表/工程图，用来暴露 JS 栅格化的短板 */
async function makeVectorPdf(path, pages) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)

  for (let p = 1; p <= pages; p++) {
    const page = doc.addPage([595.28, 841.89])
    const { width, height } = page.getSize()
    page.drawText(`Vector-heavy chart ${p}`, {
      x: 40,
      y: height - 50,
      size: 14,
      font,
      color: rgb(0, 0, 0),
    })
    // 网格
    for (let i = 0; i <= 60; i++) {
      const x = 40 + (i * (width - 80)) / 60
      page.drawLine({
        start: { x, y: 80 },
        end: { x, y: height - 90 },
        thickness: 0.4,
        color: rgb(0.75, 0.78, 0.85),
      })
    }
    for (let i = 0; i <= 80; i++) {
      const y = 80 + (i * (height - 170)) / 80
      page.drawLine({
        start: { x: 40, y },
        end: { x: width - 40, y },
        thickness: 0.4,
        color: rgb(0.75, 0.78, 0.85),
      })
    }
    // 折线 + 散点
    for (let s = 0; s < 12; s++) {
      let px = 40
      let py = 120 + s * 50
      for (let k = 0; k < 90; k++) {
        const nx = px + 5.5
        const ny = py + Math.sin((k + s * 7 + p) * 0.35) * 26
        page.drawLine({
          start: { x: px, y: py },
          end: { x: nx, y: ny },
          thickness: 1.1,
          color: rgb(0.15 + s * 0.05, 0.3, 0.7 - s * 0.03),
        })
        px = nx
        py = ny
      }
      for (let k = 0; k < 60; k++) {
        page.drawCircle({
          x: 40 + Math.random() * (width - 80),
          y: 80 + Math.random() * (height - 170),
          size: 1.6,
          color: rgb(0.8, 0.2, 0.25),
        })
      }
    }
  }

  const bytes = await doc.save()
  await writeFile(path, bytes)
  return bytes.length
}

await mkdir(outDir, { recursive: true })

const jobs = [
  ['sample-text-20p.pdf', () => makeTextPdf(resolve(outDir, 'sample-text-20p.pdf'), 20)],
  ['sample-text-200p.pdf', () => makeTextPdf(resolve(outDir, 'sample-text-200p.pdf'), 200)],
  ['sample-vector-10p.pdf', () => makeVectorPdf(resolve(outDir, 'sample-vector-10p.pdf'), 10)],
]

for (const [name, fn] of jobs) {
  const bytes = await fn()
  console.log(`[testdata] ${name.padEnd(24)} ${(bytes / 1024 / 1024).toFixed(2)} MB`)
}
