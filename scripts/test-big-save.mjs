/**
 * 用一本**真实的大 PDF** 验保存耗时（几十 MB 那一档）。
 *
 * 走完整 UI：从文件列表打开 → 画几笔 → 点保存 → 量到 toast 出现的时间。
 * 顺便核对产物：体积应约等于原文件 + 几 KB，且能被 pdf-lib 重新解析、批注数对得上。
 *
 * 用法：
 *   node scripts/test-big-save.mjs                    # 自动挑 my-test-books/ 里最大的那个
 *   node scripts/test-big-save.mjs <某个.pdf>          # 指定文件
 *   EPL_BIG_PDF=<某个.pdf> node scripts/test-big-save.mjs
 *
 * ⚠️ `my-test-books/` 不入库（可能是个人的书），所以文件名**不写死**在里面。
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXE = resolve(ROOT, 'src-tauri/target/release/edge-pdf-lite.exe')
const BOOKS_DIR = resolve(ROOT, 'my-test-books')
const SAVE_DIR = resolve(ROOT, 'exe-shots', 'big-save')

/** 在 books 目录里挑最大的 pdf —— 用它当"最坏情况"的样本 */
function pickBiggestPdf(dir) {
  if (!existsSync(dir)) return null
  let best = null
  for (const name of readdirSync(dir)) {
    if (!/\.pdf$/i.test(name)) continue
    const p = join(dir, name)
    try {
      const sz = statSync(p).size
      if (!best || sz > best.size) best = { path: p, size: sz }
    } catch {
      /* 读不了就跳过 */
    }
  }
  return best?.path ?? null
}

const BOOK = process.argv[2] || process.env.EPL_BIG_PDF || pickBiggestPdf(BOOKS_DIR)
if (!BOOK || !existsSync(BOOK)) {
  console.error(
    '没找到大 PDF。把一本书放进 my-test-books/（不入库），或者显式传路径：\n' +
      '  node scripts/test-big-save.mjs D:////books////some-big.pdf',
  )
  process.exit(1)
}
const BOOK_NAME = basename(BOOK)
const SAVED_NAME = BOOK_NAME.replace(/\.pdf$/i, '') + '(已批注).pdf'
const PORT = 9355
const SANDBOX = join(tmpdir(), 'epl-big-save-sandbox')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`)
  ok ? pass++ : fail++
}

if (!existsSync(BOOK)) {
  console.error(`找不到测试书：${BOOK}`)
  process.exit(1)
}
await mkdir(SAVE_DIR, { recursive: true })
// 每次重跑先清干净，免得上一轮的「已批注」被误当成这一轮的产物
await rm(join(SAVE_DIR, SAVED_NAME), { force: true }).catch(() => {})

const proc = spawn(EXE, [], {
  stdio: 'ignore',
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: SANDBOX,
    EPL_ALLOW_ROOTS: [dirname(BOOK), SAVE_DIR].join(';'),
  },
})
const shutdown = () => {
  try {
    proc.kill()
  } catch {
    /* ignore */
  }
}
process.on('exit', shutdown)

let target = null
for (let i = 0; i < 60; i++) {
  await sleep(500)
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const t = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl)
    if (t) {
      target = t
      break
    }
  } catch {
    /* 等 */
  }
}
if (!target) {
  console.error('连不上调试端口')
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res)
  ws.addEventListener('error', () => rej(new Error('ws')))
})
let id = 0
const pending = new Map()
const dialogs = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    return
  }
  if (m.method === 'Page.javascriptDialogOpening') {
    dialogs.push(m.params?.message ?? '')
    ws.send(
      JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: false } }),
    )
  }
})
const send = (method, params) =>
  new Promise((res, rej) => {
    const i = ++id
    pending.set(i, { res, rej })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  })
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  }
  return r.result.value
}
await send('Runtime.enable')
await send('Page.enable')
await sleep(1500)

const bookMB = ((await stat(BOOK)).size / 1048576).toFixed(1)
console.log(`\n[0] 准备：${bookMB} MB 的书`)

await evaluate(`
  localStorage.setItem('epl:file-list', JSON.stringify([
    { name: ${JSON.stringify(BOOK_NAME)}, path: ${JSON.stringify(BOOK)}, kind: 'file' },
  ]));
  localStorage.setItem('epl.settings.v1', JSON.stringify({
    saveMode: 'copy',
    saveDir: ${JSON.stringify(SAVE_DIR)},
    backupPos: 'same',
    theme: 'dark',
  }));
  localStorage.removeItem('epl:last-doc');
`)
await send('Page.reload')
await sleep(2500)

// ---- 打开
const tOpen0 = performance.now()
await evaluate(`document.querySelector('[data-tid="side-file"]')?.click()`)
await sleep(800)
await evaluate(`document.querySelector('[data-tid="files-panel"] [data-kind="file"]')?.click()`)
let opened = false
for (let i = 0; i < 120; i++) {
  await sleep(500)
  opened = await evaluate(`!!document.querySelector('.page-slot[data-page="1"]')`)
  if (opened) break
}
check('打开了这本 92 MB 的书', opened, `耗时 ${Math.round(performance.now() - tOpen0)} ms`)

// ---- 画 3 笔（跨 2 页，模拟"手写 + 框线 + 区域高亮"里最重的那种）
await evaluate(`document.querySelector('[data-tid="annot-toggle"]')?.click()`)
await sleep(300)
await evaluate(`document.querySelector('[data-tid="tool-ink"]')?.click()`)
await sleep(300)
const box = JSON.parse(
  await evaluate(`(() => {
    const s = document.querySelector('.page-slot[data-page="1"]');
    const r = s.getBoundingClientRect();
    return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height });
  })()`),
)
const mouseAt = (type, x, y, buttons) =>
  send('Input.dispatchMouseEvent', {
    type,
    x: Math.round(x),
    y: Math.round(y),
    button: 'left',
    buttons,
    clickCount: 1,
  })
for (let k = 0; k < 3; k++) {
  const cy = box.y + 200 + k * 60
  await mouseAt('mousePressed', box.x + 80, cy, 1)
  for (let i = 1; i <= 16; i++) {
    await mouseAt('mouseMoved', box.x + 80 + i * 9, cy + Math.sin(i / 2) * 12, 1)
    await sleep(10)
  }
  await mouseAt('mouseReleased', box.x + 224, cy, 0)
  await sleep(250)
}
check(
  '画上了 3 笔（有东西可存）',
  (await evaluate(`Number(document.querySelector('[data-tid="annot-count"]')?.textContent ?? 0)`)) === 3,
  `徽标=${await evaluate(`document.querySelector('[data-tid="annot-count"]')?.textContent`)}`,
)

// ---- 保存
const t0 = performance.now()
await evaluate(`document.querySelector('[data-tid="save"]')?.click()`)
let toast = ''
for (let i = 0; i < 240; i++) {
  await sleep(250)
  toast = await evaluate(`(document.querySelector('.toast') || {}).textContent || ''`)
  if (/已保存|已覆盖|失败/.test(toast)) break
}
const saveMs = Math.round(performance.now() - t0)
const errText = await evaluate(`(document.querySelector('.err') || {}).textContent || ''`)
if (errText) console.log(`     错误框：${errText.replace(/\s+/g, ' ').slice(0, 160)}`)

check('保存完成（不是超时）', /已保存|已覆盖/.test(toast), `${saveMs} ms`)
check('**保存耗时 < 8 秒**（改之前这台机器上 3 分钟都没好）', saveMs < 8000, `${saveMs} ms`)
console.log(`     toast：${toast.replace(/\s+/g, ' ').slice(0, 120)}`)

// ---- 产物核对
const saved = join(SAVE_DIR, SAVED_NAME)
if (existsSync(saved)) {
  const origSize = (await stat(BOOK)).size
  const newSize = (await stat(saved)).size
  check(
    '产物 = 原文件 + 几 KB（确实是增量追加，没重写整档）',
    newSize > origSize && newSize - origSize < 2 * 1024 * 1024,
    `${(origSize / 1048576).toFixed(1)} MB → ${(newSize / 1048576).toFixed(1)} MB（+${newSize - origSize} B）`,
  )
  // 直接查批注数：原书 + 3
  const { PDFDocument } = await import('@cantoo/pdf-lib')
  const doc = await PDFDocument.load(await readFile(saved), { ignoreEncryption: true })
  let n = 0
  for (const p of doc.getPages()) n += p.node.Annots()?.size() ?? 0
  const origDoc = await PDFDocument.load(await readFile(BOOK), { ignoreEncryption: true })
  let n0 = 0
  for (const p of origDoc.getPages()) n0 += p.node.Annots()?.size() ?? 0
  check('产物里批注数 = 原书 + 3', n === n0 + 3, `${n0} → ${n}`)
  check('产物页数没变', doc.getPageCount() === origDoc.getPageCount(), `${doc.getPageCount()} 页`)
} else {
  check('产物落盘了', false, saved)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
ws.close()
shutdown()
process.exit(fail ? 1 : 0)
