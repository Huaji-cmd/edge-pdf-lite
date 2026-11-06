/**
 * PDF 页内查找的**纯逻辑**：文本项 → 可搜索文本 + 匹配区间。
 *
 * 与渲染的分工：这里只算"第几页第几个文本项的第几到第几个字符"，
 * 不碰 DOM；打标（span 里包 <mark>）在 PdfViewer 里做 —— 那需要
 * TextLayer 的 textDivs 映射，是渲染侧的事。
 *
 * ⚠️ 文本来源必须与文本层**同参数**（`includeMarkedContent: true,
 * disableNormalization: true`，见 pageRenderer.buildTextLayer）——
 * 否则 item 顺序/内容对不上，打标会错位。
 */

export interface PdfPageText {
  page: number
  /** 每个文本项的原始字符串（与 TextLayer.textDivs 下标对齐） */
  items: string[]
  /** 全页拼接文本（items 顺序连接） */
  text: string
  /** starts[i] = items[i] 在 text 里的起始偏移 */
  starts: number[]
  /** ys[i] = items[i] 基线在**页面坐标**（原点左下）里的 y —— 跳转定位用 */
  ys: number[]
}

/** 从 pdf.js 的 textContent.items 构建（只取 str） */
export function buildPageText(
  page: number,
  rawItems: { str?: string; transform?: number[] }[],
): PdfPageText {
  const items: string[] = []
  const starts: number[] = []
  const ys: number[] = []
  let text = ''
  for (const it of rawItems) {
    const s = it.str ?? ''
    starts.push(text.length)
    text += s
    items.push(s)
    // transform[5] = 基线 y（PDF 页面坐标，原点左下）—— goToDestination 吃这个坐标系
    ys.push(Array.isArray(it.transform) ? it.transform[5] : 0)
  }
  return { page, items, text, starts, ys }
}

export interface PdfMatchSegment {
  /** 文本项下标（对应 textDivs） */
  item: number
  /** 该项内匹配的 [start, end) */
  start: number
  end: number
}

export interface PdfMatch {
  page: number
  /** 一个匹配可能跨多个文本项（pdf.js 常把一行拆成多个 item） */
  segments: PdfMatchSegment[]
}

/**
 * 在一页里找出全部匹配（大小写不敏感）。
 *
 * 已知取舍：**跨行不匹配** —— item 的拼接里行与行直接相连（pdf.js 的
 * hasEOL 不产生字符），但一行内跨 item 的词支持（segments 拆段）；
 * 真正"词被换行拆开"的匹配没有意义（视觉上断成两半），不搜。
 *
 * 上限 cap：全文匹配数到 cap 就停 —— 上千个 mark 在低配机上滚动发涩。
 */
export function findInPage(pt: PdfPageText, query: string, cap: number): PdfMatch[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hay = pt.text.toLowerCase()
  const out: PdfMatch[] = []
  let i = hay.indexOf(q)
  while (i >= 0 && out.length < cap) {
    const end = i + q.length
    // 命中区间 [i, end) 拆到所属 item
    const segments: PdfMatchSegment[] = []
    for (let k = 0; k < pt.items.length; k++) {
      const s = pt.starts[k]
      const e = s + pt.items[k].length
      if (e <= i || s >= end) continue
      segments.push({
        item: k,
        start: Math.max(0, i - s),
        end: Math.min(pt.items[k].length, end - s),
      })
    }
    if (segments.length) out.push({ page: pt.page, segments })
    i = hay.indexOf(q, end)
  }
  return out
}
