#!/usr/bin/env node
/**
 * 生成「批注兼容性」实验样本 PDF。
 *
 * 目的：批注是硬门槛 —— 写不对的话，用户在自己 PDF 里画的批注在
 * Edge / Acrobat 里可能**根本不显示**。而我没法在无头浏览器里验证 Acrobat 的行为，
 * 所以必须生成一份**能一眼看出对错**的样本，让用户在真实查看器里逐条核对。
 *
 * 本样本刻意做成对照实验：
 *   P1  Highlight + /AP + Z 序        ← 正确做法（基准）
 *   P2  Highlight 无 /AP + Z 序       ← 与 P1 对比：/AP 到底有没有用
 *   P3  Highlight 无 /AP + 逆时针序   ← 与 P2 对比：QuadPoints 顺序坑
 *   P4  Ink（手写）+ /AP
 *   P5  FreeText（文本框）+ /AP
 *   P6  Square + StrikeOut + Underline（各带 /AP）
 *   P7  Highlight + /AP + 逆时针序    ← 验证「有 /AP 时顺序就不重要了」
 *
 * 输出：
 *   public/testdata/annot-fixture.pdf     样本本体
 *   public/annot-check.html               逐项核对清单（在浏览器里打开对照打勾）
 *
 * 幂等：可反复运行，会覆盖输出。
 */

import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

// pdf-lib 是本项目的运行时依赖（浏览器里也会用），这里在 Node 端复用它生成样本。
const require = createRequire(import.meta.url)
const { PDFDocument, PDFName, PDFString, StandardFonts, rgb } = require('@cantoo/pdf-lib')

// ⚠️ 踩过的坑：PDFContext.obj() 把 **JS string 当成 PDFName**（写成 `/xxx`），
// 而 /T /Contents /NM /M /DA 按规范必须是 **text string**（写成 `(xxx)`）。
// 用 PDFName 写出来的注释，在严格查看器里作者名与批注内容是错的。
// 所以这些键一律显式包一层 PDFString.of()。
const S = (v) => PDFString.of(v)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'public', 'testdata')

const PAGE_W = 595.28 // A4
const PAGE_H = 841.89

const AUTHOR = 'edge-pdf-lite'
const NM_PREFIX = 'epl:'

const BODY = [
  'Line 1  —  this line is NOT highlighted.',
  'Line 2  —  HIGHLIGHT TARGET (first).',
  'Line 3  —  HIGHLIGHT TARGET (second).',
  'Line 4  —  this line is NOT highlighted.',
]
const BODY_TOP_Y = 700
const BODY_LINE_H = 22
const BODY_SIZE = 12
const BODY_X = 48

/** PDF 日期串：D:YYYYMMDDHHmmSS+HH'mm' */
function pdfDate(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const tzMin = -d.getTimezoneOffset()
  const sign = tzMin >= 0 ? '+' : '-'
  const abs = Math.abs(tzMin)
  return (
    `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}'${p(abs % 60)}'`
  )
}

function newNm(tag) {
  return `${NM_PREFIX}${tag}-${randomUUID()}`
}

/** 拿到（或创建）页面的 /Annots 数组，返回可直接 push 的 PDFArray */
function ensureAnnots(pdf, page) {
  const key = PDFName.of('Annots')
  const existing = page.node.get(key)
  if (existing) {
    const resolved = pdf.context.lookup(existing)
    if (resolved) return resolved
  }
  const arr = pdf.context.obj([])
  // 注册成间接对象更规范，也让后续增量更新稳定
  const ref = pdf.context.register(arr)
  page.node.set(key, ref)
  return arr
}

/**
 * 构造 /AP 外观流（Form XObject）。
 *
 * ⚠️⚠️ 这里是最容易写错、而且**错了在自家实现里完全看不出来**的地方。
 *
 * 两种"看起来都对"的写法，只有一种真的对：
 *
 *   ✗ 错误：`BBox=[0,0,w,h]` + `Matrix=[1,0,0,1,-rect[0],-rect[1]]` + 内容用**页面坐标**
 *     —— 方案 v1 就是这么写的，数学上"把页面坐标平移到注释空间"听着合理，
 *     但 pdf.js 的 `getTransformMatrix(rect, bbox, matrix)` 会**自己**再算一次
 *     「bbox 经 matrix 变换后的范围 → 缩放到 /Rect」的映射，于是**双重偏移**。
 *     实测：P1 的 transform 算出来是 `[1,0,0,1,92,1306]`，高亮被推到页面外，
 *     在 canvas 上一点都看不见。
 *
 *   ✓ 正确：`BBox=[0,0,w,h]` + **单位 Matrix** + 内容用**注释空间坐标**（原点 = Rect 左下角）
 *     —— 符合 ISO 32000-1：外观流画在"注释空间"里，由 Matrix 映射过去。
 *     不自己平移，交给查看器做，两边就都对了。
 *
 * @param rect  注释的 /Rect（页面坐标）
 * @param build `(originX, originY) => 内容流`；坐标请写成 `页面坐标 - origin`
 */
function formXObject(pdf, rect, build, resources = {}) {
  const [x0, y0, x1, y1] = rect
  const content = build(x0, y0)
  const stream = pdf.context.stream(content, {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, x1 - x0, y1 - y0],
    Matrix: [1, 0, 0, 1, 0, 0],
    Resources: resources,
  })
  return pdf.context.register(stream)
}

/** 把注释字典挂到页面（可选带 /AP） */
function addAnnot(pdf, page, dict, apRef) {
  const annots = ensureAnnots(pdf, page)
  const full = { ...dict }
  if (apRef) full.AP = { N: apRef }
  const ref = pdf.context.register(pdf.context.obj(full))
  annots.push(ref)
  return ref
}

/** 矩形（多行高亮用的四边形）在页面坐标下的四个角。
 *  Z 序 = 左上 → 右上 → 左下 → 右下（Adobe 与多数查看器的实际期望）
 *  逆时针序 = 左下 → 右下 → 左上 → 右上（ISO 32000-1 的措辞容易被误读成这个）
 */
function quadFor(x0, x1, yBottom, yTop, order) {
  if (order === 'z') {
    return [x0, yTop, x1, yTop, x0, yBottom, x1, yBottom]
  }
  return [x0, yBottom, x1, yBottom, x0, yTop, x1, yTop]
}

/**
 * 一组四边形的包围盒。
 *
 * ⚠️ 坑（本脚本第一版就踩了）：/Rect **必须**是所有 QuadPoints 的包围盒。
 * 多行高亮里各行宽度常常不同，若只拿「第一行的右边界」当 Rect 右边界，
 * Rect 就包不住后面几行 —— 而部分查看器会**按 Rect 裁剪 /AP 外观流**，
 * 于是高亮看起来"被截断了一段"。这类 bug 在自家实现里很难发现，
 * 一到 Acrobat 就露馅。
 */
function bboxOfQuads(quads) {
  const xs = []
  const ys = []
  for (let i = 0; i < quads.length; i += 2) {
    xs.push(quads[i])
    ys.push(quads[i + 1])
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

function contentFillRect(r, g, b, x0, y0, x1, y1) {
  return `q\n${r} ${g} ${b} rg\n${x0} ${y0} ${x1 - x0} ${y1 - y0} re\nf\nQ\n`
}

function contentStrokeRect(r, g, b, w, x0, y0, x1, y1) {
  return `q\n${r} ${g} ${b} RG\n${w} w\n${x0} ${y0} ${x1 - x0} ${y1 - y0} re\nS\nQ\n`
}

const main = async () => {
  await mkdir(OUT_DIR, { recursive: true })

  const pdf = await PDFDocument.create()
  pdf.setTitle('edge-pdf-lite annotation fixture')
  pdf.setAuthor(AUTHOR)
  pdf.setSubject('批注 /AP 与 QuadPoints 兼容性对照样本')

  const helv = await pdf.embedFont(StandardFonts.Helvetica)
  const created = pdfDate()

  /** 每页：画标题 + 正文，返回正文各行的几何信息（供批注定位） */
  function newPage(title, note) {
    const page = pdf.addPage([PAGE_W, PAGE_H])
    page.drawText(title, { x: 48, y: 792, size: 14, font: helv, color: rgb(0.05, 0.05, 0.05) })
    page.drawText(note, { x: 48, y: 772, size: 9, font: helv, color: rgb(0.35, 0.35, 0.35) })
    page.drawText(`NM prefix: ${NM_PREFIX}   author: ${AUTHOR}`, {
      x: 48,
      y: 34,
      size: 8,
      font: helv,
      color: rgb(0.55, 0.55, 0.55),
    })

    const lines = BODY.map((text, i) => {
      const y = BODY_TOP_Y - i * BODY_LINE_H
      page.drawText(text, { x: BODY_X, y, size: BODY_SIZE, font: helv, color: rgb(0, 0, 0) })
      const width = helv.widthOfTextAtSize(text, BODY_SIZE)
      return {
        text,
        y,
        x0: BODY_X - 2,
        x1: BODY_X + width + 4,
        yBottom: y - 3,
        yTop: y + 9.5,
      }
    })

    return { page, lines }
  }

  // ---------------------------------------------------------------- P1
  {
    const { page, lines } = newPage(
      'P1  Highlight + /AP + QuadPoints Z-order   [BASELINE]',
      'Expected: a yellow highlight sits exactly on Line 2 and Line 3. Annotation panel lists 1 Highlight.',
    )
    // 两行一起高亮 —— 顺便验证「一个注释多个四边形」这条常见路径
    const quads = [
      ...quadFor(lines[1].x0, lines[1].x1, lines[1].yBottom, lines[1].yTop, 'z'),
      ...quadFor(lines[2].x0, lines[2].x1, lines[2].yBottom, lines[2].yTop, 'z'),
    ]
    const rect = bboxOfQuads(quads)
    const ap = formXObject(pdf, rect, (ox, oy) =>
      contentFillRect(
        1, 0.92, 0.23,
        lines[1].x0 - ox, lines[1].yBottom - oy, lines[1].x1 - ox, lines[1].yTop - oy,
      ) +
      contentFillRect(
        1, 0.92, 0.23,
        lines[2].x0 - ox, lines[2].yBottom - oy, lines[2].x1 - ox, lines[2].yTop - oy,
      ),
    )

    addAnnot(
      pdf,
      page,
      {
        Type: 'Annot',
        Subtype: 'Highlight',
        Rect: rect,
        QuadPoints: quads,
        C: [1, 0.92, 0.23],
        CA: 0.6,
        F: 4, // Print
        Contents: S('P1: highlight WITH /AP, Z-order quadpoints'),
        T: S(AUTHOR),
        M: S(created),
        NM: S(newNm('p1')),
      },
      ap,
    )
  }

  // ---------------------------------------------------------------- P2
  {
    const { page, lines } = newPage(
      'P2  Highlight WITHOUT /AP + Z-order   [is /AP required?]',
      'Expected: if the viewer can still draw it, /AP is optional here. If blank -> /AP is mandatory.',
    )
    const rect = [lines[1].x0, lines[1].yBottom, lines[1].x1, lines[1].yTop]
    const quads = quadFor(lines[1].x0, lines[1].x1, lines[1].yBottom, lines[1].yTop, 'z')

    addAnnot(pdf, page, {
      Type: 'Annot',
      Subtype: 'Highlight',
      Rect: rect,
      QuadPoints: quads,
      C: [1, 0.92, 0.23],
      CA: 0.6,
      F: 4,
      Contents: S('P2: highlight WITHOUT /AP, Z-order quadpoints'),
      T: S(AUTHOR),
      M: S(created),
      NM: S(newNm('p2')),
    })
  }

  // ---------------------------------------------------------------- P3
  {
    const { page, lines } = newPage(
      'P3  Highlight WITHOUT /AP + CCW quadpoints   [does order matter?]',
      'Expected: compare with P2. Any offset/mirrored highlight here = quadpoint order matters.',
    )
    const rect = [lines[1].x0, lines[1].yBottom, lines[1].x1, lines[1].yTop]
    const quads = quadFor(lines[1].x0, lines[1].x1, lines[1].yBottom, lines[1].yTop, 'ccw')

    addAnnot(pdf, page, {
      Type: 'Annot',
      Subtype: 'Highlight',
      Rect: rect,
      QuadPoints: quads,
      C: [1, 0.92, 0.23],
      CA: 0.6,
      F: 4,
      Contents: S('P3: highlight WITHOUT /AP, counter-clockwise quadpoints'),
      T: S(AUTHOR),
      M: S(created),
      NM: S(newNm('p3')),
    })
  }

  // ---------------------------------------------------------------- P4
  {
    const { page } = newPage(
      'P4  Ink (freehand) + /AP',
      'Expected: a red wavy stroke. This is the tool that works on scanned pages.',
    )
    // 一条波浪线（页面坐标）
    const pts = []
    for (let i = 0; i <= 60; i++) {
      const x = 70 + i * 7
      const y = 600 + Math.sin(i / 4) * 26
      pts.push(x, y)
    }
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
    const pad = 4
    const rect = [minX - pad, minY - pad, maxX + pad, maxY + pad]

    // 外观流：把波浪线按页面坐标画出来
    const ap = formXObject(pdf, rect, (ox, oy) => {
      let path = `q\n1 0 0 RG\n2 w\n1 j\n1 J\n${pts[0] - ox} ${pts[1] - oy} m\n`
      for (let i = 2; i < pts.length; i += 2) path += `${pts[i] - ox} ${pts[i + 1] - oy} l\n`
      return path + 'S\nQ\n'
    })

    addAnnot(
      pdf,
      page,
      {
        Type: 'Annot',
        Subtype: 'Ink',
        Rect: rect,
        // ⚠️ ISO 32000-1：InkList 的点是 **default user space**（页面坐标）。
        // 实测证据：pdf.js 在没有 /AP 时直接 `x y m / x y l` 生成内容流，
        // **不做任何 Rect 偏移换算** —— 写成相对坐标会整条错位。
        InkList: [pts],
        C: [1, 0, 0],
        F: 4,
        BS: { W: 2, S: 'S' },
        Contents: S('P4: ink stroke WITH /AP'),
        T: S(AUTHOR),
        M: S(created),
        NM: S(newNm('p4')),
      },
      ap,
    )
  }

  // ---------------------------------------------------------------- P5
  {
    const { page } = newPage(
      'P5  FreeText (text box) + /AP',
      'Expected: a blue bordered box with blue text inside, near the middle of the page.',
    )
    const rect = [330, 520, 545, 575]

    // FreeText 的 /AP 外观流需要字体资源
    const fontRes = pdf.context.obj({ Font: { Helv: helv.ref } })
    const ap = formXObject(
      pdf,
      rect,
      (ox, oy) =>
        `q\n0 0 1 RG\n1 w\n0 0 ${rect[2] - rect[0]} ${rect[3] - rect[1]} re\nS\nQ\n` +
        `q\nBT\n/Helv 11 Tf\n0 0 1 rg\n1 0 0 1 8 ${rect[3] - rect[1] - 20} Tm\n(FreeText note) Tj\nET\nQ\n`,
      fontRes,
    )

    addAnnot(
      pdf,
      page,
      {
        Type: 'Annot',
        Subtype: 'FreeText',
        Rect: rect,
        Contents: S('FreeText note: written by edge-pdf-lite'),
        DA: S('/Helv 11 Tf 0 0 1 rg'),
        Q: 0,
        F: 4,
        T: S(AUTHOR),
        M: S(created),
        NM: S(newNm('p5')),
      },
      ap,
    )
  }

  // ---------------------------------------------------------------- P6
  {
    const { page, lines } = newPage(
      'P6  Square + StrikeOut + Underline (each with /AP)',
      'Expected: a red box, a strike-through on Line 2, an underline under Line 3.',
    )

    // Square：ISO 规定外观要在 Rect 内缩半个线宽，这里内缩 1pt
    const sqRect = [320, 300, 540, 420]
    const inset = 1
    const sqAp = formXObject(
      pdf,
      sqRect,
      (ox, oy) =>
        `q\n1 0 0 RG\n2 w\n` +
        `${inset} ${inset} ${sqRect[2] - sqRect[0] - 2 * inset} ${sqRect[3] - sqRect[1] - 2 * inset} re\n` +
        `S\nQ\n`,
    )
    addAnnot(
      pdf,
      page,
      {
        Type: 'Annot',
        Subtype: 'Square',
        Rect: sqRect,
        C: [1, 0, 0],
        F: 4,
        BS: { W: 2, S: 'S' },
        Contents: S('P6-square: rectangle annotation'),
        T: S(AUTHOR),
        M: S(created),
        NM: S(newNm('p6-square')),
      },
      sqAp,
    )

    // StrikeOut：穿过 Line 2 中线
    const soRect = [lines[1].x0, lines[1].yBottom, lines[1].x1, lines[1].yTop]
    const soY = (lines[1].yBottom + lines[1].yTop) / 2
    const soAp = formXObject(
      pdf,
      soRect,
      (ox, oy) =>
        `q\n1 0 0 RG\n1.5 w\n${lines[1].x0 - ox} ${soY - oy} m\n${lines[1].x1 - ox} ${soY - oy} l\nS\nQ\n`,
    )
    addAnnot(
      pdf,
      page,
      {
        Type: 'Annot',
        Subtype: 'StrikeOut',
        Rect: soRect,
        QuadPoints: quadFor(lines[1].x0, lines[1].x1, lines[1].yBottom, lines[1].yTop, 'z'),
        C: [1, 0, 0],
        F: 4,
        Contents: S('P6-strikeout'),
        T: S(AUTHOR),
        M: S(created),
        NM: S(newNm('p6-strikeout')),
      },
      soAp,
    )

    // Underline：贴在 Line 3 底部
    const ulRect = [lines[2].x0, lines[2].yBottom, lines[2].x1, lines[2].yTop]
    const ulY = lines[2].yBottom + 0.5
    const ulAp = formXObject(
      pdf,
      ulRect,
      (ox, oy) =>
        `q\n0 0 1 RG\n1.5 w\n${lines[2].x0 - ox} ${ulY - oy} m\n${lines[2].x1 - ox} ${ulY - oy} l\nS\nQ\n`,
    )
    addAnnot(
      pdf,
      page,
      {
        Type: 'Annot',
        Subtype: 'Underline',
        Rect: ulRect,
        QuadPoints: quadFor(lines[2].x0, lines[2].x1, lines[2].yBottom, lines[2].yTop, 'z'),
        C: [0, 0, 1],
        F: 4,
        Contents: S('P6-underline'),
        T: S(AUTHOR),
        M: S(created),
        NM: S(newNm('p6-underline')),
      },
      ulAp,
    )
  }

  // ---------------------------------------------------------------- P7
  {
    const { page, lines } = newPage(
      'P7  Highlight + /AP + CCW quadpoints   [does /AP win?]',
      'Expected: identical to P1. With /AP present, quadpoint order should not matter — /AP wins.',
    )
    const rect = [lines[1].x0, lines[1].yBottom, lines[1].x1, lines[1].yTop]
    const quads = quadFor(lines[1].x0, lines[1].x1, lines[1].yBottom, lines[1].yTop, 'ccw')
    const ap = formXObject(pdf, rect, (ox, oy) =>
      contentFillRect(
        1, 0.92, 0.23,
        lines[1].x0 - ox, lines[1].yBottom - oy, lines[1].x1 - ox, lines[1].yTop - oy,
      ),
    )

    addAnnot(
      pdf,
      page,
      {
        Type: 'Annot',
        Subtype: 'Highlight',
        Rect: rect,
        QuadPoints: quads,
        C: [1, 0.92, 0.23],
        CA: 0.6,
        F: 4,
        Contents: S('P7: highlight WITH /AP, counter-clockwise quadpoints'),
        T: S(AUTHOR),
        M: S(created),
        NM: S(newNm('p7')),
      },
      ap,
    )
  }

  const bytes = await pdf.save({ useObjectStreams: false })
  const outPath = join(OUT_DIR, 'annot-fixture.pdf')
  await writeFile(outPath, bytes)

  console.log(`已生成 ${outPath}`)
  console.log(`  大小 ${(bytes.length / 1024).toFixed(1)} KB · ${pdf.getPageCount()} 页`)
  console.log(`  逐页内容：P1 Highlight+/AP · P2 无/AP · P3 无/AP+逆时针 · P4 Ink`)
  console.log(`           P5 FreeText · P6 Square/StrikeOut/Underline · P7 Highlight+/AP+逆时针`)
  console.log(`\n自检页：在浏览器里打开 /annot-check.html（自动自检 + 人工核对清单）`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
