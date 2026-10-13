/**
 * 批注容器（**非响应式**）。
 *
 * 为什么不放 Pinia / `ref()`：批注是"大数组 + 频繁小改动"的数据，
 * 套上 Vue 的深层 Proxy 之后每次命中检测、每次重绘都要穿过代理，
 * 在 600 页文档上会明显变慢。项目铁律里写死了这条边界：
 * **大对象用普通 class，只把"数量"这种小标量暴露给 UI。**
 *
 * 变更通知走一个极简的订阅回调，UI 侧收到后自己更新一个数字即可。
 */

import type { Annotation, Rect } from './types'
import { isMarkup, bboxOfPoints, pointInRect, rectsIntersect } from './types'

/** 点到线段的距离（橡皮擦的命中检测用） */
function distToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

/**
 * 一次可撤销的操作。
 *
 * 三种，且都**天然可逆**，所以撤销/重做只需要两个函数 + 两个栈，不需要命令对象的
 * do/undo 闭包（那种写法在序列化、调试时都更麻烦）：
 *
 *   · `add`    —— 加了什么、加在哪一页的哪个位置
 *   · `remove` —— 删了什么、原本在第几位（重做时要插回原位，否则叠放次序会变）
 *   · `edit`   —— 拖动 / 改大小 / 改色前后的完整快照
 *
 * ⚠️ `add`/`remove` 必须带 `index`：批注是有叠放次序的（后加的在上层），
 * 撤销再重做如果一律追加到末尾，会悄悄改变"谁盖住谁"。
 */
type UndoOp =
  | { type: 'add'; annot: Annotation; index: number }
  | { type: 'remove'; annot: Annotation; index: number }
  | { type: 'edit'; before: Annotation; after: Annotation }

export class AnnotationStore {
  private byPage = new Map<number, Annotation[]>()
  /** id → 页码，撤销/删除时不必遍历所有页 */
  private pageOf = new Map<string, number>()
  /** 有未保存改动的页 */
  private dirty = new Set<number>()
  private listeners = new Set<() => void>()
  private undoStack: UndoOp[] = []
  private redoStack: UndoOp[] = []

  // ---------------------------------------------------------------- 查询

  list(pageNumber: number): readonly Annotation[] {
    return this.byPage.get(pageNumber) ?? EMPTY
  }

  all(): Annotation[] {
    const out: Annotation[] = []
    for (const arr of this.byPage.values()) out.push(...arr)
    return out
  }

  count(): number {
    let n = 0
    for (const arr of this.byPage.values()) n += arr.length
    return n
  }

  get(id: string): Annotation | null {
    const pn = this.pageOf.get(id)
    if (pn === undefined) return null
    return this.byPage.get(pn)?.find((a) => a.id === id) ?? null
  }

  /** 有未保存改动的页码集合 */
  dirtyPages(): Set<number> {
    return new Set(this.dirty)
  }

  // ---------------------------------------------------------------- 变更

  add(a: Annotation): void {
    const arr = this.byPage.get(a.pageNumber)
    const index = arr ? arr.length : 0
    this.insertAt(a, index)
    this.remember({ type: 'add', annot: a, index })
  }

  remove(id: string): boolean {
    const pn = this.pageOf.get(id)
    if (pn === undefined) return false
    const arr = this.byPage.get(pn)
    if (!arr) return false
    const index = arr.findIndex((a) => a.id === id)
    if (index < 0) return false
    const removed = arr[index]!
    arr.splice(index, 1)
    this.pageOf.delete(id)
    if (!arr.length) this.byPage.delete(pn)
    this.dirty.add(pn)
    this.remember({ type: 'remove', annot: removed, index })
    return true
  }

  /**
   * 直接替换一条批注，**不记历史**。
   *
   * 拖动/改大小的过程中会走这个（一秒几十次，逐条记历史会把撤销栈淹掉）。
   * 松手时用 {@link commitEdit} 补一条 `edit` 记录 —— 用户感知到的是"一次拖动"，
   * 撤销一次就该退回到拖动前，而不是退回到上一帧。
   */
  replace(id: string, next: Annotation): void {
    const pn = this.pageOf.get(id)
    if (pn === undefined) return
    const arr = this.byPage.get(pn)
    if (!arr) return
    const idx = arr.findIndex((a) => a.id === id)
    if (idx < 0) return
    arr[idx] = next
    this.dirty.add(pn)
    this.emit()
  }

  /** 记一次「编辑」：拖动 / 改大小 / 改色。传拖动**前**和**后**的两份完整快照 */
  commitEdit(before: Annotation, after: Annotation): void {
    this.replace(before.id, after)
    this.remember({ type: 'edit', before, after })
  }

  /**
   * 把「新建 → 就地编辑 → 收尾」三个阶段塌成**一条**历史。
   *
   * 为什么非得有它：编辑途中（打字、改字号、拖动、改色）一律走 `replace` —— 那是
   * 为了不让撤销栈被逐帧淹没。于是收尾那一瞬间，栈顶仍然是新建时那条 `add`，
   * 而它记的是**新建那一刻**的快照 —— 也就是**空框**。
   * 不处理的话：撤销 → 重做，用户看到的是一个空框，等同数据丢失。
   *
   * @param final 最终内容；传 `null` 表示「这个框废了」（没打字就点了空白处），
   *              此时连那条 `add` 一起抹掉 —— 否则撤销会把空框请回来，
   *              而且它还会作为一条空批注被写进 PDF。
   * @returns 是否命中栈顶的那条 `add`。没命中就返回 false，调用方走常规路径
   *          （`commitEdit` / `remove`）—— 说明中间掺进了别的操作，不能乱塌。
   */
  collapseNewAnnot(id: string, final: Annotation | null): boolean {
    const top = this.undoStack[this.undoStack.length - 1]
    if (!top || top.type !== 'add' || top.annot.id !== id) return false
    if (final) {
      top.annot = final
      this.emit()
      return true
    }
    // 废掉了：抹掉整条 add，并从活数据里摘掉（但不记历史）
    this.undoStack.pop()
    const pn = this.pageOf.get(id)
    if (pn !== undefined) {
      const arr = this.byPage.get(pn)
      const idx = arr ? arr.findIndex((a) => a.id === id) : -1
      if (arr && idx >= 0) {
        arr.splice(idx, 1)
        this.pageOf.delete(id)
        if (!arr.length) this.byPage.delete(pn)
        this.dirty.add(pn)
      }
    }
    this.redoStack.length = 0
    this.emit()
    return true
  }

  // ---------------------------------------------------------------- 历史

  /** 撤销：反向执行栈顶操作，并把它压到重做栈 */
  undo(): boolean {
    const op = this.undoStack.pop()
    if (!op) return false
    this.revert(op)
    this.redoStack.push(op)
    this.emit()
    return true
  }

  /** 重做：把刚撤销的操作再执行一遍（Ctrl+Shift+Z / Ctrl+Y） */
  redo(): boolean {
    const op = this.redoStack.pop()
    if (!op) return false
    this.apply(op)
    this.undoStack.push(op)
    this.emit()
    return true
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }

  canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /** 记一笔历史，并剪掉重做栈 —— 在新操作之后，"被撤销掉的那些"不再是未来 */
  private remember(op: UndoOp): void {
    this.undoStack.push(op)
    this.redoStack.length = 0
    this.emit()
  }

  private insertAt(a: Annotation, index: number): void {
    const arr = this.byPage.get(a.pageNumber)
    if (!arr) this.byPage.set(a.pageNumber, [a])
    else arr.splice(Math.min(Math.max(index, 0), arr.length), 0, a)
    this.pageOf.set(a.id, a.pageNumber)
    this.dirty.add(a.pageNumber)
  }

  private removeById(id: string): void {
    const pn = this.pageOf.get(id)
    if (pn === undefined) return
    const arr = this.byPage.get(pn)
    if (!arr) return
    const i = arr.findIndex((a) => a.id === id)
    if (i < 0) return
    arr.splice(i, 1)
    this.pageOf.delete(id)
    if (!arr.length) this.byPage.delete(pn)
    this.dirty.add(pn)
  }

  /** 正向执行 */
  private apply(op: UndoOp): void {
    if (op.type === 'add') this.insertAt(op.annot, op.index)
    else if (op.type === 'remove') this.removeById(op.annot.id)
    else this.replace(op.after.id, op.after)
  }

  /** 反向执行 */
  private revert(op: UndoOp): void {
    if (op.type === 'add') this.removeById(op.annot.id)
    else if (op.type === 'remove') this.insertAt(op.annot, op.index)
    else this.replace(op.before.id, op.before)
  }

  /** 保存成功后调用：清脏标记、清历史（那些操作已经落盘了） */
  markSaved(): void {
    this.dirty.clear()
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.emit()
  }

  clear(): void {
    this.byPage.clear()
    this.pageOf.clear()
    this.dirty.clear()
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.emit()
  }

  /** 批量载入（从 PDF / sidecar 读回来的已有批注） */
  loadAll(list: readonly Annotation[]): void {
    this.byPage.clear()
    this.pageOf.clear()
    for (const a of list) {
      const arr = this.byPage.get(a.pageNumber)
      if (arr) arr.push(a)
      else this.byPage.set(a.pageNumber, [a])
      this.pageOf.set(a.id, a.pageNumber)
    }
    // 载入的既不算脏、也不进历史
    this.dirty.clear()
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.emit()
  }

  // ---------------------------------------------------------------- 命中检测

  /**
   * 找出页面空间里 `(x, y)` 命中的批注（后加的优先 —— 上层的先被擦到）。
   * `tolerance` 是页面空间下的容差（由调用方按当前缩放换算，保证手感一致）。
   */
  hitTest(pageNumber: number, x: number, y: number, tolerance: number): Annotation | null {
    const arr = this.byPage.get(pageNumber)
    if (!arr?.length) return null
    for (let i = arr.length - 1; i >= 0; i--) {
      const a = arr[i]!
      if (this.hits(a, x, y, tolerance)) return a
    }
    return null
  }

  /** 视口矩形（页面空间）内命中的批注，用于"框选擦除" */
  hitTestRect(pageNumber: number, r: Rect, tolerance = 0): Annotation[] {
    const arr = this.byPage.get(pageNumber)
    if (!arr?.length) return []
    const padded: Rect = [r[0] - tolerance, r[1] - tolerance, r[2] + tolerance, r[3] + tolerance]
    return arr.filter((a) => rectsIntersect(a.rect, padded))
  }

  private hits(a: Annotation, x: number, y: number, tol: number): boolean {
    if (isMarkup(a)) {
      // 四边形可能有好几个（多行高亮），逐个判
      for (let i = 0; i < a.quads.length; i += 8) {
        const qx0 = Math.min(a.quads[i]!, a.quads[i + 2]!, a.quads[i + 4]!, a.quads[i + 6]!)
        const qx1 = Math.max(a.quads[i]!, a.quads[i + 2]!, a.quads[i + 4]!, a.quads[i + 6]!)
        const qy0 = Math.min(a.quads[i + 1]!, a.quads[i + 3]!, a.quads[i + 5]!, a.quads[i + 7]!)
        const qy1 = Math.max(a.quads[i + 1]!, a.quads[i + 3]!, a.quads[i + 5]!, a.quads[i + 7]!)
        if (pointInRect(x, y, [qx0, qy0, qx1, qy1], tol)) return true
      }
      return false
    }
    if (a.kind === 'ink') {
      const need = tol + a.lineWidth / 2
      for (const s of a.strokes) {
        if (s.length === 2) {
          if (Math.hypot(x - s[0]!, y - s[1]!) <= need) return true
          continue
        }
        for (let i = 2; i < s.length; i += 2) {
          if (distToSegment(x, y, s[i - 2]!, s[i - 1]!, s[i]!, s[i + 1]!) <= need) return true
        }
      }
      return false
    }
    // area / rect / freetext：落在框内即算命中（橡皮擦是显式工具，点到就删最直观）
    return pointInRect(x, y, a.rect, tol)
  }

  /** 单条批注的包围盒（校验 rect 是否与实际内容一致，写回前会用到） */
  static recomputeRect(a: Annotation): Rect {
    if (isMarkup(a)) {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (let i = 0; i < a.quads.length; i += 2) {
        const x = a.quads[i]!
        const y = a.quads[i + 1]!
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
      return [minX, minY, maxX, maxY]
    }
    if (a.kind === 'ink') {
      const all = a.strokes.flat()
      return bboxOfPoints(all, a.lineWidth / 2)
    }
    return a.rect
  }

  // ---------------------------------------------------------------- 订阅

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }
}

const EMPTY: readonly Annotation[] = []
