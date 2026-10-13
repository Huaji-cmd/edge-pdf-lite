/**
 * 批注数据模型。
 *
 * 设计原则（与项目铁律一致）：
 *  1. **坐标一律存「PDF 页面空间」**（原点左下、单位 pt、未乘缩放）。
 *     视口坐标只是渲染时的瞬时换算结果，绝不落库 —— 否则换个缩放就全错位。
 *  2. 结构与 PDF 注释字典**一一对应**，写回时几乎不用转换（见 `toAnnotDict` 的映射）。
 *  3. 大对象不进 Vue 响应式：本模块的实例全部由 `AnnotationStore` 以非响应式方式持有。
 */

/** 批注种类 —— 与 PDF 注释子类型对应 */
export type AnnotKind =
  /** 文本高亮（选中文字） */
  | 'highlight'
  /** **区域高亮**：拖一个框直接盖住一块，**不依赖文本层** */
  | 'area'
  /** 下划线 */
  | 'underline'
  /** 删除线 */
  | 'strikeout'
  /** 自由手写 */
  | 'ink'
  /** 矩形框（扫描件上圈重点） */
  | 'rect'
  /** 浮动文本框 */
  | 'freetext'

/** RGB，分量 0..1（PDF 的 /C 就是这个量纲） */
export type Rgb = [number, number, number]

/** 页面空间矩形 [x0, y0, x1, y1] */
export type Rect = [number, number, number, number]

interface AnnotBase {
  /** 稳定 id（不含前缀），写回时 `NM = 'epl:' + id` */
  id: string
  pageNumber: number
  /** 页面空间包围盒 —— **必须**包住实际内容（查看器会按它裁剪 /AP） */
  rect: Rect
  color: Rgb
  /** /CA 透明度 0..1 */
  opacity: number
  /** 批注文字内容（/Contents），支持中文 */
  contents?: string
  /** 创建时间，ISO 串 */
  created: string
  /** 修改时间，ISO 串 */
  modified: string
}

export interface TextMarkupAnnot extends AnnotBase {
  kind: 'highlight' | 'underline' | 'strikeout'
  /**
   * 四边形列表，**页面坐标**，**Z 序**（左上→右上→左下→右下），每 8 个数一个四边形。
   *
   * ⚠️ 顺序必须 Z 序 —— 实测（Edge 里 P2 vs P3 对照）用逆时针序会**错位**。
   */
  quads: number[]
  /** 高亮覆盖的原文（pdf.js 的 `overlaidText` 会帮我们抽好，便于做批注列表） */
  overlaidText?: string
}

/**
 * 区域高亮。
 *
 * **存在的理由**：扫描件（《现代操作系统教程》就是整页图片）**没有文本层**，
 * TextMarkup 类批注无处依附 —— 在这类书上高亮/下划线/删除线一条都画不出来。
 * 而这类书的标注需求本来就只是"把这一段盖住"，压根不需要知道文字在哪。
 *
 * ⚠️ 写回时落成**标准 `/Highlight` 子类型**（QuadPoints = 矩形四角），
 * 而不是发明一个新的注释类型 —— 任何查看器都能正常显示，这是跨查看器兼容的前提。
 */
export interface AreaAnnot extends AnnotBase {
  kind: 'area'
}

export interface InkAnnot extends AnnotBase {
  kind: 'ink'
  /**
   * 笔画列表，每笔是一串点 `[x0,y0,x1,y1,...]`，**页面坐标**。
   * ⚠️ 用页面坐标而不是相对 Rect 的坐标 —— 实测 pdf.js 无 /AP 时会直接拿它生成
   * 内容流、不做任何偏移换算。
   */
  strokes: number[][]
  /** 线宽（pt） */
  lineWidth: number
}

export interface RectAnnot extends AnnotBase {
  kind: 'rect'
  lineWidth: number
}

export interface FreeTextAnnot extends AnnotBase {
  kind: 'freetext'
  text: string
  fontSize: number
}

export type Annotation = TextMarkupAnnot | AreaAnnot | InkAnnot | RectAnnot | FreeTextAnnot

/** 各工具默认外观 —— 改这里就能换配色 */
export const PALETTE: Record<AnnotKind, Rgb> = {
  highlight: [1, 0.92, 0.23],
  area: [1, 0.92, 0.23],
  underline: [0.13, 0.4, 0.92],
  strikeout: [0.9, 0.19, 0.19],
  ink: [0.9, 0.19, 0.19],
  rect: [0.9, 0.19, 0.19],
  freetext: [0.13, 0.4, 0.92],
}

/**
 * 可调色板。
 *
 * 为什么固定 10 个色而不是放个 `<input type=color>`：
 * 高亮/手写要的是"一眼认出自己上周画的是哪种"，而不是精确到 #7F3A2B 的自由。
 * 固定色板还能让"导出到别的查看器"后的观感可控（/C 就是这几个值）。
 */
export const SWATCHES: readonly Rgb[] = [
  [1, 0.92, 0.23], // 黄
  [1, 0.6, 0.15], // 橙
  [0.9, 0.19, 0.19], // 红
  [0.92, 0.3, 0.62], // 粉
  [0.55, 0.36, 0.96], // 紫
  [0.13, 0.4, 0.92], // 蓝
  [0.1, 0.72, 0.55], // 绿
  [0.35, 0.35, 0.4], // 灰
  [0.07, 0.07, 0.09], // 黑
  [1, 1, 1], // 白
]

/**
 * 高亮**不能**用哪些颜色。
 *
 * 高亮靠 Multiply 染背景（黑 × 任何色 = 黑，所以字本身不动）。这条性质有个直接推论：
 * - **黑 / 近黑**：整行被乘成黑的，字直接消失 —— 比"盖板"还糟；
 * - **白**：乘以白等于什么都没做，画了跟没画一样。
 *
 * 其余颜色（含红、蓝、紫这些中等亮度的）都没问题：字仍是黑的，只是底色变了，
 * 对比度反而更高。所以只挡掉亮度两端的极端值，不用另做一套色板。
 */
function usableAsHighlight(c: Rgb): boolean {
  const lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
  return lum >= 0.3 && lum <= 0.97
}

/** 高亮工具可选的色板（就是 SWATCHES 去掉黑/白） */
export const HIGHLIGHT_SWATCHES: readonly Rgb[] = SWATCHES.filter(usableAsHighlight)

/**
 * 哪些工具走"Multiply 染背景"（高亮 + 区域高亮）。
 *
 * 两者是同一个渲染路径：alpha=1 的 Multiply，所以受同一条颜色约束
 * （不能用黑/白，理由见 `usableAsHighlight`）。
 */
function blendsIntoBackground(kind: ToolKind): boolean {
  return kind === 'highlight' || kind === 'area'
}

/** 某个工具该显示哪套色板 */
export function swatchesFor(kind: ToolKind): readonly Rgb[] {
  return blendsIntoBackground(kind) ? HIGHLIGHT_SWATCHES : SWATCHES
}

/**
 * 读回历史配色时的兜底。
 *
 * localStorage 里可能是**旧版本存的黑/白高亮色**（那时还没有这条约束）。
 * 不兜的话，用户换了版本会莫名其妙画出一行黑条，还不知道怎么恢复。
 */
export function sanitizeToolColor(kind: ToolKind, c: Rgb): Rgb {
  if (!blendsIntoBackground(kind) || usableAsHighlight(c)) return c
  const fallback = kind === 'area' ? PALETTE.area : PALETTE.highlight
  return [...fallback] as Rgb
}

/**
 * **指针模式** —— 决定"左键按在空白/批注上"时做什么，与「批注工具」是两套正交的状态。
 *
 *   · `select` 选择：点批注可选中并拖动 / 改大小；空白处仍归浏览器做文字选择。
 *   · `scroll` 滚动：纯阅读。与 select 的唯一区别是**不响应批注点选** ——
 *     避免"想翻页结果把批注拖走了"这种误操作（批注是内容，拖坏很难发现）。
 *   · `pan`   拖动：抓手平移画布。放大到 300% 后这是唯一舒服的移动方式。
 *
 * ⚠️ 三态互斥由上层保证（见 App.vue）：选工具会自动回到 select，切 pan 会自动清工具。
 * 不这么做的话会留下"到底画还是拖"的歧义状态，用户只能靠试出来。
 */
export type PointerMode = 'select' | 'scroll' | 'pan'

export const POINTER_MODES: readonly PointerMode[] = ['select', 'scroll', 'pan']

export const POINTER_MODE_LABEL: Record<PointerMode, string> = {
  select: '选择',
  scroll: '滚动',
  pan: '拖动',
}

/** 可改色的工具（'none' / 'eraser' 没有颜色概念） */
export type ColorTool = Exclude<ToolKind, 'none' | 'eraser'>

export const COLOR_TOOLS: readonly ColorTool[] = [
  'highlight',
  'area',
  'underline',
  'strikeout',
  'ink',
  'rect',
  'freetext',
]

export function isColorTool(t: ToolKind): t is ColorTool {
  return COLOR_TOOLS.includes(t as ColorTool)
}

/** 各工具的默认配色（会被用户在工具栏里改掉，改完存 localStorage） */
export type ToolColors = Record<ColorTool, Rgb>

export function defaultToolColors(): ToolColors {
  return {
    highlight: [...PALETTE.highlight] as Rgb,
    area: [...PALETTE.area] as Rgb,
    underline: [...PALETTE.underline] as Rgb,
    strikeout: [...PALETTE.strikeout] as Rgb,
    ink: [...PALETTE.ink] as Rgb,
    rect: [...PALETTE.rect] as Rgb,
    freetext: [...PALETTE.freetext] as Rgb,
  }
}

/**
 * 选中项摘要。
 *
 * 只带 UI 真正需要的三个标量（id / 种类 / 颜色），**不把批注本体塞进响应式** ——
 * 批注是"大数组 + 频繁改动"，套上深层 Proxy 会拖慢命中检测和重绘（见 store.ts 的说明）。
 * 工具栏靠这个渲染色板的选中态和"删除所选"按钮。
 */
export interface SelectedInfo {
  id: string
  kind: AnnotKind
  color: Rgb
}

/**
 * 哪些批注能被"改大小"。
 *
 * 文本高亮类（highlight/underline/strikeout）**只能平移** —— 它们跟着文字走，
 * 拉伸会让高亮脱离原文。但**区域高亮可以拉伸**：它没有依附的文字，框本身就是内容。
 */
export function isResizable(a: Annotation): boolean {
  return a.kind === 'area' || a.kind === 'ink' || a.kind === 'rect' || a.kind === 'freetext'
}

export const MARKUP_KINDS: readonly AnnotKind[] = ['highlight', 'underline', 'strikeout']

export function isMarkup(a: Annotation): a is TextMarkupAnnot {
  return a.kind === 'highlight' || a.kind === 'underline' || a.kind === 'strikeout'
}

/** 生成一个新的批注 id（写回时作为 /NM 的后半段） */
export function newAnnotId(): string {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(16).slice(2, 10)
  return rnd
}

/**
 * 求一组四边形的包围盒。
 *
 * ⚠️ 这不是"顺手优化" —— 是必须做对的一步：
 * 多行高亮各行宽度常常不同，如果 /Rect 只按第一行算，
 * 部分查看器会**按 /Rect 裁剪 /AP 外观流**，高亮看起来"被截断了一段"。
 * 样本 PDF 第一版就踩了这个坑。
 */
export function bboxOfQuads(quads: number[]): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < quads.length; i += 2) {
    const x = quads[i]!
    const y = quads[i + 1]!
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  if (!Number.isFinite(minX)) return [0, 0, 0, 0]
  return [minX, minY, maxX, maxY]
}

/** 求一组点的包围盒（Ink 用），可按线宽外扩 */
export function bboxOfPoints(points: number[], pad = 0): Rect {
  const r = bboxOfQuads(points)
  return [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad]
}

/** 归一化：保证 x0<=x1、y0<=y1 */
export function normalizeRect(r: Rect): Rect {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])]
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3])
}

export function pointInRect(x: number, y: number, r: Rect, pad = 0): boolean {
  return x >= r[0] - pad && x <= r[2] + pad && y >= r[1] - pad && y <= r[3] + pad
}

/** 当前工具 */
export type ToolKind =
  /** 不拦截任何指针事件 —— 正常阅读/选中/滚动 */
  | 'none'
  | 'highlight'
  | 'area'
  | 'underline'
  | 'strikeout'
  | 'ink'
  | 'rect'
  | 'freetext'
  | 'eraser'

export const MARKUP_TOOLS: readonly ToolKind[] = ['highlight', 'underline', 'strikeout']

export function isMarkupTool(t: ToolKind): boolean {
  return MARKUP_TOOLS.includes(t)
}

/** 各工具的默认线宽（pt） */
export const DEFAULT_LINE_WIDTH: Record<'ink' | 'rect', number> = {
  ink: 1.6,
  rect: 1.4,
}

/**
 * 手写笔尖粗细，三档（pt）。
 *
 * ⚠️ 存的是**实际线宽**，不是档位索引 —— `InkAnnot.lineWidth` 本来就是 pt，
 *    这样老数据里的任意线宽照样能画，也省掉"索引 → 宽度"一层映射
 *    （少一层映射就少一处改档位时忘记同步的地方）。
 *
 * 三档的比例取 1 : 2 : 4 —— 相邻两档在屏幕上要**一眼看出差别**，
 * 差别太小的档位等于没有（跟色板同一个道理：要的是"一眼认出"而不是精度）。
 */
export const INK_WIDTHS: readonly number[] = [0.8, 1.6, 3.2]

/** 三档的名字 */
export const INK_WIDTH_LABELS: readonly string[] = ['细', '中', '粗']

/** 默认档位 = 中间那档（1.6pt，与加这个功能之前的线宽一致，老用户手感不变） */
export const DEFAULT_INK_WIDTH: number = 1.6

/** 把任意线宽吸附到最近的档位（读 localStorage 时用，防止存进来越界的值） */
export function nearestInkWidth(w: unknown): number {
  if (typeof w !== 'number' || !Number.isFinite(w)) return DEFAULT_INK_WIDTH
  let best = INK_WIDTHS[0]!
  for (const v of INK_WIDTHS) {
    if (Math.abs(v - w) < Math.abs(best - w)) best = v
  }
  return best
}

