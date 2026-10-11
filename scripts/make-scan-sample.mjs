/**
 * 生成「扫描件风格」的测试样本 public/testdata/scan-like.pdf。
 *
 * 为什么需要它：真实的扫描书（《现代操作系统教程》就是整页图片）**没有文本层**，
 * 而现有样本 real-1706.03762.pdf 是文字版 —— 拿它验证不了
 * "扫描件上区域高亮可用、文字高亮不可用"这个关键区别。
 *
 * ⚠️ 整页**只用矢量图形**画，一个字都不写 —— 保证 PDF 里没有任何文本对象，
 *    也就没有文本层。这才真正等价于扫描件。
 *    曾经想直接在文字版 PDF 上找"空白处"做对照，结果失败：拖动经过空白区时
 *    浏览器照样会把附近的文字选进选区，对照根本不成立。
 *
 *   npm run testdata:scan
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, rgb } from '@cantoo/pdf-lib'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public', 'testdata', 'scan-like.pdf')

const PAGE_W = 595.28 // A4 pt
const PAGE_H = 841.89
const PAGES = 3

/** 确定性伪随机 —— 每次生成的样本必须完全一致，否则测试截图没法比 */
function makeRng(seed) {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

const pdf = await PDFDocument.create()
pdf.setTitle('scan-like sample (no text layer)')
pdf.setSubject('整页图形、无文本层，用来模拟扫描件')
pdf.setProducer('edge-pdf-lite testdata')

const PAPER = rgb(0.965, 0.957, 0.937) // 微微发黄的纸
const INK = rgb(0.16, 0.16, 0.18)

for (let p = 0; p < PAGES; p++) {
  const page = pdf.addPage([PAGE_W, PAGE_H])
  const rnd = makeRng(p * 977 + 13)

  // 纸底
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: PAPER })

  // 页眉：一条深色粗块，像扫描出来的章节标题
  page.drawRectangle({ x: 86, y: PAGE_H - 132, width: 250 + rnd() * 60, height: 22, color: INK })

  // 正文：一行行宽度不等的深灰条，模拟文字行
  let y = PAGE_H - 180
  while (y > 96) {
    const indent = rnd() < 0.16 ? 26 : 0 // 偶尔来个段首缩进
    const w = 300 + rnd() * 120
    page.drawRectangle({ x: 86 + indent, y, width: w, height: 8, color: rgb(0.28, 0.28, 0.3) })
    y -= 19
  }

  // 页脚页码位：一小块方形
  page.drawRectangle({ x: PAGE_W / 2 - 8, y: 62, width: 16, height: 8, color: INK })
}

const bytes = await pdf.save({ useObjectStreams: false })
await mkdir(dirname(OUT), { recursive: true })
await writeFile(OUT, bytes)
console.log(`已生成 ${OUT}  (${(bytes.length / 1024).toFixed(1)} KB，${PAGES} 页，无文本层)`)
