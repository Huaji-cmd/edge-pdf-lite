/**
 * 批注「写回 PDF」端到端自检（驱动 `write-check.html`）。
 *
 * 与 `test-annot.mjs` 的关系：那个验「手工构造的注释字典能不能被 pdf.js 认出来」，
 * 这个验「产品代码 writer.ts 生成的文件对不对」—— 中间隔着 pdf-lib 的 obj() 转换、
 * 增量更新、字体资源，任何一环出错都会写出「自家读着没错、别人打不开」的文件。
 *
 * 断言分三层：
 *   ① 结构（pdf.js）：原有批注不丢、新增批注的子类型/作者//AP 正确
 *   ② 原始字典（pdf-lib 绕过 pdf.js）：/T /NM 是 PDFString、/AP 的 Matrix 是单位矩阵
 *   ③ 渲染差分：写回前后同页逐像素比对，差分像素必须全部落在 /Rect 内
 *
 * 另外把写回结果存成 public/testdata/written.pdf —— 这是给人工在 Edge / Acrobat 里
 * 核对用的（脚本只能证明 pdf.js 侧没问题）。
 *
 * 用法：node scripts/test-writer.mjs [url]
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = resolve(ROOT, 'writer-shots')
await mkdir(SHOTS, { recursive: true })

const TARGET = process.argv[2] ?? 'http://localhost:4173/write-check.html'
const PORT = Number(process.env.EPL_PORT ?? 9602)

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p))

if (!EDGE) {
  console.error('找不到浏览器')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userDataDir = await mkdtemp(join(tmpdir(), 'epl-writer-'))
let child
let ws
let passed = 0
let failed = 0

function check(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  ✅ ${name}${detail ? '  ' + detail : ''}`)
  } else {
    failed++
    console.log(`  ❌ ${name}${detail ? '  ' + detail : ''}`)
  }
  return ok
}

try {
  child = spawn(
    EDGE,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=1400,1200',
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
  const consoleErrs = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id !== undefined && pending.has(m.id)) {
      const { resolve: res, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(JSON.stringify(m.error))) : res(m.result)
      return
    }
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      consoleErrs.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '))
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrs.push('EXCEPTION: ' + (m.params.exceptionDetails?.exception?.description ?? ''))
    }
  })
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const n = ++id
      pending.set(n, { resolve: res, reject: rej })
      ws.send(JSON.stringify({ id: n, method, params }))
    })

  await send('Runtime.enable')
  await send('Page.enable')

  console.log(`→ 打开 ${TARGET}`)
  await send('Page.navigate', { url: TARGET })
  await sleep(2500)

  const evaluate = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
    if (r.exceptionDetails) {
      throw new Error(
        `页面内异常：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`,
      )
    }
    return r.result?.value
  }

  const hasBtn = await evaluate(`!!document.getElementById('runCheck')`)
  if (!hasBtn) throw new Error('write-check.html 没加载出来（#runCheck 不存在）')

  console.log('\n[1] 触发写回自检')
  await evaluate(`document.getElementById('runCheck').click(); 'clicked'`)

  let result = null
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    const status = await evaluate(`document.getElementById('status').textContent`)
    if (status.startsWith('自检') || status.startsWith('出错')) {
      result = JSON.parse(await evaluate(`JSON.stringify(window.__writeCheck ?? null)`))
      break
    }
    await sleep(500)
  }

  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    await writeFile(join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'))
  }
  await shot('01-write-check')

  if (!result) {
    check('写回自检跑出结果', false, '超时或页面报错')
    // 拿不到结构化结果时，把页面状态和控制台原样打出来 —— 否则只能靠猜
    const st = await evaluate(`document.getElementById('status').textContent`).catch(() => '?')
    const err = await evaluate(
      `document.querySelector('#report pre.stack')?.textContent ?? ''`,
    ).catch(() => '')
    console.log(`     页面状态：${st}`)
    if (err) console.log(`     页面堆栈：\n${String(err).split('\n').slice(0, 8).join('\n')}`)
    if (consoleErrs.length) console.log(`     控制台：${consoleErrs.slice(0, 5).join('\n             ')}`)
    throw new Error('没有拿到结构化结果')
  }

  console.log(`\n     写回：${(result.bytesBefore / 1024).toFixed(1)} KB → ${(result.bytesAfter / 1024).toFixed(1)} KB，耗时 ${result.writeMs?.toFixed(0)} ms`)
  console.log(`     原有批注 ${result.baseTotal} 条，逐页保留情况 ${(result.oldKept ?? []).join('/')}`)

  console.log('\n[2] 页面内断言')
  for (const c of result.checks ?? []) {
    check(c.name, c.ok, c.detail)
  }

  console.log('\n[3] 渲染差分明细')
  for (const d of result.diffs ?? []) {
    console.log(
      `     P${d.page}  差分 ${String(d.diffPx).padStart(6)} px  ` +
        `实测 ${JSON.stringify(d.got)}  期望 ${JSON.stringify(d.expect)}  ${d.inside ? '✅' : '❌'}`,
    )
  }

  // 位图存盘 —— 数字全绿不等于看起来对，差分图必须自己看
  for (const [i, s] of (result.shots ?? []).entries()) {
    for (const [k, durl] of [
      ['before', s.before],
      ['after', s.after],
    ]) {
      const b64 = String(durl).split(',')[1]
      if (b64) await writeFile(join(SHOTS, `0${i + 1}-${k}.jpg`), Buffer.from(b64, 'base64'))
    }
  }
  console.log(`     差分图：${join(SHOTS, '0*-before.jpg')} / ${join(SHOTS, '0*-after.jpg')}`)

  // 写回结果落盘 —— 给人工在 Edge / Acrobat 里核对
  if (result.writtenBase64) {
    const out = join(ROOT, 'public', 'testdata', 'written.pdf')
    await writeFile(out, Buffer.from(result.writtenBase64, 'base64'))
    console.log(`\n     写回结果已存盘：${out}（拿去 Edge / Acrobat 里人工核对）`)
  }

  // ---------------------------------------------------------------- 端到端：真在阅读器里画一笔再保存
  console.log('\n[4] 端到端：阅读器里画一笔 → 点「保存批注」→ 抓下载文件')
  const DL = resolve(ROOT, 'writer-shots', 'downloads')
  await rm(DL, { recursive: true, force: true }).catch(() => {})
  await mkdir(DL, { recursive: true })
  await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL })

  await send('Page.navigate', { url: TARGET.replace(/write-check\.html.*$/, '') })
  await sleep(2500)

  await send('DOM.enable')
  const docRoot = await send('DOM.getDocument', { depth: -1 })
  const fileInput = await send('DOM.querySelector', {
    nodeId: docRoot.root.nodeId,
    selector: 'input[type=file]',
  })
  const fixture = resolve(ROOT, 'public', 'testdata', 'annot-fixture.pdf')
  await send('DOM.setFileInputFiles', { nodeId: fileInput.nodeId, files: [fixture] })

  const toolbarBtn = (label) =>
    evaluate(`
      (() => {
        const b = [...document.querySelectorAll('.toolbar button')]
          .find((x) => x.textContent.trim() === ${JSON.stringify(label)});
        if (!b) return false;
        b.click();
        return true;
      })()
    `)

  let opened = false
  for (let i = 0; i < 40 && !opened; i++) {
    opened = await evaluate(`!!document.querySelector('.page-slot[data-page="1"]')`)
    if (!opened) await sleep(400)
  }
  check('阅读器打开了样本（拖不进文件的话后面都不用谈）', opened)

  const box = JSON.parse(
    await evaluate(`
      (() => {
        const s = document.querySelector('.page-slot[data-page="1"]');
        if (!s) return JSON.stringify(null);
        const r = s.getBoundingClientRect();
        return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height });
      })()
    `),
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

  check('切到「手写」工具', await toolbarBtn('手写'))
  await sleep(250)
  const cx = box.x + box.w / 2
  const cy = box.y + Math.min(box.h * 0.4, 380)
  await mouseAt('mousePressed', cx - 80, cy, 1)
  for (let i = 1; i <= 12; i++) {
    await mouseAt('mouseMoved', cx - 80 + i * 13, cy + Math.sin(i / 2) * 18, 1)
    await sleep(12)
  }
  await mouseAt('mouseReleased', cx + 76, cy, 0)
  await sleep(400)

  const count = await evaluate(
    `Number(document.querySelector('.toolbar .badge')?.textContent.trim() ?? 0)`,
  )
  check('画完之后批注计数 = 1', count === 1, `count=${count}`)
  await shot('02-app-after-draw')

  check('点「保存批注」', await toolbarBtn('保存批注'))

  let dl = []
  for (let i = 0; i < 60; i++) {
    await sleep(300)
    dl = (await readdir(DL).catch(() => [])).filter((f) => !f.endsWith('.crdownload'))
    if (dl.length) break
  }
  check('浏览器真的下载出了文件', dl.length > 0, dl.join(', '))

  if (dl.length) {
    const bytes = await readFile(join(DL, dl[0]))
    const head = bytes.subarray(0, 1024).toString('latin1')
    check(`文件名是「${'annot-fixture(已批注).pdf'}」`, /已批注/.test(dl[0]), dl[0])
    check('下载内容是 PDF（%PDF 头）', head.startsWith('%PDF-'))
    check(
      '文件里能找到我们的作者名与 /NM 前缀（写进去了）',
      bytes.includes(Buffer.from('edge-pdf-lite')) && bytes.includes(Buffer.from('epl:')),
    )
    check(
      '体积比原文件大（批注是追加的，不是重写）',
      bytes.length > 15000,
      `${(bytes.length / 1024).toFixed(1)} KB`,
    )
    await writeFile(join(SHOTS, '03-downloaded.pdf'), bytes)
  }

  console.log('\n[5] 控制台')
  check('没有未捕获异常 / error', consoleErrs.length === 0, consoleErrs.slice(0, 3).join(' | '))
} catch (e) {
  console.error(`\n执行失败：${e.message}`)
  failed++
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

console.log(`\n========== 结果：${passed} 通过 / ${failed} 失败 ==========`)
process.exit(failed > 0 ? 1 : 0)
