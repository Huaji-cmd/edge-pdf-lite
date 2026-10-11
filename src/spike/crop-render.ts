/**
 * M0 实验一：裁剪渲染验证（spike，不进正式代码）
 *
 * 回答三个问题：
 *   Q1 坐标数学对不对？     → 像素级 diff + ±2px 对齐扫描
 *   Q2 裁剪版会不会更糊？   → 灰度画像（深色/中间调占比）
 *   Q3 裁剪到底省不省时间？ → 缩放扫描 + 多次取中位数
 *
 * Q3 才是决定架构的那一条。pdf.js 的 operator list 是全量执行的，
 * 裁剪只省"像素填充"，不省"指令处理"。所以必须把 scale 拉到整页画布
 * 超过 16MP 的区间去测 —— 那里整页栅格化成本是 O(scale²)，裁剪是 O(1)。
 */
import {
  pdfjsLib,
  installPdfWorker,
  pdfPolyfillsApplied,
  describePdfError,
  AnnotationMode,
  OPS,
} from '../pdfjs'

installPdfWorker()

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`缺少元素 #${id}`)
  return el as T
}

const fileInput = $<HTMLInputElement>('file')
const sampleSelect = $<HTMLSelectElement>('sample')
const pageInput = $<HTMLInputElement>('page')
const scaleInput = $<HTMLInputElement>('scale')
const maxScaleInput = $<HTMLInputElement>('maxScale')
const runsInput = $<HTMLInputElement>('runs')
const runBtn = $<HTMLButtonElement>('run')
const statusEl = $('status')
const reportEl = $('report')
const sweepEl = $('sweep')
const fullWrap = $('full-wrap')
const cropWrap = $('crop-wrap')
const diffWrap = $('diff-wrap')

// ---- Q4 滚动体感测试 ----
const scrollStartInput = $<HTMLInputElement>('scrollStart')
const scrollPagesInput = $<HTMLInputElement>('scrollPages')
const scrollScaleInput = $<HTMLInputElement>('scrollScale')
const scrollSecondsInput = $<HTMLInputElement>('scrollSeconds')
const scrollBtn = $<HTMLButtonElement>('runScroll')
const scrollStatusEl = $('scrollStatus')
const scrollStage = $('scrollStage')
const scrollReport = $('scrollReport')

// ---- Q5 算子分解 ----
const q5Btn = $<HTMLButtonElement>('runOps')
const q5StatusEl = $('opsStatus')
const q5Report = $('opsReport')

// ---- Q5b 多页画像 ----
const q5bBtn = $<HTMLButtonElement>('runScan')
const q5bStatusEl = $('scanStatus')
const q5bReport = $('scanReport')
const scanStartInput = $<HTMLInputElement>('scanStart')
const scanCountInput = $<HTMLInputElement>('scanCount')
const scanStepInput = $<HTMLInputElement>('scanStep')

// ===================================================================
// Q5b：多页算子画像
//
// 为什么需要它：Q5 单页分析跑的是**第 1 页**，而第 1 页往往是封面 ——
// 封面几乎总是一整张图，拿它得出的"成本归属"完全不代表正文页。
// （本轮就踩了这个坑：封面 5 个算子全是图片，让我误判整本书都是图片版。）
//
// 这一项按步长采样多页，每页只统计算子构成 + 渲染一次，
// 一眼看出这本书到底是「图片版」还是「文字页」。
// ===================================================================

const IMAGE_OPS = new Set([
  'paintImageXObject',
  'paintInlineImageXObject',
  'paintImageMaskXObject',
  'paintImageXObjectRepeat',
  'paintImageMaskXObjectRepeat',
  'paintSolidColorImageMask',
  'paintImageMaskXObjectGroup',
])

const PATH_OPS = new Set([
  'constructPath',
  'fill',
  'eoFill',
  'stroke',
  'closeStroke',
  'fillStroke',
  'eoFillStroke',
  'closeFillStroke',
  'closeEOFillStroke',
])

async function runPageScan(): Promise<void> {
  q5bBtn.disabled = true
  q5bReport.innerHTML = ''
  const t = (msg: string, kind: 'info' | 'ok' | 'warn' | 'err' = 'info') => {
    q5bStatusEl.className = kind
    q5bStatusEl.textContent = msg
  }

  try {
    t('准备文档…')
    const doc = await ensureDoc()
    const scale = Math.max(0.2, Number(scaleInput.value) || 1.5)
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const start = Math.max(1, Number(scanStartInput.value) || 1)
    const count = Math.min(Math.max(1, Number(scanCountInput.value) || 8), 40)
    const step = Math.max(1, Number(scanStepInput.value) || 3)

    const nameOf: Record<number, number | string> = {}
    for (const [k, v] of Object.entries(OPS as unknown as Record<string, number>)) {
      if (typeof v === 'number') nameOf[v] = k
    }
    const nameOfFn = (fn: number) => String(nameOf[fn] ?? fn)

    type Row = {
      page: number
      mp: number
      ops: number
      text: number
      image: number
      path: number
      opListMs: number
      renderMs: number
      kind: string
      topOps: string
    }
    const rows: Row[] = []

    for (let i = 0; i < count; i++) {
      const pn = start + i * step
      if (pn > doc.numPages) break
      t(`采样第 ${pn} 页（${i + 1}/${count}）…`)

      const page = await doc.getPage(pn)
      const vp = page.getViewport({ scale })

      const tOp = performance.now()
      const opList = await page.getOperatorList({ intent: 'print' })
      const opListMs = performance.now() - tOp

      const fnArr = opList.fnArray as number[]
      let text = 0
      let image = 0
      let path = 0
      const hist = new Map<string, number>()
      for (const fn of fnArr) {
        const n = nameOfFn(fn)
        hist.set(n, (hist.get(n) ?? 0) + 1)
        if (TEXT_OPS.has(n)) text++
        else if (IMAGE_OPS.has(n)) image++
        else if (PATH_OPS.has(n)) path++
      }

      const canvas = document.createElement('canvas')
      canvas.width = Math.round(vp.width * dpr)
      canvas.height = Math.round(vp.height * dpr)
      const ctx = canvas.getContext('2d')!
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      const tR = performance.now()
      await page.render({
        canvas,
        canvasContext: ctx,
        viewport: vp,
        intent: 'print',
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        annotationMode: AnnotationMode.DISABLE,
      }).promise
      const renderMs = performance.now() - tR
      canvas.width = canvas.height = 0

      const kind =
        fnArr.length <= 12 && image >= 1 && text < 5
          ? '整页图片（图片版/扫描件）'
          : text > 50
            ? '文字页'
            : image >= 1
              ? '图文混排'
              : '矢量/其它'

      const topOps = [...hist.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([n, c]) => `${n}:${c}`)
        .join('  ')

      rows.push({
        page: pn,
        mp: (canvas.width || Math.round(vp.width * dpr) * Math.round(vp.height * dpr)) / 1e6,
        ops: fnArr.length,
        text,
        image,
        path,
        opListMs,
        renderMs,
        kind,
        topOps,
      })
    }

    const imagePages = rows.filter((r) => r.kind.startsWith('整页图片')).length
    const textPages = rows.filter((r) => r.kind === '文字页').length
    const avgTextPageRender = textPages
      ? rows.filter((r) => r.kind === '文字页').reduce((a, r) => a + r.renderMs, 0) / textPages
      : 0
    const avgImagePageRender = imagePages
      ? rows.filter((r) => r.kind.startsWith('整页图片')).reduce((a, r) => a + r.renderMs, 0) /
        imagePages
      : 0

    const verdict =
      imagePages > rows.length / 2
        ? `<b>这本书主要是「图片版」</b>（每页一整张图）。成本在<b>图片解码</b> ——
           裁剪渲染帮不上（解码是整张的），该往「图片缓存 / 降采样解码」方向走。`
        : textPages > rows.length / 2
          ? `<b>这本书主要是「文字页」</b>。成本在<b>字形处理</b> ——
             裁剪渲染理论上有效，但实测 0.86~0.94×，说明 pdf.js 会让视口外的字形也走一遍处理。`
          : '采样页类型混杂，需要分别处理。'

    q5bReport.innerHTML = `
      <h2>Q5b 多页画像 · scale ${scale} · dpr ${dpr} · 第 ${start} 页起每 ${step} 页取一页</h2>
      <table>
        <tr>
          <th>页</th><th>画布</th><th>算子</th><th>文本</th><th>图像</th><th>路径</th>
          <th>列表构建</th><th>渲染</th><th>页面类型</th>
        </tr>
        ${rows
          .map(
            (r) => `
          <tr>
            <td>${r.page}</td>
            <td>${r.mp.toFixed(1)} MP</td>
            <td>${r.ops}</td>
            <td class="${r.text > 50 ? 'ok' : 'dim'}">${r.text}</td>
            <td class="${r.image > 0 ? 'warn' : 'dim'}">${r.image}</td>
            <td class="dim">${r.path}</td>
            <td>${r.opListMs.toFixed(0)} ms</td>
            <td><b>${r.renderMs.toFixed(0)} ms</b></td>
            <td class="${r.kind.startsWith('整页图片') ? 'warn' : 'ok'}">${r.kind}</td>
          </tr>`,
          )
          .join('')}
      </table>
      <p class="note">
        <b>分布</b>：整页图片 ${imagePages} 页 · 文字页 ${textPages} 页（共 ${rows.length} 页采样）<br />
        图片页平均渲染 ${avgImagePageRender.toFixed(0)} ms · 文字页平均渲染 ${avgTextPageRender.toFixed(0)} ms<br /><br />
        <b>诊断</b>：${verdict}
      </p>
      <h3>各页 Top 算子</h3>
      <table>
        <tr><th>页</th><th>Top 5 算子</th></tr>
        ${rows.map((r) => `<tr><td>${r.page}</td><td class="dim" style="font-size:11px">${r.topOps}</td></tr>`).join('')}
      </table>
    `

    ;(window as unknown as Record<string, unknown>).__scanResult = {
      doc: cachedName,
      scale,
      dpr,
      rows,
      imagePages,
      textPages,
      avgTextPageRender,
      avgImagePageRender,
    }

    t(
      `画像完成：图片页 ${imagePages} / 文字页 ${textPages}（共 ${rows.length} 页）`,
      imagePages > rows.length / 2 ? 'warn' : 'ok',
    )
  } catch (e) {
    const err = e as Error
    console.error('[spike] 多页画像失败', err)
    t(`出错：${err.message}`, 'err')
    const pre = document.createElement('pre')
    pre.className = 'stack'
    pre.textContent = describePdfError(err) + '\n\n' + (err.stack ?? '')
    q5bReport.appendChild(pre)
  } finally {
    q5bBtn.disabled = false
  }
}

// ---- Q7 重复渲染 / 缓存验证 ----
const q7Btn = $<HTMLButtonElement>('runRepeat')
const q7StatusEl = $('repeatStatus')
const q7Report = $('repeatReport')

// ===================================================================
// Q7：重复渲染 / 缓存验证
//
// 这是 M3 最关键的一个问题：**同一页重复渲染，会不会重复付费？**
//
// · 若第 2 次起明显变快  → pdf.js 内部有缓存（图片 / operator list），
//   那 M3 只要"渲染过就保留 canvas"即可，成本天然摊薄。
// · 若每次都一样慢      → 每次都在重新解码整张图。
//   那必须自己做 canvas 级缓存（渲染一次后不再重新渲染，直接复用位图），
//   并且要重新评估"缩放时重渲染"的代价。
//
// 对图片版 PDF（本项目主力语料）这一条尤其关键 —— 图片解码是最贵的一步。
// ===================================================================
async function runRepeatRender(): Promise<void> {
  q7Btn.disabled = true
  q7Report.innerHTML = ''
  const t = (msg: string, kind: 'info' | 'ok' | 'warn' | 'err' = 'info') => {
    q7StatusEl.className = kind
    q7StatusEl.textContent = msg
  }

  try {
    t('准备文档…')
    const doc = await ensureDoc()
    const pageNo = Math.min(Math.max(1, Number(pageInput.value) || 1), doc.numPages)
    const scale = Math.max(0.2, Number(scaleInput.value) || 1.5)
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const RUNS = 6

    // 分阶段计时，看时间花在"取页 / 建列表 / 绘制"哪一段
    const tPage = performance.now()
    const page = await doc.getPage(pageNo)
    const getPageMs = performance.now() - tPage
    const vp = page.getViewport({ scale })

    const tOp = performance.now()
    await page.getOperatorList({ intent: 'print' })
    const firstOpMs = performance.now() - tOp

    const tOp2 = performance.now()
    await page.getOperatorList({ intent: 'print' })
    const cachedOpMs = performance.now() - tOp2

    const canvas = document.createElement('canvas')
    canvas.width = Math.round(vp.width * dpr)
    canvas.height = Math.round(vp.height * dpr)

    /** 跑 RUNS 次，返回每次耗时 */
    const runSequence = async (intent: 'display' | 'print'): Promise<number[]> => {
      const times: number[] = []
      for (let i = 0; i < RUNS; i++) {
        const ctx = canvas.getContext('2d')!
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        const t0 = performance.now()
        await page.render({
          canvas,
          canvasContext: ctx,
          viewport: vp,
          intent,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
          annotationMode: AnnotationMode.DISABLE,
        }).promise
        times.push(performance.now() - t0)
      }
      return times
    }

    // 关键对照：print intent 可能走 putImageData（慢路径），
    // 而实际阅读用的是 display intent（很可能走 drawImage / GPU）。
    // 若两者差很多，说明 print 的数字不能代表真实体验。
    const printTimes = await runSequence('print')
    const displayTimes = await runSequence('display')

    const stat = (arr: number[]) => {
      const first = arr[0]!
      const rest = arr.slice(1)
      const restAvg = rest.reduce((a, b) => a + b, 0) / rest.length
      return { first, restAvg, ratio: restAvg / Math.max(first, 0.01) }
    }
    const sp = stat(printTimes)
    const sd = stat(displayTimes)

    // 以 display 为准判断缓存（那才是真实路径）
    const cached = sd.ratio < 0.75

    const verdict = cached
      ? `第 2 次起明显变快（${sd.ratio.toFixed(2)}×）→ <b>pdf.js 内部有缓存生效</b>。
         M3 只要做到"不重复发起渲染"就能天然摊薄成本。`
      : `每次耗时基本相同（${sd.ratio.toFixed(2)}×）→ <b>每次都在重新解码/重绘</b>，
         pdf.js 的缓存没帮上忙。必须自己做 canvas 级缓存：
         渲染一次后<b>保留位图、绝不重新渲染</b>，并且要重新评估"缩放时重渲染"的代价。`

    const intentDiff =
      sp.first > 0 && sd.first > 0
        ? `print 首次 ${sp.first.toFixed(0)}ms vs display 首次 ${sd.first.toFixed(0)}ms
           （display / print = ${(sd.first / sp.first).toFixed(2)}×）`
        : '—'

    q7Report.innerHTML = `
      <h2>Q7 重复渲染 · 第 ${pageNo} 页 · scale ${scale} · dpr ${dpr} · 连续 ${RUNS} 次</h2>
      <table>
        <tr><th>指标</th><th>值</th></tr>
        <tr><td>画布</td><td>${canvas.width} × ${canvas.height} px（${((canvas.width * canvas.height) / 1e6).toFixed(1)} MP）</td></tr>
        <tr><td>getPage()</td><td>${getPageMs.toFixed(1)} ms</td></tr>
        <tr><td>getOperatorList() 首次</td><td>${firstOpMs.toFixed(1)} ms</td></tr>
        <tr><td>getOperatorList() 再次（应命中缓存）</td><td>${cachedOpMs.toFixed(1)} ms</td></tr>
        <tr><td colspan="2" style="background:#14161a"></td></tr>
        <tr><td>render — <b>display</b> intent（真实阅读路径）</td><td>${displayTimes.map((v) => v.toFixed(0)).join(' / ')} ms</td></tr>
        <tr><td>render — print intent（可能走 putImageData 慢路径）</td><td>${printTimes.map((v) => v.toFixed(0)).join(' / ')} ms</td></tr>
        <tr><td><b>display：首次 / 后续均</b></td><td><b>${sd.first.toFixed(1)} / ${sd.restAvg.toFixed(1)} ms</b></td></tr>
        <tr><td><b>display：后续 / 首次</b></td><td class="${cached ? 'ok' : 'err'}"><b>${sd.ratio.toFixed(2)}×</b></td></tr>
        <tr><td>两种 intent 的首次对比</td><td>${intentDiff}</td></tr>
      </table>
      <p class="note"><b>诊断</b>：${verdict}</p>
    `

    ;(window as unknown as Record<string, unknown>).__repeatResult = {
      doc: cachedName,
      pageNo,
      scale,
      dpr,
      getPageMs,
      firstOpMs,
      cachedOpMs,
      printTimes,
      displayTimes,
      first: sd.first,
      restAvg: sd.restAvg,
      ratio: sd.ratio,
      printFirst: sp.first,
      displayFirst: sd.first,
      cached,
    }

    t(
      `重复渲染：display 首次 ${sd.first.toFixed(0)}ms，后续均 ${sd.restAvg.toFixed(0)}ms（${sd.ratio.toFixed(2)}×）` +
        ` · print 首次 ${sp.first.toFixed(0)}ms` +
        (cached ? ' · 缓存生效' : ' · 无缓存，每次重付费'),
      cached ? 'ok' : 'err',
    )
  } catch (e) {
    const err = e as Error
    console.error('[spike] 重复渲染测试失败', err)
    t(`出错：${err.message}`, 'err')
    const pre = document.createElement('pre')
    pre.className = 'stack'
    pre.textContent = describePdfError(err) + '\n\n' + (err.stack ?? '')
    q7Report.appendChild(pre)
  } finally {
    q7Btn.disabled = false
  }
}

// ---- Q6 加载选项对照 ----
const q6Btn = $<HTMLButtonElement>('runLoadOpts')
const q6StatusEl = $('loadOptsStatus')
const q6Report = $('loadOptsReport')

const log = (msg: string, kind: 'info' | 'ok' | 'warn' | 'err' = 'info') => {
  statusEl.className = kind
  statusEl.textContent = msg
}

/**
 * 环境探测。
 * 目的：在目标机上打开这个页面，就能一眼看出"能不能跑"以及"跑得动不动"。
 * 尤其是浏览器版本 —— pdf.js 6.x 依赖 ES2025 API，版本不够会直接打不开。
 */
function envSnapshot() {
  const ua = navigator.userAgent
  const m = ua.match(/(Edg|Edge|Chrome|Firefox)\/(\d+\.\d+)/)
  const nav = navigator as Navigator & { deviceMemory?: number }
  return {
    浏览器: m ? `${m[1]} ${m[2]}` : ua.slice(0, 80),
    用户代理: ua,
    是否安全上下文: window.isSecureContext,
    设备像素比: String(window.devicePixelRatio),
    逻辑核心数: String(navigator.hardwareConcurrency ?? '未知'),
    设备内存GB: String(nav.deviceMemory ?? '未知'),
    WebGL_渲染器: (() => {
      try {
        const c = document.createElement('canvas')
        const gl = (c.getContext('webgl') ?? c.getContext('experimental-webgl')) as
          | WebGLRenderingContext
          | null
        if (!gl) return '无（软件光栅化）'
        const dbg = gl.getExtension('WEBGL_debug_renderer_info')
        return dbg
          ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
          : String(gl.getParameter(gl.RENDERER))
      } catch {
        return '探测失败'
      }
    })(),
    已补齐Polyfill: pdfPolyfillsApplied().join(', ') || '无（浏览器较新）',
  }
}

function renderEnvPanel() {
  const el = document.getElementById('env')
  if (!el) return
  const info = envSnapshot()
  el.innerHTML = `
    <table>
      ${Object.entries(info)
        .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`)
        .join('')}
    </table>
  `
  ;(window as unknown as Record<string, unknown>).__spikeEnv = info
}

const fmtMs = (v: number) => `${v.toFixed(1)} ms`
const pct = (v: number) => `${(v * 100).toFixed(2)}%`

function ctxOf(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('拿不到 2d context')
  return ctx
}

/**
 * 渲染一次，返回耗时。
 *
 * intent 是关键开关：
 *   'display'（默认）—— pdf.js 会把渲染切片到 requestAnimationFrame 里
 *      （源码里 useRequestAnimationFrame: !isPrint）。于是**任何**小于一帧的渲染
 *      都只会测出 ~16.67ms（60Hz 的帧节拍），真实计算量被完全掩盖。
 *   'print' —— pdf.js 关闭 rAF 切片，一口气渲染完，测到的才是真实栅格化成本。
 *
 * 两者都要测：display 反映"用户能感知到的延迟"，print 反映"CPU/GPU 实际干了多少活"。
 */
async function renderOnce(
  page: pdfjsLib.PDFPageProxy,
  canvas: HTMLCanvasElement,
  viewport: pdfjsLib.PageViewport,
  dpr: number,
  pxW: number,
  pxH: number,
  intent: 'display' | 'print' = 'display',
): Promise<number> {
  canvas.width = Math.max(1, Math.round(pxW))
  canvas.height = Math.max(1, Math.round(pxH))
  const ctx = ctxOf(canvas)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  const t0 = performance.now()
  await page.render({
    canvas,
    canvasContext: ctx,
    viewport,
    intent,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    annotationMode: AnnotationMode.DISABLE,
  }).promise
  return performance.now() - t0
}

/**
 * 内容占比：以页面自身的主色调为基准，统计明显偏离它的像素占比。
 *
 * 不能用"非白像素" —— 扫描件或带整幅背景图的页面会 100% 非白，判据直接失效。
 * 实测那本《Computer Science: An Overview》就是 99.4%~100%，完全失去区分度。
 * 换成"相对主色偏离"后，空白页 ≈ 0%、文字页 ≈ 10~20%、整幅照片页才会很高。
 */
function contentRatio(canvas: HTMLCanvasElement) {
  const w = Math.min(400, canvas.width)
  const h = Math.min(400, canvas.height)
  const x = Math.max(0, Math.floor((canvas.width - w) / 2))
  const y = Math.max(0, Math.floor((canvas.height - h) / 2))
  const img = ctxOf(canvas).getImageData(x, y, w, h)
  const n = img.data.length / 4

  const hist = new Uint32Array(32)
  const lums = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const lum = (0.299 * img.data[o]! + 0.587 * img.data[o + 1]! + 0.114 * img.data[o + 2]!) | 0
    lums[i] = lum
    hist[lum >> 3]!++
  }
  let modeBin = 0
  for (let b = 1; b < 32; b++) if (hist[b]! > hist[modeBin]!) modeBin = b
  const bgLum = modeBin * 8 + 4

  let content = 0
  for (let i = 0; i < n; i++) if (Math.abs(lums[i]! - bgLum) > 32) content++
  return { content: content / n, bgLum }
}

/** JS 堆占用（MB）。Chrome/Edge 专有 API，用来在目标机上观察内存水位。 */
function heapMB(): number | null {
  const m = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
  return m ? m.usedJSHeapSize / 1048576 : null
}

/** 渲染多次取中位数 —— 单次耗时太小（个位数 ms），不取中位数会被噪声带跑 */
async function renderMedian(
  page: pdfjsLib.PDFPageProxy,
  canvas: HTMLCanvasElement,
  viewport: pdfjsLib.PageViewport,
  dpr: number,
  pxW: number,
  pxH: number,
  runs: number,
  intent: 'display' | 'print' = 'display',
): Promise<{ median: number; samples: number[] }> {
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    samples.push(await renderOnce(page, canvas, viewport, dpr, pxW, pxH, intent))
  }
  const sorted = [...samples].sort((a, b) => a - b)
  return { median: sorted[Math.floor(sorted.length / 2)]!, samples }
}

/** 逐通道平均绝对误差 + 差异分布 */
function meanAbsDiff(a: ImageData, b: ImageData, w: number, h: number) {
  const n = Math.min(a.data.length, b.data.length)
  let sum = 0
  let max = 0
  let count = 0
  let over16 = 0
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1

  for (let i = 0; i < n; i += 4) {
    const d = Math.max(
      Math.abs(a.data[i]! - b.data[i]!),
      Math.abs(a.data[i + 1]! - b.data[i + 1]!),
      Math.abs(a.data[i + 2]! - b.data[i + 2]!),
    )
    sum += d
    count++
    if (d > max) max = d
    if (d > 16) {
      over16++
      const px = (i >> 2) % w
      const py = Math.floor((i >> 2) / w)
      if (px < minX) minX = px
      if (px > maxX) maxX = px
      if (py < minY) minY = py
      if (py > maxY) maxY = py
    }
  }
  return {
    mean: count ? sum / count : 0,
    max,
    over16,
    over16Ratio: count ? over16 / count : 0,
    bbox: maxX >= 0 ? { minX, minY, maxX: maxX + 1, maxY: maxY + 1 } : null,
  }
}

/** 灰度画像：判断某一版是不是"更糊"（深色像素变少、中间调变多 = 糊） */
function toneProfile(img: ImageData) {
  const n = img.data.length / 4
  let dark = 0
  let mid = 0
  for (let i = 0; i < img.data.length; i += 4) {
    const lum = 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!
    if (lum < 64) dark++
    else if (lum < 200) mid++
  }
  return { dark: dark / n, mid: mid / n }
}

function drawDiff(a: ImageData, b: ImageData, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(w, h)
  for (let i = 0; i < a.data.length; i += 4) {
    const v = Math.min(255, Math.abs(a.data[i]! - b.data[i]!) * 8)
    img.data[i] = v
    img.data[i + 1] = v
    img.data[i + 2] = v
    img.data[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return canvas
}

async function loadBytes(): Promise<{ bytes: Uint8Array; name: string } | null> {
  const sample = sampleSelect.value
  if (sample) {
    const res = await fetch(sample)
    if (!res.ok) throw new Error(`取内置样本失败：HTTP ${res.status}`)
    return { bytes: new Uint8Array(await res.arrayBuffer()), name: sample }
  }
  const file = fileInput.files?.[0]
  if (!file) return null
  return { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name }
}

// ---- 文档缓存：滚动测试要复用同一份文档，不能每次都重新解析 ----
let cachedDoc: pdfjsLib.PDFDocumentProxy | null = null
let cachedTask: pdfjsLib.PDFDocumentLoadingTask | null = null
let cachedName = ''
let cachedBytes: Uint8Array | null = null

/** 读取当前选中的文档字节（缓存一份，Q6 要反复重新加载做对照） */
async function currentBytes(): Promise<{ bytes: Uint8Array; name: string }> {
  const loaded = await loadBytes()
  if (!loaded) throw new Error('先选一个内置样本，或选一个本地 PDF 文件')
  if (!cachedBytes || cachedName !== loaded.name) {
    // ⚠️ 必须留一份**原始副本**。getDocument 会 transfer ArrayBuffer 的所有权，
    // 之后原始 Uint8Array 的底层 buffer 就被 detach 了，
    // 再对它 .slice() 会拿到空数据 —— Q6 第一次跑就是这么全挂的。
    cachedBytes = loaded.bytes.slice()
  }
  // 每次都返回副本，绝不把 pristine 副本直接交出去
  return { bytes: cachedBytes.slice(), name: loaded.name }
}

async function ensureDoc(): Promise<pdfjsLib.PDFDocumentProxy> {
  const loaded = await currentBytes()
  if (cachedDoc && cachedName === loaded.name) return cachedDoc

  if (cachedTask) await cachedTask.destroy().catch(() => {})
  cachedDoc = null
  cachedTask = pdfjsLib.getDocument({
    data: loaded.bytes,
    cMapUrl: '/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/standard_fonts/',
  })
  cachedDoc = await cachedTask.promise
  cachedName = loaded.name
  return cachedDoc
}

function clearOutputs() {
  reportEl.innerHTML = ''
  sweepEl.innerHTML = ''
  for (const el of [fullWrap, cropWrap, diffWrap]) el.innerHTML = ''
}

async function run() {
  runBtn.disabled = true
  clearOutputs()

  try {
    log('正在准备文档…')
    const doc = await ensureDoc().catch((e: Error) => {
      log(e.message, 'warn')
      return null
    })
    if (!doc) return
    log(`已加载 ${cachedName}`)

    const polys = pdfPolyfillsApplied()
    console.info(
      `[spike] polyfill: ${polys.length ? polys.join(', ') : '无需补齐（浏览器较新）'}`,
    )

    const pageNo = Math.min(Math.max(1, Number(pageInput.value) || 1), doc.numPages)
    const scale = Math.max(0.2, Number(scaleInput.value) || 1.5)
    const maxScale = Math.max(scale, Number(maxScaleInput.value) || 6)
    const runs = Math.min(15, Math.max(3, Number(runsInput.value) || 5))
    const page = await doc.getPage(pageNo)
    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    // ---- 预热：字体/CMap 懒加载 + operator list 首次编译 ----
    // 注意：display 和 print 两种 intent 的 operator list 是**分开缓存**的，
    // 必须各自预热，否则第一次测量会把编译开销算进去。
    log('预热（固定开销，不计入测量）…')
    await page.getOperatorList()
    await page.getOperatorList({ intent: 'print' })
    {
      const warm = document.createElement('canvas')
      await renderOnce(page, warm, page.getViewport({ scale: 1 }), 1, 300, 400, 'display')
      await renderOnce(page, warm, page.getViewport({ scale: 1 }), 1, 300, 400, 'print')
    }

    // ================= Q1 / Q2：像素验证 =================
    log('Q1/Q2：渲染整页与裁剪区，做像素比对…')
    const baseVp = page.getViewport({ scale })
    const fullPxW = baseVp.width * dpr
    const fullPxH = baseVp.height * dpr
    const cropW = Math.min(400, Math.floor(baseVp.width * 0.6))
    const cropH = Math.min(300, Math.floor(baseVp.height * 0.4))
    const cropX = Math.floor((baseVp.width - cropW) / 2)
    const cropY = Math.floor((baseVp.height - cropH) / 2)

    const fullCanvas = document.createElement('canvas')
    await renderOnce(page, fullCanvas, baseVp, dpr, fullPxW, fullPxH)

    const cropCanvas = document.createElement('canvas')
    const cropVp = page.getViewport({ scale, offsetX: -cropX, offsetY: -cropY })
    await renderOnce(page, cropCanvas, cropVp, dpr, cropW * dpr, cropH * dpr)

    const w = cropCanvas.width
    const h = cropCanvas.height
    const a = ctxOf(fullCanvas).getImageData(Math.round(cropX * dpr), Math.round(cropY * dpr), w, h)
    const b = ctxOf(cropCanvas).getImageData(0, 0, w, h)
    const { mean, max, over16, over16Ratio, bbox } = meanAbsDiff(a, b, w, h)

    // 对齐扫描：若有非零偏移能显著改善 → 位移 bug
    const padded = ctxOf(fullCanvas).getImageData(
      Math.round(cropX * dpr) - 2,
      Math.round(cropY * dpr) - 2,
      w + 4,
      h + 4,
    )
    let best = { dx: 0, dy: 0, mean: Number.POSITIVE_INFINITY }
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const shifted = new ImageData(w, h)
        for (let y = 0; y < h; y++) {
          const srcRow = ((y + 2 + dy) * (w + 4) + (2 + dx)) * 4
          shifted.data.set(padded.data.subarray(srcRow, srcRow + w * 4), y * w * 4)
        }
        const r = meanAbsDiff(shifted, b, w, h)
        if (r.mean < best.mean) best = { dx, dy, mean: r.mean }
      }
    }

    const toneFull = toneProfile(a)
    const toneCrop = toneProfile(b)
    const aligned = best.dx === 0 && best.dy === 0
    const blurRisk =
      toneCrop.dark < toneFull.dark * 0.92 && toneCrop.mid > toneFull.mid * 1.08

    diffWrap.appendChild(drawDiff(a, b, w, h))
    diffWrap.insertAdjacentHTML('beforeend', '<div class="cap">差异放大 8 倍</div>')
    fullWrap.appendChild(fullCanvas)
    fullWrap.insertAdjacentHTML('beforeend', `<div class="cap">整页渲染</div>`)
    cropWrap.appendChild(cropCanvas)
    cropWrap.insertAdjacentHTML('beforeend', `<div class="cap">裁剪渲染</div>`)

    reportEl.innerHTML = `
      <h2 class="${aligned && !blurRisk ? 'ok' : 'err'}">
        Q1 坐标数学：${aligned ? '正确' : '⚠ 疑似位移'} ·
        Q2 清晰度：${blurRisk ? '⚠ 裁剪版更糊' : '无损失'}
      </h2>
      <table>
        <tr><th>指标</th><th>值</th></tr>
        <tr><td>页数 / 本次页</td><td>${doc.numPages} / ${pageNo}</td></tr>
        <tr><td>scale / dpr</td><td>${scale} / ${dpr}</td></tr>
        <tr><td>整页画布</td><td>${fullPxW.toFixed(0)} × ${fullPxH.toFixed(0)} px（${((fullPxW * fullPxH) / 1e6).toFixed(1)} MP，约 ${((fullPxW * fullPxH * 4) / 1048576).toFixed(0)} MB）</td></tr>
        <tr><td>裁剪区</td><td>${cropW} × ${cropH} @ (${cropX}, ${cropY})</td></tr>
        <tr><td>平均绝对误差</td><td class="${mean < 1 ? 'ok' : 'warn'}">${mean.toFixed(3)}（最大 ${max}）</td></tr>
        <tr><td>差异 &gt;16 像素占比</td><td>${pct(over16Ratio)}（${over16} 个）</td></tr>
        <tr><td>差异包围盒</td><td>${bbox ? `x ${bbox.minX}–${bbox.maxX}，y ${bbox.minY}–${bbox.maxY}` : '无'}</td></tr>
        <tr>
          <td>±2px 对齐扫描最优解</td>
          <td class="${aligned ? 'ok' : 'err'}">
            (dx=${best.dx}, dy=${best.dy}) → ${best.mean.toFixed(3)}
            ${aligned ? '· 最优即原位，确认无位移' : '· ⚠ 存在更优偏移'}
          </td>
        </tr>
        <tr>
          <td>灰度画像（深 / 中）</td>
          <td>
            整页区 ${pct(toneFull.dark)} / ${pct(toneFull.mid)} ·
            裁剪版 ${pct(toneCrop.dark)} / ${pct(toneCrop.mid)}
          </td>
        </tr>
      </table>
      <p class="note">
        <b>Q1/Q2 怎么读</b>：误差集中在字形边缘且对齐扫描最优解就是原位 →
        坐标数学正确，差异只是亚像素抗锯齿。若对齐扫描给出非零最优解，
        那才是位移 bug，必须修。
      </p>
    `

    // ================= Q3：缩放扫描 =================
    log('Q3：缩放扫描…')
    const scales: number[] = []
    if (maxScale <= scale) {
      // 只测一档。注意不能直接算 step —— maxScale === scale 时 step = 0 会死循环
      scales.push(Number(scale.toFixed(2)))
    } else {
      const step = (maxScale - scale) / 4
      for (let s = scale; s <= maxScale + 1e-6; s += step) {
        scales.push(Number(s.toFixed(2)))
      }
    }

    type Row = {
      scale: number
      fullMP: number
      fullActual: string
      // display intent：pdf.js 切成 rAF 分片，测到的是"用户感知延迟"，有 ~16.67ms 下限
      fullMsDisp: number
      cropMsDisp: number
      // print intent：关掉 rAF 分片，测到的才是真实栅格化成本
      fullMsPrint: number
      cropMsPrint: number
      speedupPrint: number
      contentFull: number
      contentCrop: number
      heapMB: number | null
    }
    const rows: Row[] = []

    for (const s of scales) {
      const vp = page.getViewport({ scale: s })
      const fW = vp.width * dpr
      const fH = vp.height * dpr
      const fMP = (fW * fH) / 1e6

      // 整页画布过大时跳过，避免把浏览器打爆（这也正是问题本身）
      if (fMP > 40) continue

      const cW = Math.min(400, Math.floor(vp.width * 0.6))
      const cH = Math.min(300, Math.floor(vp.height * 0.4))
      const cX = Math.floor((vp.width - cW) / 2)
      const cY = Math.floor((vp.height - cH) / 2)
      const cvp = page.getViewport({ scale: s, offsetX: -cX, offsetY: -cY })

      const fullCanvas = document.createElement('canvas')
      const cropCanvas = document.createElement('canvas')

      // —— display intent ——
      const fDisp = await renderMedian(page, fullCanvas, vp, dpr, fW, fH, runs, 'display')
      const cDisp = await renderMedian(page, cropCanvas, cvp, dpr, cW * dpr, cH * dpr, runs, 'display')
      const contentCrop = contentRatio(cropCanvas).content

      // —— print intent（真实成本）——
      const fPrint = await renderMedian(page, fullCanvas, vp, dpr, fW, fH, runs, 'print')
      const cPrint = await renderMedian(page, cropCanvas, cvp, dpr, cW * dpr, cH * dpr, runs, 'print')

      // 重画一次完整页用于内容占比与画布尺寸核对
      await renderOnce(page, fullCanvas, vp, dpr, fW, fH, 'display')
      const contentFull = contentRatio(fullCanvas).content

      rows.push({
        scale: s,
        fullMP: fMP,
        fullActual: `${fullCanvas.width}×${fullCanvas.height}`,
        fullMsDisp: fDisp.median,
        cropMsDisp: cDisp.median,
        fullMsPrint: fPrint.median,
        cropMsPrint: cPrint.median,
        speedupPrint: fPrint.median / Math.max(cPrint.median, 0.01),
        contentFull,
        contentCrop,
        heapMB: heapMB(),
      })
    }

    sweepEl.innerHTML = `
      <h2>Q3 缩放扫描（每档 ${runs} 次取中位数）</h2>
      <table>
        <tr>
          <th rowspan="2">scale</th>
          <th rowspan="2">整页画布</th>
          <th colspan="2">display intent<br /><span class="dim">含 rAF 帧节拍，有 16.67ms 下限</span></th>
          <th colspan="2">print intent<br /><span class="dim">关掉 rAF 分片，真实栅格化成本</span></th>
          <th rowspan="2">提速<br /><span class="dim">按 print</span></th>
          <th rowspan="2">内容占比<br /><span class="dim">整页/裁剪</span></th>
          <th rowspan="2">JS 堆</th>
        </tr>
        <tr>
          <th>整页</th><th>裁剪</th>
          <th>整页</th><th>裁剪</th>
        </tr>
        ${rows
          .map(
            (r) => `
          <tr>
            <td>${r.scale}</td>
            <td class="${r.fullMP > 16 ? 'warn' : ''}">${r.fullMP.toFixed(1)} MP${r.fullMP > 16 ? ' ⚠' : ''}<br /><span class="dim">${r.fullActual}</span></td>
            <td>${fmtMs(r.fullMsDisp)}</td>
            <td>${fmtMs(r.cropMsDisp)}</td>
            <td><b>${fmtMs(r.fullMsPrint)}</b></td>
            <td><b>${fmtMs(r.cropMsPrint)}</b></td>
            <td class="${r.speedupPrint > 1.5 ? 'ok' : r.speedupPrint > 1.15 ? '' : 'err'}">
              ${r.speedupPrint.toFixed(2)}×
            </td>
            <td>${(r.contentFull * 100).toFixed(1)}% / ${(r.contentCrop * 100).toFixed(1)}%</td>
            <td class="dim">${r.heapMB === null ? '—' : r.heapMB.toFixed(0) + ' MB'}</td>
          </tr>`,
          )
          .join('')}
      </table>
      <p class="note">
        <b>先搞清楚哪一列能信。</b><br />
        · <b>display intent</b> 是 pdf.js 的默认模式，它把渲染切片到 requestAnimationFrame 里
          （源码：<code>useRequestAnimationFrame: !isPrint</code>）。于是<b>任何小于一帧的渲染都只能测出
          ~16.67ms</b> —— 这是 60Hz 的帧节拍，不是计算耗时。你机器上那组
          "从 0.7MP 到 20.5MP 都是 16.6ms" 的数据就是这么来的，不能用来判断裁剪的收益。<br />
        · <b>print intent</b> 关掉 rAF 分片，一口气跑完，测到的才是真实栅格化成本。<b>看这一组。</b><br />
        · <b>内容占比</b>：相对页面主色调偏离的像素比例。空白页 ≈ 0%，文字页 ≈ 10~20%。
          如果某档是 0%，说明那一档没画出内容，耗时不作数。
          （早期版本用的是"非白像素"，遇到带整幅背景的扫描页会全变成 100%，已换掉。）<br />
        <br />
        <b>怎么下结论：</b>
        看 print 那两列。若高倍下提速稳定 &gt; 1.5 → 裁剪值得做；
        若始终 ≈ 1 → 说明栅格化本来就不贵、瓶颈在别处（同时渲染的页数、文本层构建、内存），
        裁剪的价值就只剩「恒定内存 + 绕开 16MP 上限」。
      </p>
    `

    const valid = rows.filter((r) => r.speedupPrint > 0)
    const avgSpeedup = valid.length
      ? valid.reduce((s, r) => s + r.speedupPrint, 0) / valid.length
      : Number.NaN
    log(
      `完成 · Q1 ${aligned ? '通过' : '未通过'} · print 提速均值 ${Number.isNaN(avgSpeedup) ? '—' : avgSpeedup.toFixed(2) + '×'} · dpr=${dpr}`,
      aligned && avgSpeedup > 1.5 ? 'ok' : aligned ? 'warn' : 'err',
    )

    ;(window as unknown as Record<string, unknown>).__spikeResult = {
      scale,
      mean,
      max,
      over16Ratio,
      aligned,
      best,
      toneFull,
      toneCrop,
      rows,
      avgSpeedup,
      polyfills: polys,
    }

    // 注意：这里**不销毁文档** —— 滚动测试要复用同一份，
    // 否则每次跑都得重新解析（624 页的书解析一次不便宜）。
  } catch (e) {
    const err = e as Error
    // 把堆栈也打出来 —— 只有 message 没法定位（尤其涉及 worker / 第三方库时）
    console.error('[spike] 失败', err)
    const friendly = describePdfError(err)
    log('出错，详见下方', 'err')
    const detail = document.createElement('pre')
    detail.className = 'stack'
    detail.textContent = [
      friendly,
      '',
      '── 原始信息 ──',
      `name: ${err.name}`,
      `stack:`,
      err.stack ?? '（无堆栈）',
      '',
      `内建样本选择: ${JSON.stringify(sampleSelect.value)}`,
      `本地文件: ${fileInput.files?.[0]?.name ?? '（无）'}  size=${fileInput.files?.[0]?.size ?? '-'}`,
      `workerSrc: ${pdfjsLib.GlobalWorkerOptions.workerSrc || '（未设置）'}`,
      `页面地址: ${window.location.href}`,
      `是否安全上下文: ${window.isSecureContext}`,
    ].join('\n')
    reportEl.appendChild(detail)
    ;(window as unknown as Record<string, unknown>).__spikeError = {
      name: err.name,
      message: err.message,
      friendly,
      stack: err.stack ?? null,
      workerSrc: pdfjsLib.GlobalWorkerOptions.workerSrc,
    }
  } finally {
    runBtn.disabled = false
  }
}

// ===================================================================
// Q4：滚动体感测试（帧率）
//
// 为什么需要它：单页渲染耗时测出来 print=45~107ms、display=16.6ms，
// 两个数互相矛盾，且都不随面积单调变化，都不能用来定论。
// 而"卡"的定义本来就不是单页耗时，是**滚动时的帧率**。
// 这个测试直接测帧率，用体感指标来裁决 M3 的方向。
// ===================================================================
async function runScrollTest(): Promise<void> {
  scrollBtn.disabled = true
  scrollReport.innerHTML = ''
  scrollStage.innerHTML = ''
  const t = (msg: string, kind: 'info' | 'ok' | 'warn' | 'err' = 'info') => {
    scrollStatusEl.className = kind
    scrollStatusEl.textContent = msg
  }

  try {
    t('准备文档…')
    const doc = await ensureDoc()

    const startPage = Math.min(Math.max(1, Number(scrollStartInput.value) || 1), doc.numPages)
    const pageCount = Math.min(
      Math.max(1, Number(scrollPagesInput.value) || 8),
      doc.numPages - startPage + 1,
      60,
    )
    const scale = Math.max(0.2, Number(scrollScaleInput.value) || 2)
    const seconds = Math.min(Math.max(2, Number(scrollSecondsInput.value) || 6), 30)
    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    // ---- 1) 先搭版面（只算尺寸，不渲染）—— 这就是"连续滚动"的骨架 ----
    type Slot = {
      pageNumber: number
      el: HTMLDivElement
      rendered: boolean
      rendering: boolean
      top: number
      width: number
      height: number
      renderMs: number
    }
    const slots: Slot[] = []
    const inner = document.createElement('div')
    inner.style.position = 'relative'
    inner.style.width = '100%'
    scrollStage.appendChild(inner)

    let y = 0
    for (let k = 0; k < pageCount; k++) {
      const pn = startPage + k
      const p = await doc.getPage(pn)
      const vp = p.getViewport({ scale })
      const el = document.createElement('div')
      el.style.cssText =
        `position:absolute;left:50%;transform:translateX(-50%);` +
        `top:${y}px;width:${vp.width}px;height:${vp.height}px;` +
        `background:#2a2f38;outline:1px solid #3a4150;`
      inner.appendChild(el)
      slots.push({
        pageNumber: pn,
        el,
        rendered: false,
        rendering: false,
        top: y,
        width: vp.width,
        height: vp.height,
        renderMs: 0,
      })
      y += vp.height + 12
    }
    inner.style.height = `${y}px`

    // ---- 2) 渲染调度：最多 2 个并发，渲染视口上下各一屏内的页 ----
    let inflight = 0
    const MAX_CONCURRENT = 2
    const pending = new Set<Slot>()

    const renderSlot = async (slot: Slot) => {
      slot.rendering = true
      inflight++
      const t0 = performance.now()
      try {
        const p = await doc.getPage(slot.pageNumber)
        const vp = p.getViewport({ scale })
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(slot.width * dpr)
        canvas.height = Math.round(slot.height * dpr)
        canvas.style.cssText = 'width:100%;height:100%;display:block;'
        const ctx = canvas.getContext('2d')!
        await p.render({
          canvas,
          canvasContext: ctx,
          viewport: vp,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
          annotationMode: AnnotationMode.DISABLE,
        }).promise
        slot.el.appendChild(canvas)
        slot.rendered = true
        slot.renderMs = performance.now() - t0
      } catch {
        /* 取消等异常忽略 */
      } finally {
        slot.rendering = false
        inflight--
      }
    }

    const pump = () => {
      if (inflight >= MAX_CONCURRENT) return
      for (const s of [...pending]) {
        if (inflight >= MAX_CONCURRENT) break
        pending.delete(s)
        void renderSlot(s)
      }
    }

    const updateVisible = () => {
      const top = scrollStage.scrollTop
      const bottom = top + scrollStage.clientHeight
      const pad = scrollStage.clientHeight
      for (const s of slots) {
        if (
          !s.rendered &&
          !s.rendering &&
          !pending.has(s) &&
          s.top < bottom + pad &&
          s.top + s.height > top - pad
        ) {
          pending.add(s)
        }
      }
      pump()
    }

    // ---- 3) 自动滚动 + 采集帧时间 ----
    scrollStage.scrollTop = 0
    updateVisible()
    await new Promise((r) => setTimeout(r, 500)) // 让首屏先渲染
    updateVisible()

    const maxScroll = Math.max(1, inner.clientHeight - scrollStage.clientHeight)
    const speed = Math.max(4, maxScroll / (seconds * 60))
    const frames: number[] = []
    let last = performance.now()
    const t0 = last
    let scrolled = 0

    await new Promise<void>((resolve) => {
      const step = (now: number) => {
        frames.push(now - last)
        last = now
        scrolled = Math.min(maxScroll, scrolled + speed)
        scrollStage.scrollTop = scrolled
        updateVisible()
        if (now - t0 < seconds * 1000 && scrolled < maxScroll) requestAnimationFrame(step)
        else resolve()
      }
      requestAnimationFrame(step)
    })

    // ---- 4) 统计 ----
    const sorted = [...frames].sort((a, b) => a - b)
    const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
    const p50 = pick(0.5)
    const p95 = pick(0.95)
    const maxFrame = sorted[sorted.length - 1] ?? 0
    const janky = frames.filter((f) => f > 33).length
    const bad = frames.filter((f) => f > 50).length

    const rendered = slots.filter((s) => s.rendered)
    const avgRender = rendered.length
      ? rendered.reduce((a, s) => a + s.renderMs, 0) / rendered.length
      : 0

    const fps = p50 > 0 ? 1000 / p50 : 0
    // 两个维度必须分开看 —— 这是本次实测最重要的教训：
    // 「滚动流畅」和「新页出现得快」是两件独立的事。
    // 滚动只花主线程极少时间（更新 scrollTop + rAF），所以帧率可以很漂亮；
    // 但每一页真正画出来要多久，决定的是"白屏等多久"。
    const scrollVerdict = p95 <= 20 ? '顺' : p95 <= 33 ? '勉强' : '卡'
    const scrollCls = scrollVerdict === '顺' ? 'ok' : scrollVerdict === '勉强' ? 'warn' : 'err'
    const popVerdict = avgRender <= 100 ? '跟得上' : avgRender <= 250 ? '有可感白屏' : '白屏明显'
    const popCls = avgRender <= 100 ? 'ok' : avgRender <= 250 ? 'warn' : 'err'

    const diagnosis =
      avgRender <= 100
        ? '单页渲染够快，无需优化渲染路径。把精力放在文本层与内存上。'
        : p95 > 33
          ? '滚动本身就掉帧 → 说明主线程被渲染占满。裁剪渲染 + 降低并发都可能有效。'
          : `滚动不掉帧、但单页要 ${avgRender.toFixed(0)}ms 才画出来 → 瓶颈是<b>单页栅格化本身</b>。
             裁剪渲染（只画视口）在这里收益最大：可见区域通常只占整页的 1/4 ~ 1/10。`

    scrollReport.innerHTML = `
      <h2 class="${scrollCls}">Q4 滚动 ${scrollVerdict}（帧时间 p95 = ${p95.toFixed(1)} ms ≈ ${(1000 / p95).toFixed(0)} fps）</h2>
      <h2 class="${popCls}">新页出现：${popVerdict}（平均 ${avgRender.toFixed(0)} ms）</h2>
      <table>
        <tr><th>指标</th><th>值</th></tr>
        <tr><td>文档 / 本次区间</td><td>${cachedName} · 第 ${startPage}–${startPage + pageCount - 1} 页（${pageCount} 页）</td></tr>
        <tr><td>scale / dpr</td><td>${scale} / ${dpr}</td></tr>
        <tr><td>滚动时长 / 采集帧数</td><td>${seconds} s / ${frames.length} 帧</td></tr>
        <tr><td><b>帧时间 p50</b></td><td class="ok"><b>${p50.toFixed(1)} ms</b>（≈ ${fps.toFixed(0)} fps）</td></tr>
        <tr><td><b>帧时间 p95</b></td><td class="${scrollCls}"><b>${p95.toFixed(1)} ms</b>（≈ ${(1000 / p95).toFixed(0)} fps）</td></tr>
        <tr><td>最长单帧</td><td>${maxFrame.toFixed(1)} ms</td></tr>
        <tr><td>掉帧（&gt;33ms / &gt;50ms）</td><td class="${bad > 0 ? 'err' : 'ok'}">${janky} 帧 / ${bad} 帧</td></tr>
        <tr><td><b>新页出现：平均单页耗时</b></td><td class="${popCls}"><b>${avgRender.toFixed(0)} ms</b>（渲染 ${rendered.length} 页）</td></tr>
        <tr><td>每页画布</td><td>${
          rendered.length
            ? `${Math.round(rendered[0]!.width * dpr)} × ${Math.round(rendered[0]!.height * dpr)} px（${((rendered[0]!.width * dpr * rendered[0]!.height * dpr) / 1e6).toFixed(1)} MP，约 ${((rendered[0]!.width * dpr * rendered[0]!.height * dpr * 4) / 1048576).toFixed(0)} MB）`
            : '—'
        }</td></tr>
      </table>
      <p class="note">
        <b>诊断</b>：${diagnosis}<br /><br />
        <b>为什么要把两个维度分开</b>：滚动本身只花主线程极少时间（更新 scrollTop + 调度 rAF），
        所以哪怕每页要几百 ms 才画出来，<b>帧率依然可以是满帧</b> ——
        单纯看帧率会得出"很流畅"的错误结论。<br />
        真正被用户感知的是<b>空白占位块停留多久</b>，那对应的是「平均单页耗时」。<br /><br />
        <b>参考阈值</b>：滚动 p95 ≤ 20ms 顺；单页耗时 ≤ 100ms 跟得上、≤ 250ms 有可感白屏、&gt; 250ms 白屏明显。
      </p>
    `

    ;(window as unknown as Record<string, unknown>).__scrollResult = {
      doc: cachedName,
      startPage,
      pageCount,
      scale,
      dpr,
      frames: frames.length,
      p50,
      p95,
      maxFrame,
      janky,
      bad,
      renderedPages: rendered.length,
      avgRender,
      scrollVerdict,
      popVerdict,
      diagnosis,
    }

    t(
      `滚动 ${scrollVerdict} · 新页 ${popVerdict}：p95=${p95.toFixed(1)}ms，平均单页 ${avgRender.toFixed(0)}ms，掉帧 ${janky} 帧`,
      popCls,
    )
  } catch (e) {
    const err = e as Error
    console.error('[spike] 滚动测试失败', err)
    t(`出错：${err.message}`, 'err')
    const pre = document.createElement('pre')
    pre.className = 'stack'
    pre.textContent = describePdfError(err) + '\n\n' + (err.stack ?? '')
    scrollReport.appendChild(pre)
  } finally {
    scrollBtn.disabled = false
  }
}

// ===================================================================
// Q5：算子分解 —— 找出每页那几百毫秒到底花在哪
//
// 背景：中文书上「画布面积涨 4.3 倍、耗时只涨 1.25 倍」（400ms → 502ms），
// 说明成本与画布大小几乎无关，是**每页固定的算子/字形处理开销**。
// 裁剪渲染省的是像素填充，所以对它无效（实测 0.86~0.94×，负收益）。
//
// 这个测试把一页的渲染按算子类型拆开，回答"是文本算子贵还是别的贵"。
// 用 render() 的 operationsFilter 参数实现（pdf.js 6 提供）。
// 注意：过滤算子会破坏 PDF 的状态机，结果只用于**定位成本归属**，不代表正确渲染。
// ===================================================================

/** 只服务于文本绘制的算子 */
const TEXT_OPS = new Set([
  'beginText',
  'endText',
  'setCharWidth',
  'setCharWidthAndBounds',
  'setFont',
  'setTextMatrix',
  'nextLine',
  'showText',
  'nextLineShowText',
  'nextLineSetSpacingShowText',
  'setTextRenderingMode',
  'setTextRise',
  'setLeading',
  'setLeadingMoveText',
  'setCharSpacing',
  'setWordSpacing',
  'setHScale',
])

async function runOpBreakdown(): Promise<void> {
  q5Btn.disabled = true
  q5Report.innerHTML = ''
  const t = (msg: string, kind: 'info' | 'ok' | 'warn' | 'err' = 'info') => {
    q5StatusEl.className = kind
    q5StatusEl.textContent = msg
  }

  try {
    t('准备文档…')
    const doc = await ensureDoc()
    const pageNo = Math.min(Math.max(1, Number(pageInput.value) || 1), doc.numPages)
    const scale = Math.max(0.2, Number(scaleInput.value) || 1.5)
    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    const page = await doc.getPage(pageNo)
    const vp = page.getViewport({ scale })

    // ---- 1) operator list：构建耗时 + 算子直方图 ----
    t('取算子列表…')
    const tOp0 = performance.now()
    const opList = await page.getOperatorList({ intent: 'print' })
    const opListMs = performance.now() - tOp0

    const nameOf: Record<number, number | string> = {}
    for (const [k, v] of Object.entries(OPS as unknown as Record<string, number>)) {
      if (typeof v === 'number') nameOf[v] = k
    }
    const nameOfFn = (fn: number) => String(nameOf[fn] ?? fn)

    const fnArr = opList.fnArray as number[]
    const hist = new Map<string, number>()
    for (const fn of fnArr) {
      const n = nameOfFn(fn)
      hist.set(n, (hist.get(n) ?? 0) + 1)
    }
    const top = [...hist.entries()].sort((a, b) => b[1] - a[1])
    const textOpCount = fnArr.filter((fn) => TEXT_OPS.has(nameOfFn(fn))).length

    // ---- 2) 按算子类型过滤后分别计时 ----
    const OTHERS = new Set(top.map(([n]) => n).filter((n) => !TEXT_OPS.has(n)))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(vp.width * dpr)
    canvas.height = Math.round(vp.height * dpr)

    const timeRender = async (allowed: Set<string> | null): Promise<number> => {
      const samples: number[] = []
      for (let pass = 0; pass < 3; pass++) {
        const ctx = canvas.getContext('2d')!
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        const t0 = performance.now()
        await page.render({
          canvas,
          canvasContext: ctx,
          viewport: vp,
          intent: 'print',
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
          annotationMode: AnnotationMode.DISABLE,
          ...(allowed
            ? {
                operationsFilter: ((index: number, ol: { fnArray: number[] }) =>
                  allowed.has(nameOfFn(ol.fnArray[index]!))) as unknown as (
                  index: number,
                  operatorList: unknown,
                ) => boolean,
              }
            : {}),
        }).promise
        samples.push(performance.now() - t0)
      }
      samples.sort((a, b) => a - b)
      return samples[1]! // 取中位数
    }

    t('渲染分解（全部 / 仅文本 / 仅非文本）…')
    const tAll = await timeRender(null)
    const tText = await timeRender(TEXT_OPS)
    const tOther = await timeRender(OTHERS)

    // ---- 3) 报告 ----
    const textShare = tAll > 0 ? tText / tAll : 0
    const otherShare = tAll > 0 ? tOther / tAll : 0
    const summary =
      textShare > 0.6
        ? '成本主要在<b>文本算子</b>（字形处理）。这类成本与画布大小无关 —— ' +
          '裁剪渲染省的是像素填充，对它无效。要提速只能减少字形处理量，' +
          '或换渲染内核（PDFium 的字形处理是 C++）。'
        : otherShare > 0.6
          ? '成本主要在<b>非文本算子</b>（路径/图像/填充等）。这类成本部分与面积相关，' +
            '裁剪渲染可能有效，值得再细分成"图像算子"和"路径算子"分别测。'
          : '成本在文本与非文本之间较为平均，说明没有单一热点，需要更细的分解。'

    q5Report.innerHTML = `
      <h2>Q5 算子分解 · 第 ${pageNo} 页 · scale ${scale} · dpr ${dpr}</h2>
      <table>
        <tr><th>指标</th><th>值</th></tr>
        <tr><td>画布</td><td>${canvas.width} × ${canvas.height} px（${((canvas.width * canvas.height) / 1e6).toFixed(1)} MP）</td></tr>
        <tr><td>算子列表构建耗时</td><td>${opListMs.toFixed(1)} ms</td></tr>
        <tr><td><b>算子总数</b></td><td><b>${fnArr.length}</b></td></tr>
        <tr><td>其中文本算子</td><td>${textOpCount}（${((textOpCount / Math.max(1, fnArr.length)) * 100).toFixed(1)}%）</td></tr>
        <tr><td><b>渲染：全部算子</b></td><td><b>${tAll.toFixed(1)} ms</b></td></tr>
        <tr><td>渲染：仅文本算子</td><td class="${textShare > 0.6 ? 'err' : ''}">${tText.toFixed(1)} ms（占 ${(textShare * 100).toFixed(0)}%）</td></tr>
        <tr><td>渲染：仅非文本算子</td><td class="${otherShare > 0.6 ? 'err' : ''}">${tOther.toFixed(1)} ms（占 ${(otherShare * 100).toFixed(0)}%）</td></tr>
      </table>
      <p class="note"><b>诊断</b>：${summary}</p>
      <h3>算子类型 Top 15</h3>
      <table>
        <tr><th>算子</th><th>数量</th><th>占比</th></tr>
        ${top
          .slice(0, 15)
          .map(
            ([n, c]) =>
              `<tr><td class="${TEXT_OPS.has(n) ? 'warn' : ''}">${n}${TEXT_OPS.has(n) ? ' ·文本' : ''}</td><td>${c}</td><td>${((c / Math.max(1, fnArr.length)) * 100).toFixed(1)}%</td></tr>`,
          )
          .join('')}
      </table>
      <p class="note">
        <b>注意</b>：算子过滤会破坏 PDF 的状态机（比如滤掉 setFont 后 showText 就没有字体），
        所以"仅文本 / 仅非文本"两档的结果<b>只用于判断成本归属，不代表能正确渲染</b>。
        另外两档之和通常大于"全部"，因为状态机被破坏后部分算子会退化。
      </p>
    `

    ;(window as unknown as Record<string, unknown>).__opsResult = {
      doc: cachedName,
      pageNo,
      scale,
      dpr,
      ops: fnArr.length,
      textOps: textOpCount,
      opListMs,
      tAll,
      tText,
      tOther,
      textShare,
      otherShare,
      top: top.slice(0, 15),
    }

    t(`算子分解完成：${fnArr.length} 个算子，全部 ${tAll.toFixed(0)}ms，文本 ${tText.toFixed(0)}ms`, 'ok')
  } catch (e) {
    const err = e as Error
    console.error('[spike] 算子分解失败', err)
    t(`出错：${err.message}`, 'err')
    const pre = document.createElement('pre')
    pre.className = 'stack'
    pre.textContent = describePdfError(err) + '\n\n' + (err.stack ?? '')
    q5Report.appendChild(pre)
  } finally {
    q5Btn.disabled = false
  }
}

// ===================================================================
// Q6：加载选项对照 —— 找有没有"不改架构就能提速"的开关
//
// 如果 Q5 显示成本集中在字形处理，最省事的希望就是：pdf.js 的某个加载选项
// 能让字形处理快几倍（比如改用系统字体、或用 GPU 加速的 canvas）。
// 这一项用不同选项各加载一次同一份 PDF，对同一页渲染计时做对照。
// ===================================================================
type LoadVariant = { label: string; opts: Record<string, unknown> }

const LOAD_VARIANTS: LoadVariant[] = [
  { label: '默认（基线）', opts: {} },
  { label: 'enableHWA: true（GPU canvas）', opts: { enableHWA: true } },
  { label: 'useSystemFonts: true（用系统字体）', opts: { useSystemFonts: true } },
  { label: 'disableFontFace: true（自绘字形路径）', opts: { disableFontFace: true } },
]

async function runLoadOptions(): Promise<void> {
  q6Btn.disabled = true
  q6Report.innerHTML = ''
  const t = (msg: string, kind: 'info' | 'ok' | 'warn' | 'err' = 'info') => {
    q6StatusEl.className = kind
    q6StatusEl.textContent = msg
  }

  try {
    t('准备字节…')
    const { bytes } = await currentBytes()
    const pageNo = Math.min(Math.max(1, Number(pageInput.value) || 1), 1e6)
    const scale = Math.max(0.2, Number(scaleInput.value) || 1.5)
    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    const base = {
      cMapUrl: '/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/standard_fonts/',
    }

    type Row = { label: string; loadMs: number; renderMs: number; ops: number; error?: string }
    const rows: Row[] = []

    for (const v of LOAD_VARIANTS) {
      t(`对照：${v.label}`)
      const row: Row = { label: v.label, loadMs: 0, renderMs: 0, ops: 0 }
      let task: pdfjsLib.PDFDocumentLoadingTask | null = null
      try {
        const t0 = performance.now()
        // 注意：必须复制字节，因为 getDocument 会转移 ArrayBuffer 的所有权
        task = pdfjsLib.getDocument({
          data: bytes.slice(),
          ...base,
          ...v.opts,
        })
        const d = await task.promise
        row.loadMs = performance.now() - t0

        const pn = Math.min(pageNo, d.numPages)
        const p = await d.getPage(pn)
        const vp = p.getViewport({ scale })
        // 预热，避免把 operator list 构建算进渲染耗时
        const pre = await p.getOperatorList({ intent: 'print' })
        row.ops = pre.fnArray.length

        const canvas = document.createElement('canvas')
        canvas.width = Math.round(vp.width * dpr)
        canvas.height = Math.round(vp.height * dpr)
        const samples: number[] = []
        for (let pass = 0; pass < 3; pass++) {
          const ctx = canvas.getContext('2d')!
          ctx.setTransform(1, 0, 0, 1, 0, 0)
          ctx.fillStyle = '#fff'
          ctx.fillRect(0, 0, canvas.width, canvas.height)
          const t1 = performance.now()
          await p.render({
            canvas,
            canvasContext: ctx,
            viewport: vp,
            intent: 'print',
            transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
            annotationMode: AnnotationMode.DISABLE,
          }).promise
          samples.push(performance.now() - t1)
        }
        samples.sort((a, b) => a - b)
        row.renderMs = samples[1]!
      } catch (e) {
        row.error = (e as Error).message
      } finally {
        if (task) await task.destroy().catch(() => {})
      }
      rows.push(row)
    }

    const baseline = rows[0]
    const ok = rows.filter((r) => !r.error && r.renderMs > 0)
    // 注意要传初值 —— 全部失败时 reduce 空数组会抛
    // "Reduce of empty array with no initial value"
    const best = ok.reduce<Row | null>((a, b) => (!a || b.renderMs < a.renderMs ? b : a), null)

    q6Report.innerHTML = `
      <h2>Q6 加载选项对照 · 第 ${pageNo} 页 · scale ${scale} · dpr ${dpr}</h2>
      <table>
        <tr><th>加载选项</th><th>加载耗时</th><th>算子数</th><th>渲染耗时</th><th>相对基线</th></tr>
        ${rows
          .map((r) => {
            if (r.error) {
              return `<tr><td>${r.label}</td><td colspan="4" class="err">失败：${r.error}</td></tr>`
            }
            const ratio = baseline && baseline.renderMs > 0 ? r.renderMs / baseline.renderMs : 1
            const cls = ratio < 0.8 ? 'ok' : ratio > 1.25 ? 'err' : ''
            return `<tr>
              <td>${r.label}</td>
              <td>${r.loadMs.toFixed(0)} ms</td>
              <td>${r.ops}</td>
              <td>${r.renderMs.toFixed(0)} ms</td>
              <td class="${cls}">${ratio.toFixed(2)}×</td>
            </tr>`
          })
          .join('')}
      </table>
      <p class="note">
        <b>怎么用</b>：只看最右列。任何一项明显小于 1.00× 都是白捡的收益 ——
        只要改一个加载参数，不动架构。<br />
        · 若 <code>useSystemFonts</code> 明显更快 → 中文页面的慢来自"嵌入字体解析/构建"，
          改用系统字体可解（但要检查字形是否显示正常）。<br />
        · 若 <code>enableHWA</code> 明显更快 → canvas 没走 GPU 加速，打开它即可。<br />
        · 若 <code>disableFontFace</code> 明显更快 → 说明 FontFace 路径有问题，值得深查。<br />
        · <b>全部都在 1.00× 附近</b> → 没有免费的午餐，成本确实是 pdf.js 的字形处理本身，
          只能靠"减少处理量"（缓存 / 降低并发）或"换内核（PDFium）"来解决。
      </p>
    `

    ;(window as unknown as Record<string, unknown>).__loadOptResult = {
      doc: cachedName,
      pageNo,
      scale,
      dpr,
      rows,
      best: best?.label ?? null,
      bestRatio: baseline && baseline.renderMs > 0 && best ? best.renderMs / baseline.renderMs : null,
    }

    t(
      `选项对照完成 · 最优「${best?.label ?? '—'}」` +
        (baseline && best ? ` = ${(best.renderMs / Math.max(1, baseline.renderMs)).toFixed(2)}×` : ''),
      'ok',
    )
  } catch (e) {
    const err = e as Error
    console.error('[spike] 选项对照失败', err)
    t(`出错：${err.message}`, 'err')
    const pre = document.createElement('pre')
    pre.className = 'stack'
    pre.textContent = describePdfError(err) + '\n\n' + (err.stack ?? '')
    q6Report.appendChild(pre)
  } finally {
    q6Btn.disabled = false
  }
}

runBtn.addEventListener('click', () => void run())
scrollBtn.addEventListener('click', () => void runScrollTest())
q5Btn.addEventListener('click', () => void runOpBreakdown())
q5bBtn.addEventListener('click', () => void runPageScan())
q6Btn.addEventListener('click', () => void runLoadOptions())
q7Btn.addEventListener('click', () => void runRepeatRender())

// 页面一打开就把环境信息铺出来 —— 在目标机上截图就能定位问题
renderEnvPanel()
