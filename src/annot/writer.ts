/**
 * 把批注写回 PDF。
 *
 * 这里是 M0 批注实验的全部结论落地的地方。**四条铁律，每条都是踩出来的：**
 *
 * 1. **`/AP` 用「单位 Matrix + 注释空间坐标」**
 *    `BBox=[0,0,w,h]`、`Matrix=[1,0,0,1,0,0]`，内容坐标 = 页面坐标 − Rect 左下角。
 *    方案 v1 写的「用 Matrix 把页面坐标平移过去」是错的：查看器
 *    （pdf.js 的 `getTransformMatrix`）**自己会再做一次 bbox→Rect 的映射**，
 *    结果双重偏移，实测 transform 变成 `[1,0,0,1,92,1306]`，批注被推出版面、完全不显示。
 *
 * 2. **`/Rect` 必须是所有 QuadPoints 的包围盒** —— 多行高亮各行宽度不同，
 *    写小了会被查看器按 Rect 裁剪 /AP。
 *
 * 3. **`/T` `/Contents` `/NM` `/M` `/DA` 一律 `PDFString.of()`**
 *    `PDFContext.obj()` 的重载里 `obj(string) → PDFName`，直接传 JS 字符串会写成
 *    `/edge-pdf-lite`（Name）而不是 `(edge-pdf-lite)`（String）。自家读回来"看着还行"，
 *    严格查看器里作者名与批注内容是错的。
 *
 * 4. **`InkList` 用页面坐标**，不是相对 Rect 的坐标。
 *
 * ⚠️ 目前跑在主线程。项目定位里有 20–50MB 的大文件，那时应该搬到 Web Worker
 * （方案里也是这么定的）—— 这一版先保证功能正确，UI 上用遮罩把等待时间显性化。
 */

import { PDFDocument, PDFString, PDFHexString } from '@cantoo/pdf-lib'
import type { PDFRef } from '@cantoo/pdf-lib'
import type { Annotation, InkAnnot, RectAnnot, FreeTextAnnot } from './types'
import { isMarkup, normalizeRect, bboxOfQuads, bboxOfPoints } from './types'

/** 写进 `/T` 的作者名 —— 也是「识别哪些批注是我们写的」的唯一可靠依据
 *（pdf.js 不读 /NM，实测 `getAnnotations().id` 是对象引用） */
export const ANNOT_AUTHOR = 'edge-pdf-lite'

type Rgb = [number, number, number]

/**
 * 交给 `pdf.context.obj()` 的字面量字典。
 *
 * pdf-lib 的 `obj()` 靠 instanceof 决定怎么转：
 *  - **`PDFObject` 子类（PDFRef / PDFString …）原样透传**
 *  - **JS string → PDFName**（这是为什么会踩「`/T` 写成 `/edge-pdf-lite`」的坑）
 *
 * 所以这里把「PDFObject 实例」也列进联合类型，逼自己每次都显式包一层 `PDFString.of()`。
 */
interface LitDict {
  [key: string]: LitValue
}
type LitValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | PDFRef
  | PDFString
  | PDFHexString
  | LitValue[]
  | LitDict

function pdfDate(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const tz = -d.getTimezoneOffset()
  const sign = tz >= 0 ? '+' : '-'
  const abs = Math.abs(tz)
  return (
    `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}'${p(abs % 60)}'`
  )
}

function num(v: number): string {
  // PDF 内容流里小数位数没必要多到影响体积；同时避免出现 "1e-7" 这种科学计数法
  return Number.isFinite(v) ? v.toFixed(4).replace(/\.?0+$/, '') || '0' : '0'
}

/**
 * 构造一个 `Form XObject` 作为 `/AP`。
 * @param rect 注释 /Rect（页面坐标）
 * @param build `(originX, originY) => 内容流`，坐标请写成 `页面坐标 − origin`
 */
function makeForm(
  pdf: PDFDocument,
  rect: [number, number, number, number],
  build: (ox: number, oy: number) => string,
  resources?: LitDict,
): PDFRef {
  const [x0, y0, x1, y1] = rect
  const content = build(x0, y0)
  const stream = pdf.context.stream(content, {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, x1 - x0, y1 - y0],
    // ⚠️ 单位矩阵。**不要**自己平移 —— 查看器会做 bbox→Rect 的映射。
    Matrix: [1, 0, 0, 1, 0, 0],
    ...(resources ? { Resources: resources } : {}),
  })
  return pdf.context.register(stream)
}

/**
 * 高亮的填充外观。
 *
 * ⚠️ **必须走 Multiply 混合**（`/GS0 gs` → ExtGState 里 `BM=Multiply`）。
 * 只填一个不透明/半透明的黄色矩形，会把**文字整片盖住** —— 实测第一版就是这样：
 * Line 2 / Line 3 的文字在高亮里完全看不见，高亮反而让内容不可读。
 * Adobe 自家生成的高亮也是这么做的（Multiply 让底色透出文字）。
 *
 * @param gsName ExtGState 的名字（在 /AP 的 /Resources 里定义）
 */
function fillQuads(quads: number[], color: Rgb, ox: number, oy: number, gsName?: string): string {
  const [r, g, b] = color
  let s = `q\n${gsName ? `/${gsName} gs\n` : ''}${num(r)} ${num(g)} ${num(b)} rg\n`
  for (let i = 0; i < quads.length; i += 8) {
    const xs = [quads[i]!, quads[i + 2]!, quads[i + 4]!, quads[i + 6]!].map((v) => v - ox)
    const ys = [quads[i + 1]!, quads[i + 3]!, quads[i + 5]!, quads[i + 7]!].map((v) => v - oy)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    s += `${num(minX)} ${num(minY)} ${num(maxX - minX)} ${num(maxY - minY)} re\n`
  }
  return s + 'f\nQ\n'
}

function strokeAcrossQuads(
  quads: number[],
  color: Rgb,
  ox: number,
  oy: number,
  at: number,
  width: number,
): string {
  const [r, g, b] = color
  let s = `q\n${num(r)} ${num(g)} ${num(b)} RG\n${num(width)} w\n1 J\n`
  for (let i = 0; i < quads.length; i += 8) {
    const lx = quads[i]!
    const ly = quads[i + 1]!
    const lby = quads[i + 5]!
    const rx = quads[i + 2]!
    const ry = quads[i + 3]!
    const rby = quads[i + 7]!
    // at=0.94 → 贴底（下划线）；at=0.5 → 居中（删除线）
    const y1 = ly + (lby - ly) * at
    const y2 = ry + (rby - ry) * at
    s += `${num(lx - ox)} ${num(y1 - oy)} m\n${num(rx - ox)} ${num(y2 - oy)} l\n`
  }
  return s + 'S\nQ\n'
}

function strokeInk(a: InkAnnot, ox: number, oy: number): string {
  const [r, g, b] = a.color
  let s = `q\n${num(r)} ${num(g)} ${num(b)} RG\n${num(a.lineWidth)} w\n1 J\n1 j\n`
  for (const stroke of a.strokes) {
    if (stroke.length < 4) {
      if (stroke.length === 2) {
        s += `${num(stroke[0]! - ox)} ${num(stroke[1]! - oy)} m\n${num(stroke[0]! - ox)} ${num(stroke[1]! - oy)} l\n`
      }
      continue
    }
    s += `${num(stroke[0]! - ox)} ${num(stroke[1]! - oy)} m\n`
    for (let i = 2; i < stroke.length; i += 2) {
      s += `${num(stroke[i]! - ox)} ${num(stroke[i + 1]! - oy)} l\n`
    }
  }
  return s + 'S\nQ\n'
}

function strokeRect(a: RectAnnot, rect: [number, number, number, number]): string {
  const [r, g, b] = a.color
  const w = rect[2] - rect[0]
  const h = rect[3] - rect[1]
  // 按 ISO，Square 的外观应在 Rect 内缩半个线宽，避免线宽溢出被裁
  const inset = a.lineWidth / 2
  return (
    `q\n${num(r)} ${num(g)} ${num(b)} RG\n${num(a.lineWidth)} w\n` +
    `${num(inset)} ${num(inset)} ${num(Math.max(0, w - a.lineWidth))} ${num(Math.max(0, h - a.lineWidth))} re\nS\nQ\n`
  )
}

/** 只有纯 ASCII 才画进 /AP —— 中文字形不在标准 14 字体里，硬画会变成一串问号 */
function isAscii(s: string): boolean {
  return /^[\x20-\x7E\r\n\t]*$/.test(s)
}

/**
 * 文本串（PDF 的 text string）。
 *
 * ⚠️ **非 ASCII 必须走 UTF-16BE 十六进制串**：`PDFString.of('中文')` 会把
 * 每个码位按 latin-1 单字节写出（0x4E2D → 0x2D），读回来就是一串乱码 ——
 * 实测「中文 /Contents 读不回来」就是这么来的。
 * `PDFHexString.fromText()` 内部走 `utf16Encode`（带 BOM `FEFF`），
 * 查看器按 BOM 识别后解码，中文才对。
 */
function textString(s: string): PDFString | PDFHexString {
  return isAscii(s) ? PDFString.of(s) : PDFHexString.fromText(s)
}

function freeTextAppearance(a: FreeTextAnnot, rect: [number, number, number, number]): string | null {
  const [r, g, b] = a.color
  const w = rect[2] - rect[0]
  const h = rect[3] - rect[1]
  const box =
    `q\n0.55 0.55 0.55 RG\n0.8 w\n0 0 ${num(w)} ${num(h)} re\nS\n` +
    `1 1 1 rg\n0.5 0.5 ${num(Math.max(0, w - 1))} ${num(Math.max(0, h - 1))} re\nf\nQ\n`
  if (!isAscii(a.text)) {
    // 交给查看器用系统字体渲染（各查看器表现略有差异，但比画成问号好）
    return box
  }
  const fs = a.fontSize
  const lines = a.text.split('\n')
  let text = `q\nBT\n/Helv ${num(fs)} Tf\n${num(r)} ${num(g)} ${num(b)} rg\n${num(fs * 1.25)} TL\n1 0 0 1 ${num(3)} ${num(h - fs * 1.15)} Tm\n`
  lines.forEach((ln, i) => {
    const esc = ln.replace(/[\\()]/g, (c) => '\\' + c)
    text += i === 0 ? `(${esc}) Tj\n` : `T*\n(${esc}) Tj\n`
  })
  text += 'ET\nQ\n'
  return box + text
}

/**
 * 兜底重算 /Rect —— 它**必须**包住实际内容，否则查看器按 Rect 裁 /AP。
 * 编辑器一般会算对，但手写笔迹的线宽外扩、多行高亮的行宽差异都容易漏。
 */
function safeRect(a: Annotation): [number, number, number, number] {
  if (isMarkup(a)) return bboxOfQuads(a.quads)
  if (a.kind === 'ink') return bboxOfPoints(a.strokes.flat(), a.lineWidth / 2)
  return normalizeRect(a.rect)
}

/** 把一条批注转成 PDF 注释字典 */
function annotDict(pdf: PDFDocument, a: Annotation, fontRef: PDFRef | null): LitDict {
  const rect = safeRect(a)
  const [x0, y0] = rect
  const created = pdfDate(new Date(a.created))
  const modified = pdfDate(new Date(a.modified))

  const common: LitDict = {
    Type: 'Annot',
    Rect: rect,
    // ⚠️ 必须显式包成 text string：直接传 JS 字符串会被 obj() 当成 PDFName
    Contents: textString(a.contents ?? ''),
    T: textString(ANNOT_AUTHOR),
    M: textString(modified),
    CreationDate: textString(created),
    NM: textString(`epl:${a.id}`),
    F: 4, // Print —— 不加这个，批注在打印/导出时不出现
  }

  let subtype: string
  let extra: LitDict = {}
  let apContent: string | null = null
  let resources: LitDict | undefined

  if (isMarkup(a)) {
    subtype = a.kind === 'highlight' ? 'Highlight' : a.kind === 'underline' ? 'Underline' : 'StrikeOut'
    extra = {
      QuadPoints: a.quads,
      C: a.color,
      // ⚠️ 高亮必须 CA=1：这是查看器对整条注释再叠一次的 alpha，
      // 一旦 <1 就在 multiply 之上又盖了层半透明板，字还是会被冲淡。
      CA: a.kind === 'highlight' ? 1 : a.opacity,
    }
    if (a.kind === 'highlight') {
      apContent = fillQuads(a.quads, a.color, x0, y0, 'GS_HL')
      // Multiply 混合：底色乘上页面内容，文字保持可读。
      // 不加这条，高亮就是一块盖住文字的色块（实测）。
      //
      // ⚠️ **ca 必须是 1，不能用 a.opacity。** alpha<1 时混合结果在"原色"和
      // "乘积"之间插值 → 黑字被冲成灰橄榄色。这是"高亮影响字本身颜色"的根因，
      // 应用内渲染那边同理（draw.ts 强制 globalAlpha=1）。
      // 高亮的"浓淡"由颜色本身决定，不由 alpha 决定。
      resources = {
        ExtGState: {
          GS_HL: pdf.context.register(pdf.context.obj({ BM: 'Multiply', ca: 1, CA: 1 })),
        },
      }
    } else {
      apContent = strokeAcrossQuads(a.quads, a.color, x0, y0, a.kind === 'underline' ? 0.94 : 0.5, 1.2)
    }
  } else if (a.kind === 'ink') {
    subtype = 'Ink'
    extra = {
      // ⚠️ 页面坐标，不是相对 Rect 的坐标
      InkList: a.strokes,
      C: a.color,
      CA: a.opacity,
      BS: { W: a.lineWidth, S: 'S' },
    }
    apContent = strokeInk(a, x0, y0)
  } else if (a.kind === 'rect') {
    subtype = 'Square'
    extra = {
      C: a.color,
      CA: a.opacity,
      BS: { W: a.lineWidth, S: 'S' },
    }
    apContent = strokeRect(a, rect)
  } else {
    subtype = 'FreeText'
    extra = {
      DA: textString(`/Helv ${a.fontSize} Tf ${a.color.map(num).join(' ')} rg`),
      Q: 0,
    }
    apContent = freeTextAppearance(a, rect)
    // 外观流里 Tf 引用了 /Helv，资源字典必须真的给上一个字体 ref，
    // 否则查看器解析 /AP 时找不到字体（有的会整条不画）。
    if (fontRef && isAscii(a.text)) resources = { Font: { Helv: fontRef } }
  }

  const dict: LitDict = { ...common, Subtype: subtype, ...extra }
  if (apContent) {
    dict.AP = { N: makeForm(pdf, rect, () => apContent!, resources) }
  }
  return dict
}

/**
 * 生成一份带批注的 PDF。
 *
 * `incremental` 走 `forIncrementalUpdate + commit`：只追加差异，
 * 对 20–50MB 的文件比整档重写快得多、峰值内存也低得多。
 * 失败时（比如原文件有异常结构）自动退回全量 `save()`。
 */
export async function buildAnnotatedPdf(
  original: Uint8Array,
  annotations: readonly Annotation[],
  /**
   * `incremental: false` 强制走全量重写 —— **只为做性能对照**。
   * 产品路径永远用增量（增量失败时 writer 自己会退回全量）。
   */
  opts: { incremental?: boolean } = {},
): Promise<Uint8Array> {
  const byPage = new Map<number, Annotation[]>()
  for (const a of annotations) {
    const arr = byPage.get(a.pageNumber)
    if (arr) arr.push(a)
    else byPage.set(a.pageNumber, [a])
  }

  // 只有「ASCII 的浮动文本框」才真的需要往 /AP 里画字 —— 中文交给查看器自己渲染。
  // 按需 embed，避免每个文件都白白多一个字体对象（增量更新下也是实打实的字节）。
  const needsFont = annotations.some((a) => a.kind === 'freetext' && isAscii(a.text))

  const tryBuild = async (incremental: boolean): Promise<Uint8Array> => {
    const pdf = await PDFDocument.load(original, {
      forIncrementalUpdate: incremental,
      updateMetadata: false,
    })

    const helvRef = needsFont ? (await pdf.embedFont('Helvetica')).ref : null

    for (const [pageNumber, list] of byPage) {
      // addAnnot() 内部会 normalize：页面本来没有 /Annots 时自动建一个空数组。
      // 自己手写 lookup + push 容易漏掉「/Annots 是间接引用」这一种情况。
      const page = pdf.getPage(pageNumber - 1)
      for (const a of list) {
        const ref = pdf.context.register(pdf.context.obj(annotDict(pdf, a, helvRef)))
        page.node.addAnnot(ref)
      }
    }

    return incremental ? await pdf.commit() : await pdf.save({ useObjectStreams: true })
  }

  if (opts.incremental === false) return tryBuild(false)

  try {
    return await tryBuild(true)
  } catch (e) {
    console.warn('[annot] 增量保存失败，退回全量重写：', e)
    return await tryBuild(false)
  }
}

/** 建议的导出文件名 */
export function annotatedFileName(original: string): string {
  const base = original.replace(/\.pdf$/i, '')
  return `${base}(已批注).pdf`
}
