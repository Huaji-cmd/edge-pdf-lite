/**
 * 文本框的自动换行。
 *
 * ## 为什么必须有这个模块
 *
 * 屏幕上"自动换行"是**浏览器排版**做的（contenteditable 按自己的宽度折行），
 * 而 **PDF 内容流里没有自动换行** —— 它只认显式的换行指令。所以提交时必须按
 * 同一个宽度、同一个字号把文本断成若干行，落进 `FreeTextAnnot.text`（`\n` 分隔）：
 *
 *   · 应用内绘制（`draw.ts`）按 `\n` 逐行画 → 与编辑时看到的一致
 *   · 写回 PDF（`writer.ts`）也按 `\n` 逐行写 → 别的查看器里也一致
 *
 * 不这么做的话，一段自动换行的文字写回后会变成**一行超长文本**，
 * 超出 `/Rect` 被查看器裁掉大半 —— 而且在自己应用里看着还是好的，很难发现。
 *
 * ## 断行规则（尽量贴近浏览器）
 *
 * - **CJK 逐字断**：汉字/假名/全角标点，每个字都可以是断点
 * - **拉丁按词断**：字母数字连成一"词"，断点只落在词与词之间
 * - **超长单词硬断**：一个词比整行还宽时，按字符切（否则会溢出框外）
 * - **保留空行**：文本里的空段落要留出一行高度，不能被吃掉
 */

import { FREETEXT_FONT_FAMILY, FREETEXT_LINE_HEIGHT } from './types'

/** 离屏测量用的 canvas（只建一次；每次新建 canvas 在长文档里很浪费） */
let measureCtx: CanvasRenderingContext2D | null = null

function getCtx(): CanvasRenderingContext2D {
  if (!measureCtx) {
    const c = document.createElement('canvas')
    measureCtx = c.getContext('2d')!
  }
  return measureCtx
}

/** 单个字符串在给定字号下的宽度（pt）。⚠️ 字体必须与绘制/编辑三处一致 */
export function measureTextWidth(text: string, fontSize: number): number {
  const c = getCtx()
  c.font = `${fontSize}px ${FREETEXT_FONT_FAMILY}`
  return c.measureText(text).width
}

/** 一行文本的高度（pt） */
export function lineHeightOf(fontSize: number): number {
  return fontSize * FREETEXT_LINE_HEIGHT
}

/**
 * 文本框内边距（pt，**页面空间**）。
 *
 * ⚠️ 四处必须取同一个值：应用内绘制、就地编辑器的 CSS、断行时扣掉的可用宽度、
 * 写回 PDF 时文字起始位置。差 1pt 就会让换行位置错开一个字，
 * 表现为"写回之后排版跟刚才看到的不一样"。
 */
export function textPad(fontSize: number): number {
  return Math.min(4, fontSize * 0.3)
}

/** 一段按行排好的文本占多高（pt） */
export function textBlockHeight(lines: readonly string[], fontSize: number): number {
  return Math.max(1, lines.length) * lineHeightOf(fontSize)
}

/** 是不是"可以逐字断行"的字符（CJK 与全角标点） */
function isCjk(ch: string): boolean {
  return /[\u2e80-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/.test(
    ch,
  )
}

/** 把一段（不含换行的）文本切成"断行单元"：CJK 一字一个，拉丁一串一个，空格单个 */
function tokenize(paragraph: string): string[] {
  const out: string[] = []
  let buf = ''
  const flush = (): void => {
    if (buf) {
      out.push(buf)
      buf = ''
    }
  }
  for (const ch of paragraph) {
    if (ch === ' ' || ch === '\t') {
      flush()
      out.push(' ')
    } else if (isCjk(ch)) {
      flush()
      out.push(ch)
    } else {
      buf += ch
    }
  }
  flush()
  return out
}

/** 一个词自己就超宽时，按字符硬切 */
function hardSplit(token: string, maxWidth: number, fontSize: number): string[] {
  const parts: string[] = []
  let cur = ''
  for (const ch of token) {
    const next = cur + ch
    if (cur && measureTextWidth(next, fontSize) > maxWidth) {
      parts.push(cur)
      cur = ch
    } else {
      cur = next
    }
  }
  if (cur) parts.push(cur)
  return parts
}

/**
 * 按可用宽度把文本断成行。
 *
 * @param maxWidth 可用宽度（pt，**已经扣掉左右内边距**）
 * @returns 每行的内容；`''` 表示一个空行（保留原文本里的空段落）
 */
export function wrapText(text: string, maxWidth: number, fontSize: number): string[] {
  const normalized = text.replace(/\r\n?/g, '\n')
  const paragraphs = normalized.split('\n')
  // 宽度无效时不做断行，原样返回（宁可溢出也不要把它切碎）
  if (!(maxWidth > 0) || !(fontSize > 0)) return paragraphs

  const lines: string[] = []
  for (const para of paragraphs) {
    if (para === '') {
      lines.push('')
      continue
    }
    let cur = ''
    let curWidth = 0
    for (const token of tokenize(para)) {
      const w = measureTextWidth(token, fontSize)
      if (cur && curWidth + w > maxWidth) {
        // 行满了：先把当前行收掉。行首不留空格（浏览器也是这么做的）
        lines.push(cur.trimEnd())
        cur = ''
        curWidth = 0
      }
      if (w > maxWidth && token !== ' ') {
        // 单个词就超宽 —— 硬切；切完最后一段作为新行的开头
        const parts = hardSplit(token, maxWidth, fontSize)
        for (let i = 0; i < parts.length - 1; i++) lines.push(parts[i]!)
        cur = parts[parts.length - 1] ?? ''
        curWidth = measureTextWidth(cur, fontSize)
        continue
      }
      if (!cur && token === ' ') continue // 行首空格丢掉
      cur += token
      curWidth += w
    }
    lines.push(cur.trimEnd())
  }
  return lines
}
