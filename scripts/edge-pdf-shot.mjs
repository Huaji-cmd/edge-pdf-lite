/**
 * 用 **Edge 内置的 PDF 查看器（PDFium）** 打开一份 PDF 并逐页截图。
 *
 * 为什么需要它：项目铁律里写着「pdf.js 能画 ≠ Edge/Acrobat 能画」。
 * 我们的所有自动化都在 pdf.js 上跑（`test-annot` / `test-writer`），
 * 但用户真正打开 PDF 用的是 Edge —— 那是另一套实现（C++ PDFium）。
 * 这个脚本把「跨查看器核对」里能自动化的那部分自动化掉。
 *
 * ⚠️ 无头模式下的 PDF 插件行为可能和真实窗口不同（插件是独立进程）。
 * 截图里要是空白，别急着判定"批注没画出来" —— 先用带界面的方式手动看一遍。
 *
 * 用法：
 *   node scripts/edge-pdf-shot.mjs public/testdata/written.pdf [页码...]
 *   EPL_HEADFUL=1 node scripts/edge-pdf-shot.mjs <pdf>   # 用真实窗口（更可信）
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(ROOT, 'viewer-shots')
await mkdir(OUT, { recursive: true })

const pdfArg = process.argv[2]
if (!pdfArg) {
  console.error('用法：node scripts/edge-pdf-shot.mjs <pdf 路径或 URL> [页码...]')
  process.exit(1)
}
const PAGES = process.argv.slice(3).map(Number).filter(Number.isFinite)
const URL_TARGET = /^https?:/.test(pdfArg)
  ? pdfArg
  : 'http://localhost:4173/' + encodeURI(pdfArg.replace(/^.*?public\//, ''))
const PORT = Number(process.env.EPL_PORT ?? 9603)
const HEADFUL = !!process.env.EPL_HEADFUL

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))
if (!EDGE) {
  console.error('找不到 Edge')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userDataDir = await mkdtemp(join(tmpdir(), 'epl-pdfshot-'))
let child
let ws

try {
  child = spawn(
    EDGE,
    [
      ...(HEADFUL ? [] : ['--headless=new']),
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=1100,1200',
      // 放大 2 倍截图 —— PDF 查看器会按窗口宽度适配，不放大根本看不清小字
      '--force-device-scale-factor=2',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  let wsUrl = null
  for (let i = 0; i < 80 && !wsUrl; i++) {
    await sleep(250)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? null
    } catch {
      /* 还没起来 */
    }
  }
  if (!wsUrl) throw new Error('DevTools 没起来')

  ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })

  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id !== undefined && pending.has(m.id)) {
      const { resolve: res, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(JSON.stringify(m.error))) : res(m.result)
    }
  })
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const n = ++id
      pending.set(n, { resolve: res, reject: rej })
      ws.send(JSON.stringify({ id: n, method, params }))
    })

  await send('Page.enable')

  const base = basename(pdfArg).replace(/\.pdf$/i, '')
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    const p = join(OUT, `${name}.png`)
    await writeFile(p, Buffer.from(r.data, 'base64'))
    console.log(`  已存 ${p}`)
  }

  /** 浏览器内置查看器认 `#page=N&zoom=Z` 这两个 URL 参数 —— 比模拟翻页可靠得多 */
  const open = async (page, zoom) => {
    const hash = page ? `#page=${page}&zoom=${zoom}` : `#zoom=${zoom}`
    await send('Page.navigate', { url: URL_TARGET + hash })
    // PDF 插件加载比网页慢，给足时间
    await sleep(page ? 4500 : 6000)
  }

  /*
   * 缩放可调：默认 150% 够看清细节，但整页高 842pt 时 150% 就是 1263px ——
   * 比 1050px 的窗口还高，**页面下半部会被裁掉**（"批注没显示"的假象）。
   * 要看全页就把 EPL_ZOOM 调小（如 90）。
   */
  const ZOOM = Number(process.env.EPL_ZOOM ?? 150)

  const wanted = PAGES.length ? PAGES : [1]
  for (const p of wanted) {
    console.log(`→ Edge 内置查看器打开 ${URL_TARGET}#page=${p}&zoom=${ZOOM}`)
    await open(p, ZOOM)
    await shot(`edge-${base}-p${p}`)
  }

  console.log(
    '\n⚠️ 无头模式下 PDF 插件可能不渲染（截图空白 ≠ 批注没写对）。\n' +
      '   要更可信的结论：EPL_HEADFUL=1 再跑一次，或在 Edge 里手动打开该文件。',
  )
} catch (e) {
  console.error(`失败：${e.message}`)
  process.exitCode = 1
} finally {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  child?.kill()
  await sleep(400)
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
}
