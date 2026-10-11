/**
 * 批注样本自检（M0 实验二 + 三 的自动化部分）。
 *
 * 打开 annot-check.html，点「跑自动自检」，读回结构化结果并断言：
 *   · 注释条数与类型是否正确（我们手工构造的字典能不能被 pdf.js 解析）
 *   · 每条注释的 id 是否等于 /NM 且带 epl: 前缀（M6「只擦自己的」判据）
 *   · 有 /AP 的注释是否真的只有该有的那几条
 *   · 渲染对照（DISABLE vs ENABLE 采样）是否全部命中 —— 证明 /AP 真的被画出来了
 *
 * ⚠️ 这个脚本只能证明「pdf.js 侧没问题」。
 * Edge / Acrobat 能不能显示，必须人工拿样本去核对（见 annot-check.html 下半部分）。
 *
 * 用法：node scripts/test-annot.mjs [url]
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = resolve(ROOT, 'annot-shots')
await mkdir(SHOTS, { recursive: true })

const TARGET = process.argv[2] ?? 'http://localhost:4173/annot-check.html'
const PORT = Number(process.env.EPL_PORT ?? 9601)

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
const userDataDir = await mkdtemp(join(tmpdir(), 'epl-annot-'))
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
      '--window-size=1280,1000',
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
  if (!hasBtn) throw new Error('annot-check.html 没加载出来（#runCheck 不存在）')

  console.log('\n[1] 触发自检')
  await evaluate(`document.getElementById('runCheck').click(); 'clicked'`)

  let result = null
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    const status = await evaluate(`document.getElementById('status').textContent`)
    if (status.startsWith('自检') || status.startsWith('出错')) {
      result = JSON.parse(await evaluate(`JSON.stringify(window.__annotCheck ?? null)`))
      break
    }
    await sleep(500)
  }

  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    await writeFile(join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'))
  }
  await shot('01-annot-check')

  if (!result) {
    check('自检跑出结果', false, '超时或页面报错')
    throw new Error('没有拿到结构化结果')
  }

  // ---------------------------------------------------------------- 断言
  console.log('\n[2] 结构自检')
  const rows = result.rows ?? []
  console.log(
    `     共 ${rows.length} 条注释：` +
      rows.map((r) => `P${r.page}/${r.subtype}`).join('  '),
  )

  const byType = {}
  for (const r of rows) byType[r.subtype] = (byType[r.subtype] ?? 0) + 1

  check('注释总数 = 9', rows.length === 9, `实际 ${rows.length}`)
  check('Highlight × 4', byType.Highlight === 4, `实际 ${byType.Highlight ?? 0}`)
  check('Ink × 1', byType.Ink === 1, `实际 ${byType.Ink ?? 0}`)
  check('FreeText × 1', byType.FreeText === 1, `实际 ${byType.FreeText ?? 0}`)
  check('Square × 1', byType.Square === 1, `实际 ${byType.Square ?? 0}`)
  check('StrikeOut × 1', byType.StrikeOut === 1, `实际 ${byType.StrikeOut ?? 0}`)
  check('Underline × 1', byType.Underline === 1, `实际 ${byType.Underline ?? 0}`)

  const notOurs = rows.filter((r) => !r.isOurs)
  check(
    '每条注释的 /T 作者名都是 edge-pdf-lite（「只擦自己的」判据）',
    notOurs.length === 0,
    notOurs.length ? notOurs.map((r) => `P${r.page}:${r.author || '(空)'}`).join(' ') : '',
  )

  const emptyContents = rows.filter((r) => !r.contents)
  check(
    '每条注释的 /Contents 都读得出来（字符串没被写成 PDFName）',
    emptyContents.length === 0,
    emptyContents.length ? emptyContents.map((r) => `P${r.page}`).join(' ') : '',
  )

  // P2 / P3 是刻意不带 /AP 的对照组
  const noAp = rows.filter((r) => !r.hasAP).map((r) => `P${r.page}`)
  check(
    '只有 P2 / P3 没有 /AP（对照组的预期）',
    noAp.sort().join(',') === 'P2,P3',
    `实际无 /AP 的页：${noAp.join(',') || '无'}`,
  )

  // ---------------------------------------------------------------- 渲染对照
  console.log('\n[3] 渲染对照（/AP 是否真的被画出来）')
  const renderChecks = result.renderChecks ?? []
  for (const rc of renderChecks) {
    console.log(`     ${rc.title}`)
    console.log(`       DISABLE 目标色 ${rc.offHit} px   |   ENABLE 目标色 ${rc.onHit} px`)
  }
  // 位图存盘，便于事后核对（截图缩略图看不清）
  for (const [i, rc] of renderChecks.entries()) {
    for (const [k, durl] of [
      ['off', rc.off],
      ['on', rc.on],
    ]) {
      const b64 = String(durl).split(',')[1]
      if (b64) await writeFile(join(SHOTS, `0${i + 1}-${k}.jpg`), Buffer.from(b64, 'base64'))
    }
  }
  check(
    `DISABLE 无该颜色 / ENABLE 有该颜色：${result.passed}/${result.total} 命中`,
    result.passed === result.total,
    `${result.passed}/${result.total}`,
  )

  // ---------------------------------------------------------------- 诊断
  console.log('\n[3b] 诊断：注释去了哪一层')
  const d = result.diag ?? {}
  console.log(`     算子列表长度：DISABLE ${d.offOps}  →  ENABLE ${d.onOps}`)
  console.log(`     separateAnnots：DISABLE ${JSON.stringify(d.offSeparate)}  →  ENABLE ${JSON.stringify(d.onSeparate)}`)

  // ---------------------------------------------------------------- 控制台
  console.log('\n[4] 控制台')
  check('没有未捕获异常 / error', consoleErrs.length === 0, consoleErrs.slice(0, 3).join(' | '))

  console.log(`\n截图：${join(SHOTS, '01-annot-check.png')}`)
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
