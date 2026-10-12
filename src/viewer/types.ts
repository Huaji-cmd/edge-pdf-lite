/** 页面在 PDF 用户坐标系下的尺寸（已含 /Rotate） */
export interface PageSize {
  width: number
  height: number
}

/** 单页在内容坐标系里的位置与尺寸（scale = 1 时的基准值） */
export interface BasePageLayout {
  pageNumber: number
  /** 基准坐标（scale=1），单位 CSS px */
  x: number
  y: number
  width: number
  height: number
}

export interface DocumentLayout {
  pages: BasePageLayout[]
  /** scale = 1 时的内容总尺寸 */
  contentWidth: number
  contentHeight: number
}

export type ViewMode = 'single' | 'dual'

/**
 * 左侧边栏能显示的面板。
 * `null` = 整个侧边栏收起。
 */
export type SidePanelKind = 'files' | 'search' | 'outline' | 'thumbs' | 'settings'

export interface LayoutOptions {
  mode: ViewMode
  /** 页间距（CSS px，scale=1 基准） */
  gap: number
  /** 页边距（CSS px，scale=1 基准） */
  padding: number
  /**
   * 双页模式的起始偏移：
   * 0 = (1,2)(3,4)… 适合论文/无封面文档
   * 1 = (1)(2,3)(4,5)… 适合有封面的书
   */
  spreadOffset: 0 | 1
}
