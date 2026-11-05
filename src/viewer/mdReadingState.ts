/**
 * Markdown 的阅读位置记忆 —— **独立的一套键**。
 *
 * ## 为什么不复用 `readingState.ts`
 * 那边存的是 `{ page, scale, mode, spreadOffset }`，语义是"第几页 + 页式缩放"。
 * Markdown 没有页，比例尺也不一样（字号缩放 0.75–2.5，PDF 是 0.25–8）。
 * 硬塞进同一个键有两个后果：
 *   1. 打开一个同名/同指纹的 PDF 会读到一份 Markdown 的记录，跳到一个不存在的页；
 *   2. `loadReadingState` 的合法性校验（`page >= 1`）会把 Markdown 记录判成坏数据，
 *      于是"每次都从头开始"——这种 bug 很难看出来。
 * 所以键前缀不同（`epl:md-reading:`），结构也不同。
 *
 * ## 为什么存"标题锚点 + 偏移"，而不是只存滚动比例
 * 字号缩放是**重排**：同一份内容在 125% 下的滚动高度比 100% 大得多。
 * 只记 `scrollTop / scrollHeight` 的话，换一个缩放比例恢复就会漂到别处；
 * 而"离某个标题往下多远（按该标题到下一个标题的距离取比例）"是**内容坐标**，
 * 换字号仍然指向同一段文字。
 */
import type { MdHeading } from './markdownDocument'

export interface MdReadingState {
  /** 兜底：锚点找不到时按整篇的比例恢复 */
  scrollRatio: number
  /** 最近经过的标题 id（DOM 里就是 h1..h6 的 id） */
  anchorId: string | null
  /** 该标题在视口上方"已经滚过去"的比例（0 = 标题正好在顶部） */
  anchorOffsetRatio: number
  scale: number
  updatedAt: number
}

const PREFIX = 'epl:md-reading:'

/** 与 PDF 那边一致：太旧的记录没必要留着 */
const MAX_AGE_DAYS = 180

/** 字号缩放的上下限（100% = 16px 基准）。超出这个范围长文排版就散了 */
export const MD_SCALE_MIN = 0.75
export const MD_SCALE_MAX = 2.5

export function clampMdScale(s: number): number {
  if (!Number.isFinite(s)) return 1
  return Math.min(MD_SCALE_MAX, Math.max(MD_SCALE_MIN, s))
}

export function mdReadingKey(fingerprint: string): string {
  return PREFIX + fingerprint
}

export function loadMdReadingState(fingerprint: string): MdReadingState | null {
  if (!fingerprint) return null
  try {
    const raw = localStorage.getItem(mdReadingKey(fingerprint))
    if (!raw) return null
    const s = JSON.parse(raw) as Partial<MdReadingState>
    if (typeof s.scale !== 'number' || !Number.isFinite(s.scale) || s.scale <= 0) return null
    if (typeof s.scrollRatio !== 'number' || !Number.isFinite(s.scrollRatio)) return null
    const ageMs = Date.now() - (s.updatedAt ?? 0)
    if (ageMs > MAX_AGE_DAYS * 86400_000) return null
    return {
      scrollRatio: Math.min(1, Math.max(0, s.scrollRatio)),
      anchorId: typeof s.anchorId === 'string' && s.anchorId ? s.anchorId : null,
      anchorOffsetRatio:
        typeof s.anchorOffsetRatio === 'number' && Number.isFinite(s.anchorOffsetRatio)
          ? Math.min(1, Math.max(0, s.anchorOffsetRatio))
          : 0,
      scale: clampMdScale(s.scale),
      updatedAt: s.updatedAt ?? 0,
    }
  } catch {
    return null
  }
}

export function saveMdReadingState(
  fingerprint: string,
  state: Omit<MdReadingState, 'updatedAt'>,
): void {
  if (!fingerprint) return
  try {
    localStorage.setItem(
      mdReadingKey(fingerprint),
      JSON.stringify({ ...state, updatedAt: Date.now() } satisfies MdReadingState),
    )
  } catch {
    /* localStorage 满了 / 隐私模式 —— 存不上不该影响阅读 */
  }
}

export function clearMdReadingState(fingerprint: string): void {
  try {
    localStorage.removeItem(mdReadingKey(fingerprint))
  } catch {
    /* ignore */
  }
}

/**
 * 从"当前滚动位置"算出要存的东西。
 *
 * 纯函数放在这里（而不是写在组件里）是为了**能单独验证**：
 * 缩放变化后的恢复是否指向同一段文字，是本期最容易悄悄坏掉的一处。
 *
 * @param headings 文档标题（按 DOM 顺序）
 * @param offsets  每个标题相对内容顶部的偏移（px，内容坐标）
 * @param scrollTop 视口顶部在内容坐标里的位置（px）
 * @param scrollHeight 内容总高（px）
 */
export function anchorOf(
  headings: readonly Pick<MdHeading, 'id'>[],
  offsets: readonly number[],
  scrollTop: number,
  scrollHeight: number,
): { anchorId: string | null; anchorOffsetRatio: number; scrollRatio: number } {
  const scrollRatio = scrollHeight > 0 ? Math.min(1, Math.max(0, scrollTop / scrollHeight)) : 0
  // 找"顶部已经越过的最后一个标题"：这就是读者当前所在的小节
  let idx = -1
  for (let i = 0; i < offsets.length; i++) {
    if (offsets[i]! <= scrollTop + 4) idx = i
    else break
  }
  if (idx < 0) return { anchorId: null, anchorOffsetRatio: 0, scrollRatio }
  const start = offsets[idx]!
  const end = idx + 1 < offsets.length ? offsets[idx + 1]! : Math.max(start + 1, scrollHeight)
  const span = Math.max(1, end - start)
  const anchorOffsetRatio = Math.min(1, Math.max(0, (scrollTop - start) / span))
  return { anchorId: headings[idx]?.id ?? null, anchorOffsetRatio, scrollRatio }
}
