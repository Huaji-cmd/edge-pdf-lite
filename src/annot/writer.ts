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
import type { PDFRef, PDFFont } from '@cantoo/pdf-lib'
import type { Annotation, InkAnnot, RectAnnot, FreeTextAnnot } from './types'
import { isMarkup, normalizeRect, bboxOfQuads, bboxOfPoints } from './types'
import { lineHeightOf, textPad } from './textWrap'

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

/**
 * 中文批注的"占位横线"（**只在拿不到中文字体时**用）。
 *
 * 拿不到字体（比如浏览器版）时，画不了字但也不能什么都不画 —— 详见
 * `freeTextAppearance` 里那段说明。每行长度递减，看起来像一段自然结束的文字。
 *
 * ⚠️ 内边距和行高**必须和英文文本框、以及应用内绘制取同一套值**
 *（`textPad` / `lineHeightOf`），否则中英文混排在同一页上会明显对不齐。
 */
function placeholderLines(w: number, h: number, fs: number): string {
  const pad = textPad(fs)
  const lh = lineHeightOf(fs)
  const bar = lh * 0.42
  const rows = Math.max(1, Math.min(8, Math.floor((h - pad * 2) / lh)))
  let s = 'q\n0.74 0.74 0.78 rg\n'
  for (let i = 0; i < rows; i++) {
    // 画在"那一行的中线上"，而不是贴着行顶 —— 否则看起来像行距不均匀
    const y = h - pad - i * lh - (lh + bar) / 2
    // 末行短一截，看起来才像一段自然结束的文字
    const lw = Math.max(12, (w - pad * 2) * (i === rows - 1 ? 0.52 : 1))
    s += `${num(pad)} ${num(y)} ${num(lw)} ${num(bar)} re\nf\n`
  }
  return s + 'Q\n'
}

/** `/AP` 里给嵌入字体起的资源名（`/DA` 里也用它，两处必须一致） */
const CJK_FONT_NAME = 'CJK'

/**
 * 文本框的 `/AP` 外观流。
 *
 * 🔴 **没有灰框、也没有白底** —— 这是刻意的，和"应用内只画字"（`draw.ts`）一致。
 * 用户要的是"收起编辑框之后文字跟 PDF 融为一体"；只要这里还画着框，
 * 文件拿到 Edge / Acrobat 里打开就会又变成一个框住的方块，
 * 比"一直有框"更让人困惑。
 *
 * ⚠️ 历史上这里画过白底，理由是"文字压在图片上会看不清" —— 但那个理由不成立到
 * 值得上边框的程度：真需要底色的场景应该由用户自己选（背景是内容的一部分），
 * 而不是我们替他加一个白板。
 *
 * ## 中文字形
 *
 * 标准 14 字体里没有 CJK 字形，所以：
 *   · **有嵌入字体**（`cjkFont`）→ 用它逐行编码成 glyph id 写 `Tj`，中文真的画出来；
 *   · **没有**（浏览器版 / 系统里找不到字体）→ 退回占位横线，**并让调用方提示用户**。
 *     文字本身在 `/Contents` 里一个字节都没丢。
 */
function freeTextAppearance(
  a: FreeTextAnnot,
  rect: [number, number, number, number],
  cjkFont: PDFFont | null,
): string | null {
  const [r, g, b] = a.color
  const w = rect[2] - rect[0]
  const h = rect[3] - rect[1]
  const fs = a.fontSize
  const pad = textPad(fs)
  const lh = lineHeightOf(fs)
  const ascii = isAscii(a.text)

  if (!ascii && !cjkFont) return placeholderLines(w, h, fs)

  /*
   * 首行基线 = 顶边 - 内边距 - 约 0.8em 的字身高度。
   *
   * ⚠️ 用 0.8em 而不是字体自己的 ascent：应用内绘制（canvas 的 textBaseline=top）
   *    与这里必须对得上，而 canvas 那边没法按字体真实 ascent 摆。中英文字体
   *    ascent 都在 0.75~0.88em 之间，取 0.8 是一致性最好的一档（实测偏离 <1pt）。
   */
  const fontName = ascii ? 'Helv' : CJK_FONT_NAME
  let text =
    `q\nBT\n/${fontName} ${num(fs)} Tf\n${num(r)} ${num(g)} ${num(b)} rg\n${num(lh)} TL\n` +
    `1 0 0 1 ${num(pad)} ${num(h - pad - fs * 0.8)} Tm\n`
  a.text.split('\n').forEach((ln, i) => {
    if (i > 0) text += 'T*\n'
    if (!ln) return
    if (ascii) {
      const esc = ln.replace(/[\\()]/g, (c) => '\\' + c)
      text += `(${esc}) Tj\n`
    } else {
      // encodeText → `<00010002…>`（Identity-H 下的 glyph id），中英混排走同一个字体
      text += `${cjkFont!.encodeText(ln).toString()} Tj\n`
    }
  })
  text += 'ET\nQ\n'
  return text
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

/**
 * Multiply 混合用的 ExtGState 资源（文本高亮与区域高亮共用）。
 *
 * 底色乘上页面内容：白底 (1,1,1) × 黄 = 黄（背景上色），
 * 黑字 (0,0,0) × 黄 = 黑（字一个像素都不变）。
 * 不加这条，高亮就是一块盖住文字的色块（实测）。
 *
 * ⚠️ **ca 必须是 1，不能用 `a.opacity`。** alpha<1 时混合结果在"原色"和
 * "乘积"之间插值 → 黑字被冲成灰橄榄色。这是"高亮影响字本身颜色"的根因，
 * 应用内渲染那边同理（draw.ts 对这两个种类强制 `globalAlpha = 1`）。
 * **高亮的浓淡由颜色本身决定，不由 alpha 决定。**
 */
function multiplyGs(pdf: PDFDocument): LitDict {
  return {
    ExtGState: {
      GS_HL: pdf.context.register(pdf.context.obj({ BM: 'Multiply', ca: 1, CA: 1 })),
    },
  }
}

/** 把一条批注转成 PDF 注释字典 */
function annotDict(
  pdf: PDFDocument,
  a: Annotation,
  fontRef: PDFRef | null,
  cjkFont: PDFFont | null,
): LitDict {
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
      resources = multiplyGs(pdf)
    } else {
      apContent = strokeAcrossQuads(a.quads, a.color, x0, y0, a.kind === 'underline' ? 0.94 : 0.5, 1.2)
    }
  } else if (a.kind === 'area') {
    /*
     * 区域高亮 → **标准 `/Highlight`**，QuadPoints = 矩形四角。
     *
     * ⚠️ 刻意不发明新的注释类型。扫描件上没有文本层，但"把这块盖住"这个语义
     * 用 Highlight 表达完全够 —— 换来的是**任何查看器都能正常画**
     * （PDFium / Acrobat / pdf.js 都认 Highlight + QuadPoints）。
     *
     * ⚠️ QuadPoints 必须 **Z 序**（左上→右上→左下→右下）。实测用逆时针序会错位。
     */
    const [ax0, ay0, ax1, ay1] = normalizeRect(a.rect)
    const quads = [ax0, ay1, ax1, ay1, ax0, ay0, ax1, ay0]
    subtype = 'Highlight'
    extra = { QuadPoints: quads, C: a.color, CA: 1 }
    apContent = fillQuads(quads, a.color, x0, y0, 'GS_HL')
    resources = multiplyGs(pdf)
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
    const ascii = isAscii(a.text)
    const fontName = ascii ? 'Helv' : CJK_FONT_NAME
    extra = {
      DA: textString(`/${fontName} ${a.fontSize} Tf ${a.color.map(num).join(' ')} rg`),
      Q: 0,
    }
    apContent = freeTextAppearance(a, rect, cjkFont)
    /*
     * 外观流里 Tf 引用了字体，资源字典必须真的给上一个字体 ref，
     * 否则查看器解析 /AP 时找不到字体（有的会整条不画 / 画成豆腐块）。
     * 中文那条用的是嵌入的子集字体，英文那条用共享的 Helvetica。
     */
    if (ascii && fontRef) resources = { Font: { Helv: fontRef } }
    else if (!ascii && cjkFont) resources = { Font: { [CJK_FONT_NAME]: cjkFont.ref } }
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
   *
   * `cjkFont`：系统中文字体的字节。**只有含中文的文本框才需要**；
   * 不给就退回"占位横线"（浏览器版的现状），不会报错。
   */
  opts: { incremental?: boolean; cjkFont?: Uint8Array | null } = {},
): Promise<Uint8Array> {
  const byPage = new Map<number, Annotation[]>()
  for (const a of annotations) {
    const arr = byPage.get(a.pageNumber)
    if (arr) arr.push(a)
    else byPage.set(a.pageNumber, [a])
  }

  // Helvetica 只给纯 ASCII 文本框用；中文走嵌入字体。
  // 按需 embed，避免每个文件都白白多一个字体对象（增量更新下也是实打实的字节）。
  const needsHelv = annotations.some((a) => a.kind === 'freetext' && isAscii(a.text))
  const needsCjk = annotations.some((a) => a.kind === 'freetext' && !isAscii(a.text))

  const tryBuild = async (incremental: boolean): Promise<Uint8Array> => {
    const pdf = await PDFDocument.load(original, {
      forIncrementalUpdate: incremental,
      updateMetadata: false,
    })

    const helvRef = needsHelv ? (await pdf.embedFont('Helvetica')).ref : null

    /*
     * 嵌入中文字体。
     *
     * ⚠️ **必须 `subset: true`**：全量嵌入是 9.7 MB，一份 PDF 直接从几百 KB 变成
     *    10 MB。子集化之后只带用到的字形，实测一份三行中文的 PDF 只多 ~3 KB。
     *
     * ⚠️ registerFontkit 是**实例方法**，每份新 PDFDocument 都要注册一次
     *    （不能只在模块顶层注册到某个静态位置）。
     *
     * ⚠️ fontkit **按需动态加载**（约 370 KB）：绝大多数保存是纯高亮 / 手写，
     *    不该为"可能有中文"付这笔下载/解析。项目定位就是"只在必须付的时候付一次"。
     */
    let cjkFont: PDFFont | null = null
    if (needsCjk && opts.cjkFont && opts.cjkFont.length > 0) {
      const fontkit = (await import('@cantoo/fontkit')).default
      pdf.registerFontkit(fontkit)
      cjkFont = await pdf.embedFont(opts.cjkFont, { subset: true })
    }

    for (const [pageNumber, list] of byPage) {
      // addAnnot() 内部会 normalize：页面本来没有 /Annots 时自动建一个空数组。
      // 自己手写 lookup + push 容易漏掉「/Annots 是间接引用」这一种情况。
      const page = pdf.getPage(pageNumber - 1)
      for (const a of list) {
        const ref = pdf.context.register(pdf.context.obj(annotDict(pdf, a, helvRef, cjkFont)))
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
