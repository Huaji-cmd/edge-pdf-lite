/**
 * 批注兼容性自检（M0 实验二 + 实验三）。
 *
 * 这一页做两件事：
 *   1. **结构自检**：用 pdf.js 读回样本 PDF，逐条打印注释的 subtype / id / rect /
 *      quadPoints / 有无 /AP —— 证明我们手工构造的字典是合法的。
 *   2. **渲染对照**：同一页渲染两次，一次 `AnnotationMode.DISABLE`（不画注释）、
 *      一次 `ENABLE`（画注释），对高亮区域采样比对颜色。
 *      只测一次没有说服力 —— 必须证明「关掉时是白的、打开时是黄的」，
 *      否则可能是页面本身就有那个颜色。
 *
 * ⚠️ **pdf.js 能画 ≠ Edge/Acrobat 能画**。这两个是不同实现。
 * 所以人工核对清单（页面下半部分）不能省 —— 必须拿样本去真实查看器里过一遍。
 */

import {
  pdfjsLib,
  installPdfWorker,
  pdfPolyfillsApplied,
  describePdfError,
  AnnotationMode,
} from '@/pdfjs'

installPdfWorker()

const SAMPLE_URL = '/testdata/annot-fixture.pdf'
const SCALE = 1.5
/** 与样本 PDF 里的 /T 一致 —— 用来识别「这条批注是我们写的」 */
const AUTHOR = 'edge-pdf-lite'

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`页面缺少 #${id}`)
  return el as T
}

const statusEl = $('status')
const reportEl = $('report')
const previewEl = $('preview')
const runBtn = $<HTMLButtonElement>('runCheck')

function log(msg: string, kind: 'info' | 'ok' | 'warn' | 'err' = 'info'): void {
  statusEl.className = kind === 'info' ? '' : kind
  statusEl.textContent = msg
}

function esc(s: unknown): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

/**
 * 数出「符合目标色」的像素个数。
 *
 * 为什么不用平均色：高亮只覆盖采样区的一部分，平均色会被白底稀释，
 * 阈值很难定（第一版就是这么失败 0/2 的）。
 * 数特定颜色的像素个数则是**二值的**：页面是黑白文字，黄色像素应该只有注释能产生。
 * 于是 DISABLE 时必然是 0、ENABLE 时必然 > 0 —— 判据干脆且没有灰区。
 */
function countTarget(
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
  isTarget: (r: number, g: number, b: number) => boolean,
) {
  const ctx = canvas.getContext('2d')!
  const d = ctx.getImageData(
    Math.max(0, Math.round(x)),
    Math.max(0, Math.round(y)),
    Math.max(1, Math.round(w)),
    Math.max(1, Math.round(h)),
  ).data
  let hit = 0
  let nonWhite = 0
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]!
    const g = d[i + 1]!
    const b = d[i + 2]!
    if (isTarget(r, g, b)) hit++
    if (r < 250 || g < 250 || b < 250) nonWhite++
  }
  return { hit, nonWhite, total: d.length / 4 }
}

async function renderPage(
  doc: pdfjsLib.PDFDocumentProxy,
  pageNumber: number,
  annotationMode: number,
): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(pageNumber)
  const vp = page.getViewport({ scale: SCALE })
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(vp.width)
  canvas.height = Math.round(vp.height)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({
    canvas,
    canvasContext: ctx,
    viewport: vp,
    intent: 'display',
    annotationMode,
  }).promise
  return canvas
}

const run = async (): Promise<void> => {
  runBtn.disabled = true
  reportEl.innerHTML = ''
  previewEl.innerHTML = ''
  try {
    log('加载样本…')
    const res = await fetch(SAMPLE_URL)
    if (!res.ok) throw new Error(`取样本失败：HTTP ${res.status}（先跑 npm run testdata:annot）`)
    const bytes = new Uint8Array(await res.arrayBuffer())

    const task = pdfjsLib.getDocument({
      data: bytes,
      cMapUrl: '/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/standard_fonts/',
    })
    const doc = await task.promise
    log(`已加载样本，共 ${doc.numPages} 页，开始逐页自检…`)

    // ---------------------------------------------------------------- 结构自检
    type Row = {
      page: number
      subtype: string
      /**
       * ⚠️ pdf.js 6 的 `id` 是**对象引用**（形如 `8R`），**不是 /NM**。
       * 方案里原本写着「getAnnotations() 返回的 id 即 /NM」—— 实测证伪。
       */
      id: string
      /** /T 作者名（pdf.js 暴露成 titleObj.str） */
      author: string
      /** /Contents 批注内容（contentsObj.str） */
      contents: string
      /** 高亮覆盖的原文（pdf.js 额外抽出来的，做批注列表很好用） */
      overlaid: string
      isOurs: boolean
      rect: number[]
      quadCount: number
      hasAP: boolean
    }
    const rows: Row[] = []

    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const annots = (await page.getAnnotations()) as Array<Record<string, unknown>>
      for (const a of annots) {
        const subtype = String(a.subtype ?? '?')
        const id = String(a.id ?? '')
        const titleObj = a.titleObj as { str?: string } | undefined
        const contentsObj = a.contentsObj as { str?: string } | undefined
        const author = String(titleObj?.str ?? '')
        const rect = Array.isArray(a.rect) ? (a.rect as number[]) : []
        const quad = Array.isArray(a.quadPoints) ? (a.quadPoints as number[]) : []
        rows.push({
          page: p,
          subtype,
          id,
          author,
          contents: String(contentsObj?.str ?? ''),
          overlaid: String(a.overlaidText ?? '').replace(/\s+/g, ' ').slice(0, 60),
          isOurs: author === AUTHOR,
          rect: rect.map((v) => Math.round(v * 100) / 100),
          quadCount: quad.length / 8,
          hasAP: a.hasAppearance === true,
        })
      }
    }

    const polys = pdfPolyfillsApplied()

    reportEl.innerHTML = `
      <h2>① 结构自检（pdf.js 读回的结果）</h2>
      <table>
        <tr>
          <th>页</th><th>subtype</th><th>id（对象引用）</th><th>作者 /T</th><th>/Contents</th>
          <th>是自家批注</th><th>四边形数</th><th>有 /AP</th>
        </tr>
        ${rows
          .map(
            (r) => `
        <tr>
          <td>P${r.page}</td>
          <td>${esc(r.subtype)}</td>
          <td class="dim">${esc(r.id)}</td>
          <td class="${r.author ? 'ok' : 'err'}">${r.author ? esc(r.author) : '（空）'}</td>
          <td class="dim">${esc(r.contents.slice(0, 46))}${r.contents.length > 46 ? '…' : ''}</td>
          <td class="${r.isOurs ? 'ok' : 'err'}">${r.isOurs ? '✅ 是' : '— 否'}</td>
          <td>${r.quadCount || '—'}</td>
          <td class="${r.hasAP ? 'ok' : 'warn'}">${r.hasAP ? '✅' : '无'}</td>
        </tr>`,
          )
          .join('')}
      </table>
      <p class="note">
        检出注释 <b>${rows.length}</b> 条（样本里应有 9 条：Highlight×4、Ink、FreeText、Square、StrikeOut、Underline）。
        ${polys.length ? `本机浏览器补了 Polyfill：${esc(polys.join(', '))}` : '本机浏览器较新，无需补 Polyfill。'}
        <br /><br />
        <b>⚠️ 两处实测修正（都很要紧）：</b><br />
        ① <b>pdf.js 的 <code>id</code> 是对象引用（<code>8R</code>），不是 <code>/NM</code></b> ——
        pdf.js 6 压根不读 <code>/NM</code>。所以「识别哪些批注是我写的」不能靠它，
        改用 <code>/T</code> 作者名（本页显示的那一列），并把 <code>/NM</code> 留给 pdf-lib 侧写回时使用。<br />
        ② <b><code>/T</code> / <code>/Contents</code> 必须是 text string</b>，而
        <code>PDFContext.obj()</code> 会把 JS 字符串当 <b>PDFName</b> 写（<code>/edge-pdf-lite</code> 而不是
        <code>(edge-pdf-lite)</code>）。样本第一版就踩了这个坑，作者名和内容在严格查看器里是错的。
        写回时必须显式包 <code>PDFString.of()</code>。
      </p>
    `

    // ---------------------------------------------------------------- 诊断：注释进没进算子列表
    // canvas 上没画出注释时，必须分清两种可能：
    //   (a) 注释压根没进算子列表（worker 侧就滤掉了）
    //   (b) 注释进了，但被标记为 separateAnnots（要用**独立 canvas / DOM 层**画，主 canvas 不画）
    // 这两者的应对完全不同 —— 所以先探一下。
    const p1 = await doc.getPage(1)
    const opOff = (await p1.getOperatorList({
      annotationMode: AnnotationMode.DISABLE,
    })) as unknown as { fnArray: number[]; separateAnnots?: unknown }
    const opOn = (await p1.getOperatorList({
      annotationMode: AnnotationMode.ENABLE,
    })) as unknown as { fnArray: number[]; separateAnnots?: unknown }
    const diag = {
      offOps: opOff.fnArray.length,
      onOps: opOn.fnArray.length,
      offSeparate: opOff.separateAnnots ?? null,
      onSeparate: opOn.separateAnnots ?? null,
    }

    // ---------------------------------------------------------------- 渲染对照
    log('渲染对照中…')
    const pageHeightPt = (await doc.getPage(1)).getViewport({ scale: 1 }).height

    const checks: Array<{
      title: string
      pageNumber: number
      /** 采样区：页面坐标（直接取注释 /Rect 的范围） */
      box: { x: number; yTop: number; w: number; h: number }
      /** 目标色判定（逐像素） */
      isTarget: (r: number, g: number, b: number) => boolean
      expect: string
    }> = [
      {
        title: 'P1 Highlight（黄，带 /AP，覆盖 Line 2 + Line 3）',
        pageNumber: 1,
        box: { x: 46, yTop: 687.5, w: 232.7, h: 34.5 },
        isTarget: (r, _g, b) => r > 200 && b < 150 && r - b > 60,
        expect: '黄色像素',
      },
      {
        title: 'P4 Ink（红，带 /AP）',
        pageNumber: 4,
        box: { x: 66, yTop: 629.93, w: 428, h: 59.93 },
        isTarget: (r, g, b) => r > 180 && g < 120 && b < 120,
        expect: '红色像素',
      },
    ]

    const grid = document.createElement('div')
    grid.className = 'grid'
    previewEl.appendChild(grid)

    let passed = 0
    const lines: string[] = []
    /** 位图导出，便于事后用文件核对（截图缩略图看不清细节） */
    const exported: Array<{ title: string; off: string; on: string; offHit: number; onHit: number }> =
      []

    for (const c of checks) {
      const off = await renderPage(doc, c.pageNumber, AnnotationMode.DISABLE)
      const on = await renderPage(doc, c.pageNumber, AnnotationMode.ENABLE)

      const sx = c.box.x * SCALE
      const sy = (pageHeightPt - c.box.yTop) * SCALE
      const sw = c.box.w * SCALE
      const sh = c.box.h * SCALE

      const offStat = countTarget(off, sx, sy, sw, sh, c.isTarget)
      const onStat = countTarget(on, sx, sy, sw, sh, c.isTarget)
      // 判据是二值的：关掉时该色像素应为 0，打开时应明显出现
      const hit = offStat.hit === 0 && onStat.hit > 200
      if (hit) passed++

      // 导出位图，便于事后用文件核对（截图缩略图看不清细节）
      exported.push({
        title: c.title,
        off: off.toDataURL('image/jpeg', 0.85),
        on: on.toDataURL('image/jpeg', 0.85),
        offHit: offStat.hit,
        onHit: onStat.hit,
      })

      for (const [label, cv, stat] of [
        ['注释关闭 (DISABLE)', off, offStat],
        ['注释打开 (ENABLE)', on, onStat],
      ] as const) {
        const col = document.createElement('div')
        col.className = 'col'
        col.appendChild(cv)
        const cap = document.createElement('div')
        cap.className = 'cap'
        cap.textContent = `${label} · 目标色 ${stat.hit} px / 非白 ${stat.nonWhite} px`
        col.appendChild(cap)
        grid.appendChild(col)
      }

      lines.push(
        `<tr>
          <td>${esc(c.title)}</td>
          <td class="dim">${offStat.hit} px</td>
          <td class="${hit ? 'ok' : 'err'}"><b>${onStat.hit} px</b></td>
          <td class="${hit ? 'ok' : 'err'}">${hit ? `✅ 画出来了（${c.expect}）` : `❌ 没画出来（期望 ${c.expect}）`}</td>
        </tr>`,
      )
    }

    reportEl.insertAdjacentHTML(
      'beforeend',
      `
      <h2>② 渲染对照（证明 /AP 外观流真的被画了）</h2>
      <table>
        <tr><th>检查项</th><th>注释关闭时目标色像素</th><th>注释打开时目标色像素</th><th>判定</th></tr>
        ${lines.join('')}
      </table>
      <p class="note">
        判据：<b>关掉注释时该颜色应为 0 个像素，打开时明显出现</b>。
        用"数特定颜色像素"而不是"平均色"，是因为高亮只覆盖采样区一部分、
        平均色会被白底稀释，阈值没有灰区可定 —— 第一版就是这么失败 0/2 的。
      </p>
      <h2>③ 诊断：注释到底去了哪一层</h2>
      <table>
        <tr><th>指标</th><th>注释关闭 (DISABLE)</th><th>注释打开 (ENABLE)</th></tr>
        <tr><td>算子列表长度</td><td>${diag.offOps}</td><td>${diag.onOps}</td></tr>
        <tr><td><code>separateAnnots</code></td>
            <td class="dim">${JSON.stringify(diag.offSeparate)}</td>
            <td class="${diag.onSeparate ? 'warn' : 'dim'}"><b>${JSON.stringify(diag.onSeparate)}</b></td></tr>
      </table>
      <p class="note">
        <code>separateAnnots</code> 非 null 表示 pdf.js 把注释<b>从主 canvas 里分离出去</b>，
        要用<b>独立 canvas / DOM 层（AnnotationLayer）</b>绘制 —— 主 canvas 上当然看不到。
        这正是"注释没画出来"的根因所在，也直接决定 M5 要自己画还是交给 pdf.js 的注释层。
      </p>
    `)

    const allOk = rows.length >= 9 && passed === checks.length
    log(
      allOk
        ? `自检通过：${rows.length} 条注释结构合法，${passed}/${checks.length} 项渲染对照命中`
        : `自检未全过：注释 ${rows.length} 条，渲染对照 ${passed}/${checks.length}`,
      allOk ? 'ok' : 'warn',
    )

    ;(window as unknown as Record<string, unknown>).__annotCheck = {
      annotCount: rows.length,
      rows,
      passed,
      total: checks.length,
      polyfills: polys,
      renderChecks: exported,
      diag,
    }

    await task.destroy()
  } catch (e) {
    const err = e as Error
    console.error('[annot-check] 失败', err)
    log(`出错：${describePdfError(err)}`, 'err')
    const pre = document.createElement('pre')
    pre.className = 'stack'
    pre.textContent = String(err.stack ?? err.message)
    reportEl.appendChild(pre)
  } finally {
    runBtn.disabled = false
  }
}

runBtn.addEventListener('click', () => void run())
