/**
 * PDF 大纲（书签 / 目录）解析。
 *
 * pdf.js 的 `getOutline()` 返回一棵树，但每条的 `dest` **还不能直接用**：
 *   · 可能是**字符串**（命名目标）→ 要再调 `getDestination(id)` 解析一次；
 *   · 是数组时，第一项可能是**对象引用**（RefProxy）→ 要 `getPageIndex(ref)` 换页码，
 *     也可能是**数字**（pdf.js 偶尔直接给下标）。
 *
 * 这里一次解析干净，UI 拿到的就是「页码 + 页内位置」，不用再操心这些。
 *
 * ⚠️ 解析不出页码的条目**不要丢掉**：它们通常是章节分组（父节点自己没有 dest，
 *    但子项有）。丢掉会让整棵树缺一大块 —— UI 上把它渲染成不可点的分组标题。
 *
 * ⚠️ 纵向坐标只对三种有把握的目标取，其余一律跳页顶：
 *    宁可不精确，也别猜错把用户扔到页面中间。
 */

import type { PDFDocumentProxy } from '@/pdfjs'

export interface OutlineNode {
  title: string
  /** 1-based 页码；解析不出来为 null（UI 上不可点） */
  pageNumber: number | null
  /**
   * 目标位置，**PDF 页面坐标**（原点在左下，单位 pt，未乘缩放）。
   * null = 跳到页顶即可。
   */
  destTop: number | null
  /** 层级，0 起 */
  level: number
  children: OutlineNode[]
}

/** pdf.js 的原始大纲项（只取用得上的字段） */
interface RawOutline {
  title?: string
  dest?: string | unknown[] | null
  items?: RawOutline[]
}

/** 解析整棵树。没有书签 / 解析失败都返回空数组，不抛 */
export async function parseOutline(doc: PDFDocumentProxy): Promise<OutlineNode[]> {
  let raw: RawOutline[] | null
  try {
    raw = await doc.getOutline()
  } catch {
    return [] // 大纲损坏时别把整个面板搞崩
  }
  if (!raw?.length) return []

  const out: OutlineNode[] = []
  for (const item of raw) {
    const node = await convert(doc, item, 0)
    if (node) out.push(node)
  }
  return out
}

async function convert(
  doc: PDFDocumentProxy,
  item: RawOutline,
  level: number,
): Promise<OutlineNode | null> {
  const target = await resolveDest(doc, item.dest)
  const children: OutlineNode[] = []
  for (const kid of item.items ?? []) {
    const n = await convert(doc, kid, level + 1)
    if (n) children.push(n)
  }
  // 自己跳不动**但有子项** → 仍然保留（当分组标题用）
  if (!target && !children.length) return null

  return {
    title: (item.title ?? '').trim() || '(无标题)',
    pageNumber: target?.pageNumber ?? null,
    destTop: target?.top ?? null,
    level,
    children,
  }
}

async function resolveDest(
  doc: PDFDocumentProxy,
  dest: string | unknown[] | null | undefined,
): Promise<{ pageNumber: number; top: number | null } | null> {
  let d = dest
  if (typeof d === 'string') {
    try {
      d = await doc.getDestination(d)
    } catch {
      return null
    }
  }
  if (!Array.isArray(d) || !d.length) return null

  const head = d[0]
  let index: number
  if (typeof head === 'number') {
    index = head
  } else if (head && typeof head === 'object') {
    try {
      index = await doc.getPageIndex(head as never)
    } catch {
      return null
    }
  } else {
    return null
  }
  if (!Number.isFinite(index) || index < 0) return null

  return { pageNumber: index + 1, top: destTop(d) }
}

/**
 * 取目标的纵向坐标。
 *
 * 只有三种显式目标带明确的 top：
 *   XYZ  [ref, {name:'XYZ'},  left, top, zoom]
 *   FitH [ref, {name:'FitH'}, top]
 *   FitR [ref, {name:'FitR'}, left, bottom, right, top]
 * 其余（Fit / FitV / FitB 等）没有可信的纵向坐标 → 跳页顶。
 *
 * ⚠️ XYZ 的 top 允许是 null（表示"保持当前位置"），这里同样按"跳页顶"处理。
 */
function destTop(d: unknown[]): number | null {
  const name = (d[1] as { name?: string } | null)?.name ?? ''
  if (name === 'XYZ') return numOrNull(d[3])
  if (name === 'FitH' || name === 'FitBH') return numOrNull(d[2])
  if (name === 'FitR') return numOrNull(d[5])
  return null
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
