import type { DocumentLayout, LayoutOptions, PageSize, BasePageLayout } from './types'

/**
 * 计算版面（**基准坐标**，即 scale = 1）。
 *
 * 为什么只在 scale=1 算一次：
 * 缩放时如果重算每一页的坐标，600 页的文档每次滚轮都要改 600 个元素的 inline style，
 * 必然掉帧。改成"基准坐标静态 + CSS 变量 --scale 缩放"之后，
 * **一次缩放只写一个 CSS 变量**，DOM 几乎不动。
 */
export function computeLayout(sizes: PageSize[], opts: LayoutOptions): DocumentLayout {
  const n = sizes.length
  const { mode, gap, padding, spreadOffset } = opts
  const rowGap = gap * 2

  // ---- 1) 分行 ----
  const rows: number[][] = []
  if (mode === 'single') {
    for (let i = 1; i <= n; i++) rows.push([i])
  } else {
    let i = 1
    if (spreadOffset === 1 && n >= 1) {
      rows.push([1])
      i = 2
    }
    for (; i <= n; i += 2) {
      rows.push(i + 1 <= n ? [i, i + 1] : [i])
    }
  }

  // ---- 2) 先量出每行尺寸，才能确定内容总宽 ----
  const rowMetrics = rows.map((pages) => {
    let w = 0
    let h = 0
    pages.forEach((pn, k) => {
      const s = sizes[pn - 1]!
      w += s.width + (k > 0 ? gap : 0)
      if (s.height > h) h = s.height
    })
    return { pages, width: w, height: h }
  })

  const maxRowWidth = rowMetrics.reduce((m, r) => Math.max(m, r.width), 0)
  const contentWidth = maxRowWidth + padding * 2

  // ---- 3) 落位 ----
  const pages: BasePageLayout[] = []
  let y = padding
  for (const row of rowMetrics) {
    // 每行水平居中
    let x = padding + (maxRowWidth - row.width) / 2
    for (const pn of row.pages) {
      const s = sizes[pn - 1]!
      pages.push({ pageNumber: pn, x, y, width: s.width, height: s.height })
      x += s.width + gap
    }
    y += row.height + rowGap
  }
  const contentHeight = Math.max(y - rowGap + padding, padding * 2)

  return { pages, contentWidth, contentHeight }
}

/** 找出某页所在的"行"，用于双页模式下的滚动定位 */
export function findRowOf(layout: DocumentLayout, pageNumber: number): BasePageLayout[] {
  const target = layout.pages.find((p) => p.pageNumber === pageNumber)
  if (!target) return []
  return layout.pages.filter((p) => p.y === target.y)
}
