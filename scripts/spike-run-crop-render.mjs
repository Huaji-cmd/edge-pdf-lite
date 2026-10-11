/**
 * 用 CDP 驱动本机 Edge 无头跑 M0 裁剪渲染实验，拿到真实数字。
 * 零依赖：Node 22 自带全局 WebSocket。
 *
 * 用法：node scripts/spike-run-crop-render.mjs [url]
 */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = resolve(ROOT, 'spike-out')
await mkdir(OUT_DIR, { recursive: true })

// 默认打生产包（静态服务器），而不是开发服务器 ——
// 开发服务器带 HMR、代码未压缩，性能数字不可比。
const TARGET_URL = process.argv[2] ?? 'http://localhost:4173/spike.html'
const PORT = Number(process.env.EPL_PORT ?? 9333)
// 用 --disable-gpu 强制软件光栅化，模拟没有可用 GPU 的低配机。
// 这是"这台开发机的结果能不能代表那台低配机"的关键开关。
const NO_GPU = process.env.EPL_NO_GPU === '1'
const LABEL = NO_GPU ? '软件光栅化（模拟低配机）' : '默认（GPU 加速）'
// 在页面脚本执行前删掉 pdf.js 依赖的 ES2025 API，模拟"浏览器版本偏旧"的目标机
const OLD_BROWSER = process.env.EPL_OLD_BROWSER === '1'

const STRIP_MODERN_APIS = `
  for (const [obj, name] of [
    [Uint8Array.prototype, 'toHex'],
    [Uint8Array.prototype, 'toBase64'],
    [Uint8Array.prototype, 'setFromBase64'],
    [Uint8Array, 'fromHex'],
    [Uint8Array, 'fromBase64'],
    [Math, 'sumPrecise'],
    [Promise, 'try'],
    [Promise, 'withResolvers'],
  ]) {
    try { delete obj[name] } catch {}
  }
  globalThis.__strippedApis = {
    toHex: typeof Uint8Array.prototype.toHex,
    PromiseTry: typeof Promise.try,
    withResolvers: typeof Promise.withResolvers,
    sumPrecise: typeof Math.sumPrecise,
  };
`

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

const browserPath = EDGE_CANDIDATES.find((p) => existsSync(p))
if (!browserPath) {
  console.error('找不到 Edge/Chrome，无法跑自动化验证')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForDevtools(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (res.ok) return await res.json()
    } catch {
      /* 还没起来 */
    }
    await sleep(250)
  }
  throw new Error('DevTools 端点没起来')
}

async function pickPageTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  const list = await res.json()
  const page = list.find((t) => t.type === 'page')
  if (!page?.webSocketDebuggerUrl) throw new Error('找不到 page target')
  return page.webSocketDebuggerUrl
}

/** 极简 CDP 客户端 */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let nextId = 0
  const pending = new Map()
  const consoleLogs = []

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      return
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args ?? [])
        .map((a) => a.value ?? a.description ?? '')
        .join(' ')
      consoleLogs.push({ level: msg.params.type, text })
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleLogs.push({
        level: 'exception',
        text: msg.params.exceptionDetails?.exception?.description ?? 'unknown',
      })
    }
  })

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')))
  })

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })

  return { ws, ready, send, consoleLogs }
}

const userDataDir = await mkdtemp(join(tmpdir(), 'epl-spike-'))
let child
let client

try {
  child = spawn(
    browserPath,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=1280,900',
      ...(NO_GPU ? ['--disable-gpu', '--disable-gpu-compositing'] : []),
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  console.log(`光栅化模式：${LABEL}`)

  await waitForDevtools()
  const wsUrl = await pickPageTarget()
  client = connect(wsUrl)
  await client.ready
  await client.send('Runtime.enable')
  await client.send('Page.enable')

  if (OLD_BROWSER) {
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: STRIP_MODERN_APIS })
    console.log('模式：模拟旧浏览器（已在页面加载前删除 ES2025 API）')
  }

  console.log(`→ 打开 ${TARGET_URL}`)
  await client.send('Page.navigate', { url: TARGET_URL })
  await sleep(2500) // 等 Vite 编译 + 模块加载

  const evaluate = async (expression, awaitPromise = false) => {
    const r = await client.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    })
    if (r.exceptionDetails) {
      throw new Error(
        `页面内异常：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`,
      )
    }
    return r.result?.value
  }

  /** 像用户那样真的选一个本地文件（file input 的 value 无法用 JS 直接设） */
  const setLocalFile = async (absPath) => {
    const { root } = await client.send('DOM.getDocument', { depth: -1 })
    const { nodeId } = await client.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '#file',
    })
    if (!nodeId) throw new Error('找不到 #file')
    await client.send('DOM.setFileInputFiles', { files: [absPath], nodeId })
  }

  const ready = await evaluate(`!!document.getElementById('sample')`)
  if (!ready) throw new Error('spike 页面没加载出来（#sample 不存在）')

  if (OLD_BROWSER) {
    const stripped = await evaluate(`JSON.stringify(globalThis.__strippedApis ?? null)`)
    console.log(`确认已删除: ${stripped}`)
  }

  const envRaw = await evaluate(`JSON.stringify(globalThis.__spikeEnv ?? null)`)
  if (envRaw) {
    const env = JSON.parse(envRaw)
    console.log('--- 环境信息 ---')
    for (const [k, v] of Object.entries(env)) console.log(`  ${k}: ${v}`)
  } else {
    console.log('（环境面板还没渲染出来，#env 可能不存在）')
  }

  const cases = [
    { label: '内建样本 · 文字页 × 1.5', sample: '/testdata/sample-text-20p.pdf', page: 1, scale: 1.5 },
    { label: '本地文件 · 真实论文', file: 'public/testdata/real-1706.03762.pdf', page: 1, scale: 1.5 },
  ]

  const results = []

  for (const c of cases) {
    console.log(`\n=== ${c.label} ===`)
    const before = client.consoleLogs.length

    await evaluate(`window.__spikeError = null`)

    if (c.file) {
      // 先清掉内建样本，再像用户那样真的选本地文件
      await evaluate(`document.getElementById('sample').value = ''`)
      await setLocalFile(resolve(ROOT, c.file))
    } else {
      await evaluate(`
        document.getElementById('file').value = '';
        document.getElementById('sample').value = ${JSON.stringify(c.sample)};
      `)
    }

    await evaluate(`
      document.getElementById('page').value = ${c.page};
      document.getElementById('scale').value = ${c.scale};
      document.getElementById('maxScale').value = 8;
      document.getElementById('runs').value = 5;
      document.getElementById('run').click();
      'started'
    `)

    // 轮询状态
    const deadline = Date.now() + 240000
    let status = ''
    let report = ''
    let sweep = ''
    while (Date.now() < deadline) {
      status = await evaluate(`document.getElementById('status').textContent`)
      if (status.startsWith('完成') || status.startsWith('出错')) {
        report = await evaluate(`document.getElementById('report').innerText`)
        sweep = await evaluate(`document.getElementById('sweep').innerText`)
        break
      }
      await sleep(600)
    }

    const newLogs = client.consoleLogs.slice(before).filter((l) => l.level !== 'log')
    let parsed = null
    let spikeError = null
    try {
      parsed = JSON.parse(await evaluate(`JSON.stringify(window.__spikeResult ?? null)`))
      spikeError = JSON.parse(await evaluate(`JSON.stringify(window.__spikeError ?? null)`))
    } catch {
      /* ignore */
    }
    results.push({ label: c.label, status, report, sweep, logs: newLogs, parsed, spikeError })

    console.log(`状态: ${status || '（超时）'}`)
    if (spikeError) {
      console.log(`❗ 页面异常: ${spikeError.name}: ${spikeError.message}`)
      console.log(
        (spikeError.stack ?? '')
          .split('\n')
          .slice(0, 8)
          .map((l) => `   ${l.trim()}`)
          .join('\n'),
      )
    }
    if (sweep) console.log(sweep)

    const bad = newLogs.filter((l) => l.level === 'error' || l.level === 'exception')
    if (bad.length) {
      console.log('--- 页面 console 报错 ---')
      for (const l of bad) console.log(`[${l.level}] ${l.text.slice(0, 800)}`)
    }
  }

  console.log('\n\n========== 汇总 ==========')
  for (const r of results) {
    const p = r.parsed
    console.log(`\n【${r.label}】${r.status}`)
    if (!p) {
      console.log('  （没拿到结构化结果）')
      continue
    }
    console.log(
      `  Q1 坐标对齐: 最优 ${JSON.stringify(p.best)}  原位误差 ${p.mean.toFixed(3)}  对齐正确=${p.aligned}`,
    )
    console.log(
      `  Q2 清晰度: 整页 深${(p.toneFull.dark * 100).toFixed(2)}%/中${(p.toneFull.mid * 100).toFixed(2)}%  ` +
        `裁剪 深${(p.toneCrop.dark * 100).toFixed(2)}%/中${(p.toneCrop.mid * 100).toFixed(2)}%`,
    )
    console.log(`  Q3 平均提速: ${Number.isNaN(p.avgSpeedup) ? '—' : p.avgSpeedup.toFixed(2) + '×'}`)
    console.log(
      `  本环境补齐的 Polyfill: ${p.polyfills?.length ? p.polyfills.join(', ') : '无（浏览器较新）'}`,
    )
    for (const row of p.rows ?? []) {
      const disp = `${row.fullMsDisp.toFixed(1)}ms/${row.cropMsDisp.toFixed(1)}ms`
      const print = `${row.fullMsPrint.toFixed(1)}ms/${row.cropMsPrint.toFixed(1)}ms`
      const sp = `${row.speedupPrint.toFixed(2)}×`
      console.log(
        `     scale=${String(row.scale).padEnd(5)}` +
          ` 整页 ${String(row.fullMP.toFixed(1)).padStart(5)}MP (${row.fullActual})` +
          `  内容 ${(row.contentFull * 100).toFixed(1)}%` +
          `  | display 整页/裁剪 ${disp.padStart(16)}` +
          `  | print 整页/裁剪 ${print.padStart(16)}` +
          `  | 提速 ${sp.padStart(6)}` +
          `  | 堆 ${row.heapMB === null ? '—' : row.heapMB.toFixed(0) + 'MB'}`,
      )
    }
  }

  // ================= Q4 滚动体感（帧率） =================
  console.log('\n\n########## Q4 滚动体感（帧率）##########')

  const scrollCases = [
    {
      label: '合成文字页 scale=2',
      sample: '/testdata/sample-text-20p.pdf',
      start: 3,
      pages: 8,
      scale: 2,
      seconds: 6,
    },
    {
      label: '真实论文 scale=2',
      sample: '/testdata/real-1706.03762.pdf',
      start: 3,
      pages: 8,
      scale: 2,
      seconds: 6,
    },
  ]

  for (const c of scrollCases) {
    console.log(`\n=== ${c.label} ===`)
    const before = client.consoleLogs.length

    await evaluate(`
      document.getElementById('file').value = '';
      document.getElementById('sample').value = ${JSON.stringify(c.sample)};
      document.getElementById('scrollStart').value = ${c.start};
      document.getElementById('scrollPages').value = ${c.pages};
      document.getElementById('scrollScale').value = ${c.scale};
      document.getElementById('scrollSeconds').value = ${c.seconds};
      document.getElementById('runScroll').click();
      'started'
    `)

    const deadline = Date.now() + 180000
    let status = ''
    while (Date.now() < deadline) {
      status = await evaluate(`document.getElementById('scrollStatus').textContent`)
      if (status.startsWith('滚动') || status.startsWith('出错')) break
      await sleep(500)
    }

    let res = null
    try {
      res = JSON.parse(await evaluate(`JSON.stringify(window.__scrollResult ?? null)`))
    } catch {
      /* ignore */
    }

    console.log(`状态: ${status || '（超时）'}`)
    if (res) {
      console.log(
        `  滚动=${res.scrollVerdict}  p50=${res.p50.toFixed(1)}ms (${(1000 / res.p50).toFixed(0)}fps)  ` +
          `p95=${res.p95.toFixed(1)}ms  最长=${res.maxFrame.toFixed(1)}ms  掉帧(>33/>50)=${res.janky}/${res.bad}`,
      )
      console.log(
        `  新页出现=${res.popVerdict}  平均单页 ${res.avgRender.toFixed(0)}ms  渲染${res.renderedPages}页`,
      )
      console.log(`  诊断: ${res.diagnosis}`)
    } else {
      console.log('  （没拿到结构化结果）')
    }

    const bad = client.consoleLogs
      .slice(before)
      .filter((l) => l.level === 'error' || l.level === 'exception')
    if (bad.length) {
      console.log('--- 页面报错 ---')
      for (const l of bad) console.log(`[${l.level}] ${l.text.slice(0, 400)}`)
    }
  }
  // ================= Q5 算子分解 =================
  console.log('\n\n########## Q5 算子分解 ##########')

  const opsCases = [
    { label: '真实论文', sample: '/testdata/real-1706.03762.pdf', page: 3, scale: 1.5 },
    { label: '合成文字页', sample: '/testdata/sample-text-20p.pdf', page: 3, scale: 1.5 },
  ]

  for (const c of opsCases) {
    console.log(`\n=== ${c.label} ===`)
    const before = client.consoleLogs.length

    await evaluate(`
      document.getElementById('file').value = '';
      document.getElementById('sample').value = ${JSON.stringify(c.sample)};
      document.getElementById('page').value = ${c.page};
      document.getElementById('scale').value = ${c.scale};
      document.getElementById('runOps').click();
      'started'
    `)

    const deadline = Date.now() + 180000
    let status = ''
    while (Date.now() < deadline) {
      status = await evaluate(`document.getElementById('opsStatus').textContent`)
      if (status.startsWith('算子分解完成') || status.startsWith('出错')) break
      await sleep(500)
    }

    let res = null
    try {
      res = JSON.parse(await evaluate(`JSON.stringify(window.__opsResult ?? null)`))
    } catch {
      /* ignore */
    }

    console.log(`状态: ${status || '（超时）'}`)
    if (res) {
      console.log(
        `  算子 ${res.ops} 个（文本 ${res.textOps}，${((res.textOps / res.ops) * 100).toFixed(1)}%）` +
          `  列表构建 ${res.opListMs.toFixed(0)}ms`,
      )
      console.log(
        `  渲染 全部=${res.tAll.toFixed(0)}ms  仅文本=${res.tText.toFixed(0)}ms(${(res.textShare * 100).toFixed(0)}%)` +
          `  仅非文本=${res.tOther.toFixed(0)}ms(${(res.otherShare * 100).toFixed(0)}%)`,
      )
      console.log('  Top 算子: ' + res.top.slice(0, 8).map(([n, v]) => `${n}:${v}`).join('  '))
    } else {
      console.log('  （没拿到结构化结果）')
    }

    const bad = client.consoleLogs
      .slice(before)
      .filter((l) => l.level === 'error' || l.level === 'exception')
    if (bad.length) {
      console.log('--- 页面报错 ---')
      for (const l of bad) console.log(`[${l.level}] ${l.text.slice(0, 400)}`)
    }
  }
  // ================= Q5b 多页画像 =================
  console.log('\n\n########## Q5b 多页画像 ##########')

  const scanCases = [
    { label: '合成文字页', sample: '/testdata/sample-text-20p.pdf' },
    { label: '真实论文', sample: '/testdata/real-1706.03762.pdf' },
  ]

  for (const c of scanCases) {
    console.log(`\n=== ${c.label} ===`)
    const before = client.consoleLogs.length

    await evaluate(`
      document.getElementById('file').value = '';
      document.getElementById('sample').value = ${JSON.stringify(c.sample)};
      document.getElementById('page').value = 1;
      document.getElementById('scale').value = 1.5;
      document.getElementById('scanStart').value = 1;
      document.getElementById('scanCount').value = 8;
      document.getElementById('scanStep').value = 3;
      document.getElementById('runScan').click();
      'started'
    `)

    const deadline = Date.now() + 300000
    let status = ''
    while (Date.now() < deadline) {
      status = await evaluate(`document.getElementById('scanStatus').textContent`)
      if (status.startsWith('画像完成') || status.startsWith('出错')) break
      await sleep(700)
    }

    let res = null
    try {
      res = JSON.parse(await evaluate(`JSON.stringify(window.__scanResult ?? null)`))
    } catch {
      /* ignore */
    }

    console.log(`状态: ${status || '（超时）'}`)
    if (res) {
      for (const r of res.rows) {
        console.log(
          `    第${String(r.page).padStart(3)}页  ${String(r.mp.toFixed(1)).padStart(5)}MP` +
            `  算子${String(r.ops).padStart(5)} (文本${String(r.text).padStart(4)} 图像${String(r.image).padStart(2)} 路径${String(r.path).padStart(4)})` +
            `  列表${String(r.opListMs.toFixed(0)).padStart(5)}ms  渲染${String(r.renderMs.toFixed(0)).padStart(5)}ms  ${r.kind}`,
        )
      }
      console.log(
        `  图片页 ${res.imagePages} / 文字页 ${res.textPages}（共 ${res.rows.length}）` +
          `  图片页均 ${res.avgImagePageRender.toFixed(0)}ms  文字页均 ${res.avgTextPageRender.toFixed(0)}ms`,
      )
    } else {
      console.log('  （没拿到结构化结果）')
    }

    const bad = client.consoleLogs
      .slice(before)
      .filter((l) => l.level === 'error' || l.level === 'exception')
    if (bad.length) {
      console.log('--- 页面报错 ---')
      for (const l of bad) console.log(`[${l.level}] ${l.text.slice(0, 400)}`)
    }
  }

  // ================= Q7 重复渲染 / 缓存验证 =================
  console.log('\n\n########## Q7 重复渲染 / 缓存验证 ##########')

  const repCases = [
    { label: '真实论文 p13', sample: '/testdata/real-1706.03762.pdf', page: 13, scale: 1.5 },
    { label: '矢量密集 p3', sample: '/testdata/sample-vector-10p.pdf', page: 3, scale: 1.5 },
  ]

  for (const c of repCases) {
    console.log(`\n=== ${c.label} ===`)
    const before = client.consoleLogs.length

    await evaluate(`
      document.getElementById('file').value = '';
      document.getElementById('sample').value = ${JSON.stringify(c.sample)};
      document.getElementById('page').value = ${c.page};
      document.getElementById('scale').value = ${c.scale};
      document.getElementById('runRepeat').click();
      'started'
    `)

    const deadline = Date.now() + 240000
    let status = ''
    while (Date.now() < deadline) {
      status = await evaluate(`document.getElementById('repeatStatus').textContent`)
      if (status.startsWith('重复渲染') || status.startsWith('出错')) break
      await sleep(500)
    }

    let res = null
    try {
      res = JSON.parse(await evaluate(`JSON.stringify(window.__repeatResult ?? null)`))
    } catch {
      /* ignore */
    }

    console.log(`状态: ${status || '（超时）'}`)
    if (res) {
      console.log(
        `  getPage ${res.getPageMs.toFixed(0)}ms  opList首次 ${res.firstOpMs.toFixed(0)}ms` +
          `  再取 ${res.cachedOpMs.toFixed(0)}ms`,
      )
      console.log(`  display: ${res.displayTimes.map((v) => v.toFixed(0)).join(' / ')} ms`)
      console.log(`  print  : ${res.printTimes.map((v) => v.toFixed(0)).join(' / ')} ms`)
      console.log(
        `  display 首次 ${res.displayFirst.toFixed(0)}ms vs print 首次 ${res.printFirst.toFixed(0)}ms` +
          `  → display/print = ${(res.displayFirst / Math.max(1, res.printFirst)).toFixed(2)}×`,
      )
      console.log(
        `  后续/首次（display）= ${res.ratio.toFixed(2)}×  ${res.cached ? '✅ 有缓存' : '❌ 无缓存，每次重付费'}`,
      )
    } else {
      console.log('  （没拿到结构化结果）')
    }

    const bad = client.consoleLogs
      .slice(before)
      .filter((l) => l.level === 'error' || l.level === 'exception')
    if (bad.length) {
      console.log('--- 页面报错 ---')
      for (const l of bad) console.log(`[${l.level}] ${l.text.slice(0, 400)}`)
    }
  }

  // ================= Q6 加载选项对照 =================
  console.log('\n\n########## Q6 加载选项对照 ##########')

  const optCases = [{ label: '真实论文', sample: '/testdata/real-1706.03762.pdf', page: 3, scale: 1.5 }]

  for (const c of optCases) {
    console.log(`\n=== ${c.label} ===`)
    const before = client.consoleLogs.length

    await evaluate(`
      document.getElementById('file').value = '';
      document.getElementById('sample').value = ${JSON.stringify(c.sample)};
      document.getElementById('page').value = ${c.page};
      document.getElementById('scale').value = ${c.scale};
      document.getElementById('runLoadOpts').click();
      'started'
    `)

    const deadline = Date.now() + 240000
    let status = ''
    while (Date.now() < deadline) {
      status = await evaluate(`document.getElementById('loadOptsStatus').textContent`)
      if (status.startsWith('选项对照完成') || status.startsWith('出错')) break
      await sleep(600)
    }

    let res = null
    try {
      res = JSON.parse(await evaluate(`JSON.stringify(window.__loadOptResult ?? null)`))
    } catch {
      /* ignore */
    }

    console.log(`状态: ${status || '（超时）'}`)
    if (res) {
      const base = res.rows[0]?.renderMs ?? 0
      for (const r of res.rows) {
        if (r.error) {
          console.log(`  ${r.label.padEnd(38)} 失败: ${r.error}`)
          continue
        }
        const ratio = base > 0 ? r.renderMs / base : 1
        console.log(
          `  ${r.label.padEnd(38)} 加载 ${String(r.loadMs.toFixed(0)).padStart(5)}ms` +
            `  算子 ${String(r.ops).padStart(6)}  渲染 ${String(r.renderMs.toFixed(0)).padStart(5)}ms` +
            `  ${ratio.toFixed(2)}×`,
        )
      }
      console.log(`  最优: ${res.best}  ${res.bestRatio === null ? '' : res.bestRatio.toFixed(2) + '×'}`)
    } else {
      console.log('  （没拿到结构化结果）')
    }

    const bad = client.consoleLogs
      .slice(before)
      .filter((l) => l.level === 'error' || l.level === 'exception')
    if (bad.length) {
      console.log('--- 页面报错 ---')
      for (const l of bad) console.log(`[${l.level}] ${l.text.slice(0, 400)}`)
    }
  }
} finally {
  try {
    client?.ws.close()
  } catch {
    /* ignore */
  }
  child?.kill()
  await sleep(600)
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
}
