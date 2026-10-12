/**
 * CSP（内容安全策略）回归验证。
 *
 * 为什么需要这个测试：
 *   `tauri.conf.json` 里的 `csp` 一旦设错，表现**不是报错**，而是"某个功能悄悄没了"
 *   —— worker 被拦 → pdf.js **静默退回主线程**（页面照常显示，只是卡）；
 *     `connect-src` 少了 IPC 源 → 所有 Tauri 命令失败（文件列表/保存全废）；
 *     `style-src` 少了该有的源 → 界面错位但控制台才看得见。
 *   所以必须**主动监听 `securitypolicyviolation`**，不能等它自己报。
 *
 * 这个测试做两件事：
 *   1. **策略本身有没有被放宽**（牙齿）：`style-src`/`script-src` 不许有 `unsafe-inline`、
 *      `object-src` 必须是 'none'、`connect-src` 必须含 IPC 源 …… 把策略改回宽松会让它变红。
 *   2. **在这套策略下应用还能不能用**：把真实配置里的 CSP 作为**响应头**喂给
 *      `dist/`（比 meta 更接近 Tauri 的行为：Tauri 就是在自定义协议上加这个头），
 *      然后完整走一遍会碰到各类源的流程，断言 **0 违规**。
 *
 * ⚠️ 判据必须有牙：只断言"0 违规"是不够的 —— 页面整个白屏时违规数也是 0。
 *    所以同时断言"真的渲染出了画布""真的下载到了 PDF"（内容确实画上去了）。
 *
 * 用法：node scripts/test-csp.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TID } from './testids.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const CONF = join(ROOT, 'src-tauri', 'tauri.conf.json')
const PDF = join(ROOT, 'public', 'testdata', 'real-1706.03762.pdf')
const PORT = Number(process.env.EPL_CSP_PORT ?? 9611)

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p))

if (!EDGE) {
  console.error('找不到浏览器')
  process.exit(1)
}
for (const [p, hint] of [
  [DIST, '先跑一次：npm run build'],
  [PDF, '先跑一次：npm run testdata:real（这份真实论文语料不入库）'],
]) {
  if (!existsSync(p)) {
    console.error(`找不到 ${p}\n${hint}`)
    process.exit(1)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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

// ------------------------------------------------------------------ 1. 读策略

const conf = JSON.parse(await readFile(CONF, 'utf8'))
const csp = conf?.app?.security?.csp
const devCsp = conf?.app?.security?.devCsp

/** 把策略对象拼成响应头用的字符串 */
function cspToHeader(policy) {
  return Object.entries(policy)
    .map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(' ') : v}`)
    .join('; ')
}

console.log('\n[1] 策略本身（防被改回宽松）')
check('csp 已设置（不是 null）', csp && typeof csp === 'object')
check('同时设置了 devCsp（不破坏 npm run tauri dev）', !!devCsp)

const d = (name) => String(csp?.[name] ?? '')
check('default-src 锁到 self', d('default-src') === "'self'", d('default-src'))
check(
  'script-src 无 unsafe-inline / unsafe-eval',
  !!d('script-src') && !/unsafe-inline|unsafe-eval/.test(d('script-src')),
  d('script-src'),
)
check(
  'style-src 无 unsafe-inline（这正是把内联样式挪走的理由）',
  !!d('style-src') && !/unsafe-inline/.test(d('style-src')),
  d('style-src'),
)
check('worker-src 显式声明且不含通配', !!d('worker-src') && !/\*/.test(d('worker-src')), d('worker-src'))
check('object-src 为 none', d('object-src') === "'none'", d('object-src'))
check('base-uri 为 none', d('base-uri') === "'none'", d('base-uri'))
check('form-action 为 none', d('form-action') === "'none'", d('form-action'))
check('frame-ancestors 为 none', d('frame-ancestors') === "'none'", d('frame-ancestors'))
check(
  'connect-src 含 IPC 源（少了这个 Tauri 命令全废）',
  /(^|\s)ipc:(\s|$)/.test(d('connect-src')) && d('connect-src').includes('http://ipc.localhost'),
  d('connect-src'),
)
check(
  '没有任何指令用裸通配 *',
  !Object.values(csp ?? {}).some((v) => /(^|\s)\*(\s|$)/.test(String(v))),
)

// 内联 style 属性是这条策略的"隐形地雷"：它归 style-src-attr 管，
// 出现一处就得给整站开 'unsafe-inline'。历史上 index.html 里就有一处。
const htmlSrc = await readFile(join(ROOT, 'index.html'), 'utf8')
check(
  'index.html 里没有内联 style 属性',
  !/\sstyle\s*=/.test(htmlSrc.replace(/<!--[\s\S]*?-->/g, '')),
)

const HEADER = cspToHeader(csp)
console.log(`\n  策略：${HEADER}\n`)

// ------------------------------------------------------------------ 2. 带 CSP 的静态服务

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.pdf': 'application/pdf',
}

/** 防目录穿越 */
function safeJoin(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0])
  const target = normalize(join(DIST, decoded))
  if (target !== DIST && !target.startsWith(DIST + sep)) return null
  return target
}

let server = null
try {
  server = createServer(async (req, res) => {
    const filePath = safeJoin(req.url ?? '/')
    if (!filePath) {
      res.writeHead(403).end('Forbidden')
      return
    }
    try {
      let target = filePath
      let s = await stat(target)
      if (s.isDirectory()) {
        target = join(target, 'index.html')
        s = await stat(target)
      }
      res.writeHead(200, {
        'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': s.size,
        'Cache-Control': 'no-cache',
        // ★ 被测的那一行：把真实配置里的策略作为响应头发下去
        //   （Tauri 在自定义协议上也是加响应头，不是塞 meta）
        'Content-Security-Policy': HEADER,
      })
      createReadStream(target).pipe(res)
    } catch {
      // 资源缺失老实 404，别回落 index.html（那会掩盖成 MIME 问题）
      const looksLikeAsset = /\.[a-z0-9]+$/i.test(filePath)
      const wantsHtml = String(req.headers.accept ?? '').includes('text/html')
      if (!looksLikeAsset && wantsHtml) {
        const fb = join(DIST, 'index.html')
        const s = await stat(fb)
        res.writeHead(200, {
          'Content-Type': MIME['.html'],
          'Content-Length': s.size,
          'Content-Security-Policy': HEADER,
        })
        createReadStream(fb).pipe(res)
        return
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404\n')
    }
  })
  await new Promise((res) => server.listen(PORT, '127.0.0.1', res))

  // ---------------------------------------------------------------- 3. 驱动

  const userDataDir = await mkdtemp(join(tmpdir(), 'epl-csp-'))
  const DL = await mkdtemp(join(tmpdir(), 'epl-csp-dl-'))
  let child
  let ws

  try {
    child = spawn(
      EDGE,
      [
        '--headless=new',
        `--remote-debugging-port=${PORT + 1}`,
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--window-size=1280,900',
        'about:blank',
      ],
      { stdio: 'ignore' },
    )

    let wsUrl = null
    for (let i = 0; i < 80 && !wsUrl; i++) {
      await sleep(250)
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT + 1}/json/list`)).json()
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
    const consoleErrors = []
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id !== undefined && pending.has(m.id)) {
        const { resolve: res, reject } = pending.get(m.id)
        pending.delete(m.id)
        m.error ? reject(new Error(JSON.stringify(m.error))) : res(m.result)
        return
      }
      if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
        const text = (m.params.args ?? [])
          .map((a) => a.value ?? a.description ?? '')
          .join(' ')
          .slice(0, 400)
        // Vue 的 dev 警告之类不算，只关心疑似被拦的东西
        if (/Content Security Policy|Refused to|violates the following/i.test(text)) {
          consoleErrors.push(text)
        }
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const t = m.params.exceptionDetails?.exception?.description ?? ''
        if (/Content Security Policy|Refused to|violates the following/i.test(t)) {
          consoleErrors.push('EXCEPTION: ' + t.slice(0, 400))
        }
      }
    })
    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const n = ++id
        pending.set(n, { resolve: res, reject: rej })
        ws.send(JSON.stringify({ id: n, method, params }))
      })
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
      }
      return r.result?.value
    }

    await send('Runtime.enable')
    await send('Page.enable')
    await send('DOM.enable')

    // 必须在**任何页面脚本之前**装上监听，否则会漏掉首屏那些违规
    // （首屏恰恰是最容易踩 style-src / script-src 的时机）
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__cspViolations = [];
        document.addEventListener('securitypolicyviolation', (e) => {
          window.__cspViolations.push({
            directive: e.effectiveDirective,
            blocked: e.blockedURI,
            sample: (e.sample || '').slice(0, 200),
          });
        });
      `,
    })

    const violations = async () => JSON.parse(await evaluate('JSON.stringify(window.__cspViolations)'))

    /**
     * 点带 `data-tid` 的控件。
     * ⚠️ 必须传 **TID 的值**（短横线风格，如 `side-thumbs`），不是键名 ——
     *    DOM 上写的是值；用键名会静默找不到（返回 false），看起来像"功能坏了"。
     */
    const clickTid = (tid) => evaluate(`(() => {
      const b = document.querySelector('[data-tid=${JSON.stringify(tid)}]');
      if (!b) return false;
      b.click();
      return true;
    })()`)

    const URL_TARGET = `http://127.0.0.1:${PORT}/`
    console.log(`\n[2] 在真实策略下跑一遍应用（${URL_TARGET}）`)
    await send('Page.navigate', { url: URL_TARGET })
    await sleep(2500)

    check('页面挂载了（#app 有内容）', await evaluate(`document.querySelector('#app').children.length > 0`))

    // 内联样式挪走之后，sprite 得靠 CSS 隐藏 —— 顺手确认真生效
    check(
      'sprite 仍被隐藏（.icon-sprite → display:none）',
      (await evaluate(
        `getComputedStyle(document.querySelector('.icon-sprite')).display`,
      )) === 'none',
    )
    check(
      '样式表生效（背景色来自 base.css 变量）',
      (await evaluate(`getComputedStyle(document.body).backgroundColor`)) !== 'rgba(0, 0, 0, 0)',
    )

    // ---- 打开 PDF：覆盖 worker / 字体 data: / cmap / 图像
    const { root } = await send('DOM.getDocument', { depth: -1 })
    const { nodeId } = await send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: 'input[type=file]',
    })
    if (!nodeId) throw new Error('找不到 file input')
    await send('DOM.setFileInputFiles', { files: [PDF], nodeId })

    let canvases = 0
    for (let i = 0; i < 120; i++) {
      await sleep(500)
      canvases = await evaluate(`document.querySelectorAll('.pdf-page-canvas').length`)
      const loading = await evaluate(`!!document.querySelector('.loading')`)
      if (!loading && canvases > 0) break
    }
    // ★ 这条是"0 违规"不假绿的前提：内容必须真的画上去了
    check('PDF 渲染出画布（worker / 字体 / cmap 都没被拦）', canvases > 0, `${canvases} 张`)
    const painted = await evaluate(`(() => {
      const c = document.querySelector('canvas.pdf-page-canvas');
      if (!c) return -1;
      const g = c.getContext('2d');
      const d = g.getImageData(0, 0, c.width, Math.min(200, c.height)).data;
      let nonWhite = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] < 240 || d[i+1] < 240 || d[i+2] < 240) nonWhite++;
      }
      return Math.round(nonWhite / (d.length / 4) * 100);
    })()`)
    check('画布上确实有内容（不是空白）', painted > 0, `非白像素 ${painted}%`)

    // ---- 缩放：触发重渲染与新一层字体
    await clickTid(TID.zoomIn)
    await sleep(1200)

    // ---- 画一条高亮：这是 `script-src` 最关键的考点。
    //      没有批注时点保存会**直接返回**（"还没有批注"），writer 的动态 import
    //      根本不会发生 —— 那样后面那条"另存成功"就是假绿。
    await clickTid(TID.toolHighlight)
    await sleep(400)
    const drag = await evaluate(`(() => {
      const vp = document.querySelector('.viewport').getBoundingClientRect();
      // ⚠️ 必须挑**当前视口内**的 span：视口外的取不到坐标（这条踩过）
      const cand = [...document.querySelectorAll('.text-layer span')]
        .map(s => s.getBoundingClientRect())
        .filter(b => b.width > 40 && b.top > vp.top + 30 && b.bottom < vp.bottom - 30);
      if (!cand.length) return null;
      const b = cand[Math.floor(cand.length * 0.3)];
      return { x1: b.left + 2, x2: b.right - 2, y: b.top + b.height / 2 };
    })()`)
    if (drag) {
      const mouse = (type, x, y, buttons) =>
        send('Input.dispatchMouseEvent', {
          type,
          x,
          y,
          button: 'left',
          buttons,
          clickCount: 1,
        })
      await mouse('mouseMoved', drag.x1, drag.y, 0)
      await mouse('mousePressed', drag.x1, drag.y, 1)
      for (let i = 1; i <= 8; i++) {
        await mouse('mouseMoved', drag.x1 + ((drag.x2 - drag.x1) * i) / 8, drag.y, 1)
        await sleep(15)
      }
      await mouse('mouseReleased', drag.x2, drag.y, 0)
      await sleep(500)
    }
    const annotCount = Number(
      await evaluate(`Number(document.querySelector('[data-tid="annot-count"]')?.textContent.trim() ?? 0)`),
    )
    check('画出了一条批注（后面"另存"才有意义）', annotCount > 0, `count=${annotCount}`)

    // ---- 双页：重算版面
    await clickTid(TID.modeDual)
    await sleep(1600)
    check(
      '切到双页后仍有两张以上画布',
      (await evaluate(`document.querySelectorAll('.pdf-page-canvas').length`)) >= 2,
    )

    // ---- 缩略图（一堆 canvas）/ 目录 / 搜索（文本层）
    //      ⚠️ 正确选择器是 `.thumb-panel canvas[data-page]`，不是 `.thumb canvas`
    await clickTid(TID.sideThumbs)
    let thumbs = 0
    for (let i = 0; i < 20; i++) {
      await sleep(400)
      thumbs = await evaluate(`document.querySelectorAll('.thumb-panel canvas[data-page]').length`)
      if (thumbs > 0) break
    }
    await clickTid(TID.sideOutline)
    await sleep(1200)
    const outlineOk = await evaluate(
      `!!document.querySelector('.outline-panel, .outline, .tree, .empty')`,
    )
    await clickTid(TID.sideSearch)
    await sleep(1200)
    const searchOk = await evaluate(`!!document.querySelector('.side-panel input, .search input, input')`)
    check(
      '缩略图 / 目录 / 搜索 三个面板都建起来了',
      thumbs > 0 && outlineOk && searchOk,
      `缩略图 ${thumbs} 张`,
    )
    await clickTid(TID.sideFile)
    await sleep(400)

    // ---- 另存：触发 writer 的**动态 import**（script-src 的真实考点）+ blob 下载
    await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL })
    await clickTid(TID.save)
    let downloaded = null
    for (let i = 0; i < 60; i++) {
      await sleep(500)
      const files = (await readdir(DL).catch(() => [])).filter((f) => !f.endsWith('.crdownload'))
      if (files.length) {
        downloaded = files[0]
        break
      }
    }
    check('另存成功落盘（writer 的动态 import 没被 script-src 拦）', !!downloaded, downloaded ?? '')
    if (downloaded) {
      const head = (await readFile(join(DL, downloaded))).subarray(0, 8).toString('latin1')
      check('下载内容确实是 PDF', head.startsWith('%PDF-'), head)
    }

    // ---- 汇总
    const vs = await violations()
    const grouped = new Map()
    for (const v of vs) {
      const k = `${v.directive} ← ${v.blocked}`
      grouped.set(k, (grouped.get(k) ?? 0) + 1)
    }
    if (grouped.size) {
      console.log('\n  被拦下的请求：')
      for (const [k, n] of grouped) console.log(`    × ${n}  ${k}`)
    }
    check('全程 0 次 CSP 违规', vs.length === 0, `${vs.length} 次`)
    check('控制台没有 CSP 拦截报错', consoleErrors.length === 0, consoleErrors[0] ?? '')
  } finally {
    try {
      ws?.close()
    } catch {
      /* ignore */
    }
    child?.kill()
    await sleep(400)
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
    await rm(DL, { recursive: true, force: true }).catch(() => {})
  }
} finally {
  server?.close()
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败项'}：${passed} 通过 / ${failed} 失败\n`)
process.exit(failed === 0 ? 0 : 1)
