/**
 * 批注「写回 PDF」自检（M6 的硬门槛）。
 *
 * 前面的 `annot-check` 证明的是「手写的注释字典能被 pdf.js 认出来」；
 * 这一页证明的是**产品代码 `annot/writer.ts` 生成的文件也对** —— 中间隔着
 * pdf-lib 的 obj() 转换、增量更新、字体资源，任何一环出错都会写出
 * 「自家读着没错、别人打不开」的文件。
 *
 * 三条判据，每条都对应踩过的坑：
 *
 *  1. **原有批注必须还在** —— 增量更新最容易把别人的注释弄丢。
 *  2. **原始字典层的类型要对** —— `/T` `/NM` 必须是 text string（`PDFString`），
 *     不能是 PDFName；`/AP` 的 `Matrix` 必须是单位矩阵、`BBox` 必须是 `[0,0,w,h]`。
 *     （pdf.js 会把 PDFName 也"读得出来"，所以这层必须绕过 pdf.js 直接查字典。）
 *  3. **画出来的像素必须落在 /Rect 里** —— 用「写回前后同一页的差分」来判：
 *     差分像素 = 我们新加的批注，它们应当**全部**落在 /Rect 内。
 *     这条能一击命中「/AP 双重偏移」那个坑（犯了这个错，像素会整片跑出版面）。
 *
 * ⚠️ 差分法比"数特定颜色"更稳：不需要知道批注是什么颜色、透明度多少，
 * 也不需要定阈值 —— 白纸黑字的两张图，差的就是批注本身。
 */

import { pdfjsLib, installPdfWorker, AnnotationMode, describePdfError } from '@/pdfjs'
import { PDFDocument, PDFName, PDFString, PDFArray, PDFDict } from '@cantoo/pdf-lib'
import type { PDFRawStream } from '@cantoo/pdf-lib'
import { buildAnnotatedPdf, ANNOT_AUTHOR } from '@/annot/writer'
import type { Annotation } from '@/annot/types'

installPdfWorker()

const SRC = '/testdata/annot-fixture.pdf'
const SCALE = 1.5
/** 新批注的 /Contents 前缀 —— 用来和样本里原有的 9 条注释区分开 */
const NEW_TAG = 'EPL-NEW:'

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`页面缺少 #${id}`)
  return el as T
}

const statusEl = $('status')
const reportEl = $('report')
const previewEl = $('preview')
const runBtn = $<HTMLButtonElement>('runCheck')

function log(msg: string, kind: 'info' | 'ok' | 'warn' | 'err' = 'info'): void {
  statusEl.className = kind === 'info' ? '' : kind
  statusEl.textContent = msg
}

function esc(s: unknown): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

type Check = { name: string; ok: boolean; detail: string }
const checks: Check[] = []
function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail })
}

// ---------------------------------------------------------------- 造批注

const ISO = new Date().toISOString()

function base(id: string, pageNumber: number, rect: [number, number, number, number], contents: string) {
  return {
    id,
    pageNumber,
    rect,
    color: [0.9, 0.19, 0.19] as [number, number, number],
    opacity: 1,
    contents: `${NEW_TAG} ${contents}`,
    created: ISO,
    modified: ISO,
  }
}

/** 一行文字的四边形（Z 序：左上→右上→左下→右下） */
function quadFor(x0: number, x1: number, yBottom: number, yTop: number): number[] {
  return [x0, yTop, x1, yTop, x0, yBottom, x1, yBottom]
}

// 样本是 A4（595.28 × 841.89），正文第 4 行在 y≈631~643.5，各页原批注都避开了这一行
const LINE4 = { x0: 46, x1: 300, yBottom: 631, yTop: 643.5 }
const q4 = quadFor(LINE4.x0, LINE4.x1, LINE4.yBottom, LINE4.yTop)

/** 手写：一条正弦波（页面坐标 —— InkList 必须是页面坐标，不是相对 Rect 的） */
const inkPts: number[] = []
for (let i = 0; i <= 40; i++) {
  inkPts.push(70 + i * 6, 450 + Math.sin(i / 3) * 20)
}

const NEW: Annotation[] = [
  {
    ...base('new-highlight', 1, [LINE4.x0, LINE4.yBottom, LINE4.x1, LINE4.yTop], 'highlight on line 4'),
    kind: 'highlight',
    color: [1, 0.92, 0.23],
    opacity: 0.6,
    quads: q4,
  },
  {
    ...base('new-underline', 2, [LINE4.x0, LINE4.yBottom, LINE4.x1, LINE4.yTop], 'underline on line 4'),
    kind: 'underline',
    color: [0.13, 0.4, 0.92],
    quads: q4,
  },
  {
    ...base('new-strikeout', 3, [LINE4.x0, LINE4.yBottom, LINE4.x1, LINE4.yTop], 'strikeout on line 4'),
    kind: 'strikeout',
    quads: q4,
  },
  {
    ...base('new-ink', 4, [0, 0, 0, 0], 'ink wave'),
    kind: 'ink',
    strokes: [inkPts],
    lineWidth: 2,
  },
  {
    // 挪到页面下半部，把 Line 2/3 让给区域高亮（它要盖在文字上验证"透字"）
    ...base('new-rect', 5, [80, 420, 300, 520], 'square box'),
    kind: 'rect',
    lineWidth: 2,
  },
  {
    /*
     * 区域高亮：**故意盖在文字行上**，这样在 Edge / Acrobat 里能一眼看出
     * 它是"染背景"还是"盖色板" —— 文字若还清晰可读，就是对的。
     * 放在第 5 页、盖住 Line 2 / Line 3（那两行正是 HIGHLIGHT TARGET）。
     */
    ...base('new-area', 5, [46, 645, 300, 680], 'area highlight (no text layer needed)'),
    kind: 'area',
    color: [1, 0.92, 0.23],
    // ⚠️ 必须 1：区域高亮靠 Multiply 染背景，alpha<1 会把内容冲淡
    opacity: 1,
  },
  {
    ...base('new-freetext', 6, [60, 150, 280, 210], 'free text ascii'),
    kind: 'freetext',
    text: 'Hello PDF',
    fontSize: 12,
    color: [0.13, 0.4, 0.92],
  },
  {
    ...base('new-freetext-cn', 7, [60, 150, 300, 220], '中文文本框'),
    kind: 'freetext',
    text: '中文批注测试',
    fontSize: 12,
    color: [0.13, 0.4, 0.92],
  },
]

// ---------------------------------------------------------------- 工具

/**
 * ⚠️ `getDocument({data})` 会 **transfer** 掉传入的 ArrayBuffer（读完之后就是 detached）。
 * 而写回必须拿**原文件**做增量保存 —— 所以这里先复制一份再交给 pdf.js。
 * 项目里已经因为这条栽过一次（Q6 变体的 `Reduce of empty array`）。
 */
async function loadDoc(data: Uint8Array): Promise<pdfjsLib.PDFDocumentProxy> {
  const task = pdfjsLib.getDocument({
    data: data.slice(),
    cMapUrl: '/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/standard_fonts/',
  })
  return task.promise
}

async function renderPage(
  doc: pdfjsLib.PDFDocumentProxy,
  pageNumber: number,
): Promise<{ canvas: HTMLCanvasElement; pageHeight: number }> {
  const page = await doc.getPage(pageNumber)
  const vp = page.getViewport({ scale: SCALE })
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(vp.width)
  canvas.height = Math.round(vp.height)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({
    canvas,
    canvasContext: ctx,
    viewport: vp,
    intent: 'display',
    annotationMode: AnnotationMode.ENABLE,
  }).promise
  return { canvas, pageHeight: page.getViewport({ scale: 1 }).height }
}

/** 数一个页面矩形（页面坐标）里的深色像素 —— 用来判断"文字有没有被色块盖住" */
function countDark(
  canvas: HTMLCanvasElement,
  pageHeight: number,
  rect: [number, number, number, number],
): { dark: number; total: number } {
  const x = Math.round(rect[0] * SCALE)
  const y = Math.round((pageHeight - rect[3]) * SCALE)
  const w = Math.round((rect[2] - rect[0]) * SCALE)
  const h = Math.round((rect[3] - rect[1]) * SCALE)
  const d = canvas.getContext('2d')!.getImageData(x, y, w, h).data
  let dark = 0
  for (let i = 0; i < d.length; i += 4) {
    // 亮度低 = 文字还在（黄底黑字 / 蓝底黑字都满足）
    const luma = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!
    if (luma < 120) dark++
  }
  return { dark, total: d.length / 4 }
}

/** 两张同尺寸位图的差分：不同像素个数 + 差分的包围盒（画布像素坐标） */
function diffCanvas(a: HTMLCanvasElement, b: HTMLCanvasElement) {
  const w = Math.min(a.width, b.width)
  const h = Math.min(a.height, b.height)
  const da = a.getContext('2d')!.getImageData(0, 0, w, h).data
  const db = b.getContext('2d')!.getImageData(0, 0, w, h).data
  let count = 0
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const dr = Math.abs(da[i]! - db[i]!)
      const dg = Math.abs(da[i + 1]! - db[i + 1]!)
      const dbl = Math.abs(da[i + 2]! - db[i + 2]!)
      if (dr > 16 || dg > 16 || dbl > 16) {
        count++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return { count, minX, minY, maxX, maxY }
}

const near = (a: number, b: number, tol = 0.02): boolean => Math.abs(a - b) <= tol

/** 分块转 base64 —— 直接 `String.fromCharCode(...bytes)` 在大文件上会爆参数个数上限 */
function toBase64(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(s)
}

// ---------------------------------------------------------------- 主流程

const run = async (): Promise<void> => {
  runBtn.disabled = true
  reportEl.innerHTML = ''
  previewEl.innerHTML = ''
  const shots: Array<{ title: string; before: string; after: string }> = []

  try {
    log('加载样本…')
    const res = await fetch(SRC)
    if (!res.ok) throw new Error(`取样本失败：HTTP ${res.status}（先跑 npm run testdata:annot）`)
    const original = new Uint8Array(await res.arrayBuffer())

    const baseDoc = await loadDoc(original)
    const baseCounts: number[] = []
    for (let p = 1; p <= baseDoc.numPages; p++) {
      baseCounts.push((await (await baseDoc.getPage(p)).getAnnotations()).length)
    }
    const baseTotal = baseCounts.reduce((s, n) => s + n, 0)

    // ---------------------------------------------------------------- 写回
    check(
      '原文件字节没有被 pdf.js transfer 掉（byteLength > 0）—— 增量保存必须基于原文件',
      original.byteLength > 1000,
      `${original.byteLength} 字节`,
    )
    log(`写回 ${NEW.length} 条批注…`)
    const t0 = performance.now()
    const written = await buildAnnotatedPdf(original, NEW)
    const writeMs = performance.now() - t0
    log(`写回完成（${writeMs.toFixed(0)} ms），开始校验…`)

    check(
      '输出是合法的 PDF 且体积没有异常缩水（增量更新只追加差异）',
      written.length > original.length * 0.5 && written.length < original.length * 4,
      `${(original.length / 1024).toFixed(1)} KB → ${(written.length / 1024).toFixed(1)} KB，耗时 ${writeMs.toFixed(0)} ms`,
    )

    // 增量 vs 全量的对照 —— 项目铁律：性能数字必须带对照组。
    // ⚠️ 上面那个 21ms 是**首次调用**（含解析器/JIT 预热），不能当结论。
    // 所以各跑两次取较小值，并且**不**做"增量更快"的断言（见下面记录的数字）。
    const runOnce = async (incremental: boolean) => {
      const t = performance.now()
      const bytes = await buildAnnotatedPdf(original, NEW, { incremental })
      return { ms: performance.now() - t, bytes }
    }
    const timeOf = async (incremental: boolean) => {
      const [a, b] = await Promise.all([runOnce(incremental), runOnce(incremental)])
      return a.ms <= b.ms ? a : b
    }
    const inc = await timeOf(true)
    const full = await timeOf(false)
    const prefixOk =
      inc.bytes.length > original.length &&
      original.every((b, i) => inc.bytes[i] === b)
    check(
      '增量产物以「原文件字节」开头（确实是只追加，没有重写整档）',
      prefixOk,
      `原 ${original.length} B / 成品 ${inc.bytes.length} B`,
    )
    check(
      '两种写法都能产出成规模的 PDF（对照组都得是有效的）',
      full.bytes.length > 1000 && inc.bytes.length > 1000,
      `增量 ${inc.ms.toFixed(0)} ms / ${(inc.bytes.length / 1024).toFixed(1)} KB  vs  ` +
        `全量 ${full.ms.toFixed(0)} ms / ${(full.bytes.length / 1024).toFixed(1)} KB`,
    )

    // ---------------------------------------------------------------- ① 结构（pdf.js 侧）
    const newDoc = await loadDoc(written)
    check('页数不变', newDoc.numPages === baseDoc.numPages, `${baseDoc.numPages} → ${newDoc.numPages}`)

    const rows: Array<Record<string, unknown>> = []
    const oldKept: number[] = []
    for (let p = 1; p <= newDoc.numPages; p++) {
      const annots = (await (await newDoc.getPage(p)).getAnnotations()) as Array<Record<string, unknown>>
      const isNew = (a: Record<string, unknown>): boolean =>
        String((a.contentsObj as { str?: string } | undefined)?.str ?? '').startsWith(NEW_TAG)
      oldKept.push(annots.filter((a) => !isNew(a)).length)
      for (const a of annots.filter(isNew)) {
        rows.push({
          page: p,
          subtype: String(a.subtype ?? '?'),
          author: String((a.titleObj as { str?: string } | undefined)?.str ?? ''),
          contents: String((a.contentsObj as { str?: string } | undefined)?.str ?? ''),
          rect: (a.rect as number[]).map((v) => Math.round(v * 100) / 100),
          hasAP: a.hasAppearance === true,
          // ⚠️ pdf.js 返回的是 **Float32Array**，`Array.isArray()` 对它恒为 false。
          // 断言里要是直接判 Array.isArray，会得出"字段不存在"的错误结论 —— 先转成普通数组。
          quadPoints: a.quadPoints ? Array.from(a.quadPoints as ArrayLike<number>) : null,
          inkLists: a.inkLists ? (a.inkLists as ArrayLike<number>[]).map((s) => Array.from(s)) : null,
          overlaid: String(a.overlaidText ?? '').replace(/\s+/g, ' ').slice(0, 40),
        })
      }
    }

    check(
      `原有的 ${baseTotal} 条批注一条都没丢（逐页比对）`,
      oldKept.every((n, i) => n === baseCounts[i]),
      `原 ${baseCounts.join('/')} → 现 ${oldKept.join('/')}`,
    )
    check(`新增 ${NEW.length} 条`, rows.length === NEW.length, `实际 ${rows.length}`)

    const byType: Record<string, number> = {}
    for (const r of rows) byType[String(r.subtype)] = (byType[String(r.subtype)] ?? 0) + 1
    check(
      // Highlight 是 2 条：文本高亮 + **区域高亮**（后者也落成标准 Highlight）
      '子类型全部正确（Highlight×2 / Underline / StrikeOut / Ink / Square / FreeText×2）',
      byType.Highlight === 2 &&
        byType.Underline === 1 &&
        byType.StrikeOut === 1 &&
        byType.Ink === 1 &&
        byType.Square === 1 &&
        byType.FreeText === 2,
      JSON.stringify(byType),
    )
    check(
      '每条新批注的 /T 作者名都是 edge-pdf-lite（「只擦自己的」判据）',
      rows.every((r) => r.author === ANNOT_AUTHOR),
      rows.filter((r) => r.author !== ANNOT_AUTHOR).map((r) => `P${r.page}`).join(' ') || '',
    )
    check(
      '每条新批注都带 /AP（没外观 = 在别的查看器里可能一片空白）',
      rows.every((r) => r.hasAP === true),
      rows.filter((r) => !r.hasAP).map((r) => `P${r.page}/${r.subtype}`).join(' ') || '',
    )

    // InkList 必须是页面坐标（不是相对 Rect 的）—— 这一条错了会整条错位
    const inkRow = rows.find((r) => r.subtype === 'Ink')
    const inkOk =
      !!inkRow &&
      Array.isArray(inkRow.inkLists) &&
      inkRow.inkLists[0]?.length === inkPts.length &&
      (inkRow.inkLists[0] as number[]).every((v, i) => near(v, inkPts[i]!, 0.05))
    check('InkList 原样是页面坐标（未被换算成相对 Rect 的坐标）', inkOk, inkRow ? `点数 ${(inkRow.inkLists as number[][])?.[0]?.length} / 期望 ${inkPts.length}` : '没找到 Ink')

    // 高亮的 QuadPoints：值 + Z 序都要原样
    const hl = rows.find((r) => r.subtype === 'Highlight')
    const hlOk =
      !!hl &&
      Array.isArray(hl.quadPoints) &&
      (hl.quadPoints as number[]).length === q4.length &&
      (hl.quadPoints as number[]).every((v, i) => near(v, q4[i]!, 0.05))
    check(
      'Highlight 的 QuadPoints 原样写回（值 + Z 序）',
      hlOk,
      hl ? `读回 ${(hl.quadPoints as number[])?.join(',')} / 写入 ${q4.join(',')}` : '没找到',
    )

    /*
     * 区域高亮 → 必须是**标准 `/Highlight`** 子类型，QuadPoints 是矩形四角。
     *
     * 这条判据守的是"跨查看器"：扫描件上没有文本层，但写回后落在标准类型上，
     * 任何查看器（PDFium / Acrobat / pdf.js）都能画。
     * 哪天有人图省事自造一个 Subtype，这条会立刻变红。
     */
    const areaRow = rows.find((r) => String(r.contents ?? '').includes('area highlight'))
    const areaQuads = areaRow?.quadPoints as number[] | undefined
    check(
      '区域高亮落成标准 /Highlight，且 QuadPoints 是矩形四角',
      !!areaRow && areaRow.subtype === 'Highlight' && Array.isArray(areaQuads) && areaQuads.length === 8,
      areaRow
        ? `subtype=${String(areaRow.subtype).replace('/', '')} / QuadPoints=${areaQuads?.map((n) => n.toFixed(0)).join(',')}`
        : '没找到 area 批注',
    )

    // 中文 /Contents
    const cn = rows.find((r) => String(r.contents).includes('中文文本框'))
    check('中文 /Contents 能读回来', !!cn, cn ? String(cn.contents) : '没找到')

    // ---------------------------------------------------------------- ② 原始字典层（绕过 pdf.js）
    // pdf.js 会把 PDFName 也"读出来"，所以 /T /NM 的类型必须直接查字典
    const rawDoc = await PDFDocument.load(written.slice())
    const nums = (arr: PDFArray): number[] =>
      (arr.asArray() as unknown as Array<{ asNumber: () => number }>).map((n) => n.asNumber())
    type RawRow = {
      page: number
      subtype: string
      nmIsString: boolean
      nm: string
      tIsString: boolean
      t: string | null
      rect: number[] | null
      matrix: number[] | null
      bbox: number[] | null
      hasFont: boolean
      /** /AP 的内容流原文（判「文本框有没有留下框/白底」要看它） */
      apText: string | null
    }
    const raw: RawRow[] = []

    for (let p = 1; p <= rawDoc.getPageCount(); p++) {
      const annots = rawDoc.getPage(p - 1).node.Annots()
      if (!annots) continue
      for (let i = 0; i < annots.size(); i++) {
        const d = rawDoc.context.lookup(annots.get(i)) as PDFDict
        const nm = d.get(PDFName.of('NM'))
        // 只看我们自己新写的那批（/NM 前缀 epl:new-）
        if (!(nm instanceof PDFString) || !nm.asString().startsWith('epl:new-')) continue

        const t = d.get(PDFName.of('T'))
        const rect = d.lookupMaybe(PDFName.of('Rect'), PDFArray)
        const ap = d.lookupMaybe(PDFName.of('AP'), PDFDict)
        const nRef = ap?.get(PDFName.of('N'))
        const stream = nRef ? (rawDoc.context.lookup(nRef) as PDFRawStream | undefined) : undefined
        const sd = stream?.dict
        raw.push({
          page: p,
          subtype: String(d.get(PDFName.of('Subtype')) ?? ''),
          nmIsString: nm instanceof PDFString,
          nm: String(nm),
          tIsString: t instanceof PDFString,
          t: t ? String(t) : null,
          rect: rect ? nums(rect).map((v) => Math.round(v * 100) / 100) : null,
          matrix: sd?.lookupMaybe(PDFName.of('Matrix'), PDFArray) ? nums(sd.lookup(PDFName.of('Matrix'), PDFArray)) : null,
          bbox: sd?.lookupMaybe(PDFName.of('BBox'), PDFArray) ? nums(sd.lookup(PDFName.of('BBox'), PDFArray)) : null,
          hasFont: !!sd?.get(PDFName.of('Resources')),
          apText: stream ? stream.getContentsString() : null,
        })
      }
    }

    const ourRaw = raw
    check(
      '/T 与 /NM 都是 PDFString（不是 PDFName —— obj() 会把 JS 字符串写成 /xxx）',
      ourRaw.length === NEW.length && ourRaw.every((r) => r.nmIsString && r.tIsString),
      `检出 ${ourRaw.length} 条，非字符串 ${ourRaw.filter((r) => !r.nmIsString || !r.tIsString).length} 条`,
    )
    check(
      '/AP 的 Matrix 是单位矩阵 + BBox 是 [0,0,w,h]（自己平移会造成双重偏移）',
      ourRaw.length > 0 &&
        ourRaw.every((r) => {
          const m = r.matrix as number[] | null
          const b = r.bbox as number[] | null
          const rr = r.rect as number[] | null
          if (!m || !b || !rr) return false
          return (
            near(m[0]!, 1, 1e-6) && near(m[1]!, 0, 1e-6) && near(m[2]!, 0, 1e-6) &&
            near(m[3]!, 1, 1e-6) && near(m[4]!, 0, 1e-6) && near(m[5]!, 0, 1e-6) &&
            near(b[0]!, 0, 1e-6) && near(b[1]!, 0, 1e-6) &&
            near(b[2]!, rr[2]! - rr[0]!, 0.01) && near(b[3]!, rr[3]! - rr[1]!, 0.01)
          )
        }),
      ourRaw.map((r) => `${r.subtype.replace('/', '')}:M=${(r.matrix as number[]).join(',')}`).join(' | '),
    )

    /*
     * ③ 文本框「融为一体」：写回的文件里**不能再有框和白底**
     *
     * 这是用户提的需求里最容易被做成"只做一半"的一条：应用内看着融合了，
     * 写回的 /AP 里还留着灰框 + 白底 → 在 Edge / Acrobat 里打开还是框着的。
     *
     * ⚠️ 两条判据都要有，各管一半：
     *   · **没有白色填充**（`1 1 1 rg`）—— 白底
     *   · **没有铺满 BBox 的矩形** —— 边框。不写成"没有某个灰色值"是因为那样
     *     只能抓住**这一个颜色**，换个灰就漏了；量尺寸才抓得住"整圈框"这件事。
     *     容差留 2.5pt 是为了把「比 BBox 小一圈的内框」也罩住。
     */
    const ftRows = ourRaw.filter((r) => r.subtype.includes('FreeText'))
    check(
      '文本框的 /AP 里既没有白底也没有边框（「融为一体」在写回的文件里也成立）',
      ftRows.length === 2 &&
        ftRows.every((r) => {
          const t = r.apText
          const b = r.bbox as number[] | null
          if (!t || !b) return false
          if (/\b1\s+1\s+1\s+rg/.test(t)) return false // 白底
          const bw = b[2]!
          const bh = b[3]!
          const rects = t.match(/-?[\d.]+\s+-?[\d.]+\s+(-?[\d.]+)\s+(-?[\d.]+)\s+re/g) ?? []
          const full = rects.filter((s) => {
            const n = s.split(/\s+/).map(Number)
            return n[2]! <= bw + 0.01 && n[2]! > bw - 2.5 && n[3]! <= bh + 0.01 && n[3]! > bh - 2.5
          })
          return full.length === 0
        }),
      ftRows
        .map((r) => {
          const b = r.bbox as number[] | null
          const bw = b?.[2] ?? 0
          const bh = b?.[3] ?? 0
          const t = r.apText ?? ''
          const rects = t.match(/-?[\d.]+\s+-?[\d.]+\s+(-?[\d.]+)\s+(-?[\d.]+)\s+re/g) ?? []
          const full = rects.filter((s) => {
            const n = s.split(/\s+/).map(Number)
            return n[2]! <= bw + 0.01 && n[2]! > bw - 2.5 && n[3]! <= bh + 0.01 && n[3]! > bh - 2.5
          })
          return `${r.subtype.replace('/', '')} 白底=${/\b1\s+1\s+1\s+rg/.test(t) ? '有' : '无'} 满框=${full.length}`
        })
        .join(' | '),
    )
    /*
     * 反向判据：光"没有框"不够 —— **什么都不画**也满足上一条。
     * ASCII 那条必须真的把字写进去了（BT … Tj）。
     */
    const asciiFt = ftRows.find((r) => r.nm.includes('new-freetext'))
    check(
      'ASCII 文本框真的把字画进了 /AP（去掉的是框，不是内容）',
      !!asciiFt?.apText && /BT/.test(asciiFt.apText) && /Tj/.test(asciiFt.apText),
      asciiFt?.apText ? asciiFt.apText.replace(/\s+/g, ' ').slice(0, 70) : 'null',
    )

    // ---------------------------------------------------------------- ③ 渲染差分
    log('渲染差分比对…')
    const diffs: Array<Record<string, unknown>> = []
    for (let p = 1; p <= newDoc.numPages; p++) {
      const adds = NEW.filter((a) => a.pageNumber === p)
      if (!adds.length) continue
      const before = await renderPage(baseDoc, p)
      const after = await renderPage(newDoc, p)
      const d = diffCanvas(before.canvas, after.canvas)

      // 期望矩形：本页新增批注的包围盒（页面坐标）
      let ex0 = Infinity
      let ey0 = Infinity
      let ex1 = -Infinity
      let ey1 = -Infinity
      for (const a of adds) {
        const r = a.kind === 'ink' ? bboxOfInk(a) : a.rect
        ex0 = Math.min(ex0, r[0])
        ey0 = Math.min(ey0, r[1])
        ex1 = Math.max(ex1, r[2])
        ey1 = Math.max(ey1, r[3])
      }
      // 差分包围盒（画布像素）→ 页面坐标
      const TOL = 3 // pt，容忍抗锯齿与线宽
      const gx0 = d.minX / SCALE
      const gx1 = (d.maxX + 1) / SCALE
      const gy1 = before.pageHeight - d.minY / SCALE
      const gy0 = before.pageHeight - (d.maxY + 1) / SCALE
      const inside =
        d.count > 0 &&
        gx0 >= ex0 - TOL &&
        gx1 <= ex1 + TOL &&
        gy0 >= ey0 - TOL &&
        gy1 <= ey1 + TOL

      diffs.push({
        page: p,
        diffPx: d.count,
        got: d.count ? [Math.round(gx0 * 10) / 10, Math.round(gy0 * 10) / 10, Math.round(gx1 * 10) / 10, Math.round(gy1 * 10) / 10] : null,
        expect: [Math.round(ex0 * 10) / 10, Math.round(ey0 * 10) / 10, Math.round(ex1 * 10) / 10, Math.round(ey1 * 10) / 10],
        inside,
      })

      shots.push({
        title: `P${p} ${adds.map((a) => a.kind).join('+')} · 差分 ${d.count} px`,
        before: before.canvas.toDataURL('image/jpeg', 0.85),
        after: after.canvas.toDataURL('image/jpeg', 0.85),
      })

      const col = document.createElement('div')
      col.className = 'col'
      col.appendChild(before.canvas)
      col.appendChild(after.canvas)
      const cap = document.createElement('div')
      cap.className = 'cap'
      cap.textContent = `P${p}：左=写回前 右=写回后 · 差分 ${d.count} px · ${inside ? '✅ 全部落在 /Rect 内' : '❌ 有像素跑到 /Rect 外'}`
      col.appendChild(cap)
      previewEl.appendChild(col)
    }

    check(
      '每一页都真的画出了东西（写回前后差分 > 50 px）',
      diffs.every((d) => (d.diffPx as number) > 50),
      diffs.map((d) => `P${d.page}:${d.diffPx}`).join(' '),
    )
    check(
      '画出来的像素全部落在 /Rect 内（没有偏移 —— 双重偏移会整片跑出去）',
      diffs.every((d) => d.inside === true),
      diffs.filter((d) => !d.inside).map((d) => `P${d.page} 实测 ${JSON.stringify(d.got)} vs 期望 ${JSON.stringify(d.expect)}`).join(' | '),
    )

    // ---------------------------------------------------------------- ④ 高亮必须"透字"
    //
    // 光有差分还不够：一块**不透明**的黄色色块差分也很大，但它把文字整片盖住了 ——
    // 高亮反而让内容不可读（第一版就是这个毛病，肉眼在图上才看出来）。
    // 判据：高亮矩形里必须还能数出**深色像素**（= 文字透出来了）。
    log('检查高亮是否透字…')
    const hlAfter = await renderPage(newDoc, 1)
    const hlDark = countDark(hlAfter.canvas, hlAfter.pageHeight, [46, 631, 300, 643.5])
    check(
      '高亮没有盖住文字（写回的 /AP 用了 Multiply 混合）',
      hlDark.dark > 50,
      `高亮区内深色像素 ${hlDark.dark} px / 共 ${hlDark.total} px`,
    )

    // ---------------------------------------------------------------- 报告
    reportEl.innerHTML = `
      <h2>① pdf.js 读回的新批注（${rows.length} 条）</h2>
      <table>
        <tr><th>页</th><th>子类型</th><th>/T 作者</th><th>/Contents</th><th>有 /AP</th><th>/Rect</th></tr>
        ${rows.map((r) => `<tr>
          <td>P${r.page}</td><td>${esc(r.subtype)}</td>
          <td class="${r.author ? 'ok' : 'err'}">${esc(r.author) || '（空）'}</td>
          <td class="dim">${esc(String(r.contents).slice(0, 40))}</td>
          <td class="${r.hasAP ? 'ok' : 'err'}">${r.hasAP ? '✅' : '❌'}</td>
          <td class="dim">${(r.rect as number[]).join(', ')}</td>
        </tr>`).join('')}
      </table>

      <h2>② 渲染差分（写回前 vs 写回后）</h2>
      <table>
        <tr><th>页</th><th>差分像素</th><th>差分包围盒（页面坐标）</th><th>期望（/Rect 并集）</th><th>判定</th></tr>
        ${diffs.map((d) => `<tr>
          <td>P${d.page}</td><td>${d.diffPx}</td>
          <td class="dim">${JSON.stringify(d.got)}</td>
          <td class="dim">${JSON.stringify(d.expect)}</td>
          <td class="${d.inside ? 'ok' : 'err'}">${d.inside ? '✅ 落在 /Rect 内' : '❌ 有偏移'}</td>
        </tr>`).join('')}
      </table>
      <p class="note">
        差分法：同一页渲染两次（写回前 / 写回后），逐像素比对。
        页面内容完全相同，所以<b>差分像素只可能来自我们新写的批注</b>。
        再要求差分包围盒落在 /Rect（±3pt）内 —— 这条能直接抓出
        「<code>/AP</code> 用 Matrix 自己平移一次」造成的双重偏移。
      </p>

      <h2>③ 原始字典层（绕过 pdf.js，直接查 pdf-lib）</h2>
      <table>
        <tr><th>子类型</th><th>/NM</th><th>是字符串</th><th>/AP Matrix</th><th>/AP BBox</th><th>有字体资源</th></tr>
        ${ourRaw.map((r) => `<tr>
          <td>${esc(String(r.subtype).replace('/', ''))}</td>
          <td class="dim">${esc(r.nm)}</td>
          <td class="${r.nmIsString && r.tIsString ? 'ok' : 'err'}">${r.nmIsString && r.tIsString ? '✅' : '❌ PDFName'}</td>
          <td class="dim">${(r.matrix as number[]).join(', ')}</td>
          <td class="dim">${(r.bbox as number[]).map((v) => v.toFixed(1)).join(', ')}</td>
          <td class="dim">${r.hasFont ? '有' : '—'}</td>
        </tr>`).join('')}
      </table>
      <p class="note">
        这一层必须绕过 pdf.js：<code>PDFContext.obj()</code> 会把 JS 字符串写成 <b>PDFName</b>
        （<code>/edge-pdf-lite</code> 而不是 <code>(edge-pdf-lite)</code>），
        而 pdf.js 读 PDFName 也能读出一个"看起来对"的字符串 —— 只有直接查类型才抓得到。
      </p>
    `

    const okCount = checks.filter((c) => c.ok).length
    log(`自检：${okCount}/${checks.length} 通过`, okCount === checks.length ? 'ok' : 'warn')

    ;(window as unknown as Record<string, unknown>).__writeCheck = {
      checks,
      passed: okCount,
      total: checks.length,
      rows,
      raw: ourRaw,
      diffs,
      baseTotal,
      oldKept,
      baseCounts,
      bytesBefore: original.length,
      bytesAfter: written.length,
      writeMs,
      shots,
      writtenBase64: toBase64(written),
    }
  } catch (e) {
    const err = e as Error
    console.error('[write-check] 失败', err)
    log(`出错：${describePdfError(err)}`, 'err')
    const pre = document.createElement('pre')
    pre.className = 'stack'
    pre.textContent = String(err.stack ?? err.message)
    reportEl.appendChild(pre)
  } finally {
    runBtn.disabled = false
  }
}

/** Ink 批注的包围盒（含线宽外扩）—— 与 writer.ts 里 safeRect 的算法保持一致 */
function bboxOfInk(a: Annotation): [number, number, number, number] {
  if (a.kind !== 'ink') return a.rect
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const s of a.strokes) {
    for (let i = 0; i < s.length; i += 2) {
      minX = Math.min(minX, s[i]!)
      maxX = Math.max(maxX, s[i]!)
      minY = Math.min(minY, s[i + 1]!)
      maxY = Math.max(maxY, s[i + 1]!)
    }
  }
  const p = a.lineWidth / 2
  return [minX - p, minY - p, maxX + p, maxY + p]
}

runBtn.addEventListener('click', () => void run())
