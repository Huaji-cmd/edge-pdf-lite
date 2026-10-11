/**
 * 验证打包后的 exe。
 *
 * **核心问题：pdf.js 的 worker 在 `tauri://` 协议下到底能不能加载。**
 *
 * 这件事不能靠推断：我们的 worker 不是标准写法 ——
 * 用的是自定义入口（先打 ES2025 polyfill 再加载 pdf.js）+ `?worker&url`，
 * 而且项目笔记里记着一个硬约束：`workerSrc` 必须是**绝对 URL**，
 * 相对根路径会被判跨域、要靠一层 blob 包装器绕过去。
 * Tauri 走 `tauri://` / `http://tauri.localhost`，跟 http 不是一回事。
 *
 * 判据是"**真的渲染出了页面**"，不是"控制台没报错" ——
 * worker 加载失败时 pdf.js 会退回主线程渲染，页面照样能显示，
 * 但会卡死 UI（这正是我们要避免的），而且控制台不一定报错。
 *
 * 做法：给 WebView2 开远程调试端口（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`），
 * 然后用 CDP 连上去，塞一个 PDF 进去，数画布。
 */
import { spawn } from 'node:child_process'
import { existsSync, renameSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clickByTidExpr } from './testids.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXE = resolve(ROOT, 'src-tauri/target/release/edge-pdf-lite.exe')
const PDF = resolve(ROOT, 'public/testdata/real-1706.03762.pdf')
const PORT = 9333

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`)
  ok ? pass++ : fail++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!existsSync(EXE)) {
  console.error(`找不到 exe：${EXE}`)
  console.error('  先跑： npm run exe')
  process.exit(1)
}
if (!existsSync(PDF)) {
  console.error(`找不到测试 PDF：${PDF}`)
  process.exit(1)
}

console.log(`exe: ${EXE}`)
console.log(`PDF: ${PDF}\n`)

/**
 * ⚠️ 启动前必须清掉 WebView2 的数据目录。
 *
 * WebView2 会**缓存 index.html**。更新应用后如果旧的那份还在缓存里，
 * 它会引用**已经不存在**的 chunk（构建产物的 hash 变了）→ 页面白屏、
 * 而且**控制台一个错都不报**（请求返回的是 SPA fallback 的 index.html）。
 * 我在这个问题上绕了好几圈，最后靠对比"exe 里嵌的文件名 vs 运行时请求的
 * 文件名"才定位到 —— 两者的 hash 根本不一样。
 *
 * 用 rename 而不是删除：删除整个目录在部分环境下会触发批量删除护栏。
 */
function clearWebViewData() {
  const base = process.env.LOCALAPPDATA
  if (!base) return
  for (const id of ['com.edge-pdf-lite.desktop', 'com.edge-pdf-lite.app']) {
    const p = join(base, id)
    if (!existsSync(p)) continue
    try {
      renameSync(p, join(tmpdir(), `epl-wv-${Date.now()}-${Math.random().toString(36).slice(2)}`))
    } catch {
      /* 清不掉就算了，只是可能影响这次测试 */
    }
  }
}
clearWebViewData()

// ---------------------------------------------------------------- 启动 exe
const proc = spawn(EXE, [], {
  stdio: 'ignore',
  env: {
    ...process.env,
    // ⚠️ 没有这个环境变量，WebView2 不会开调试端口，CDP 连不上去
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  },
})
const shutdown = () => {
  try {
    proc.kill()
  } catch {
    /* 已经退出了 */
  }
}
process.on('exit', shutdown)

// ---------------------------------------------------------------- 连 CDP
let target = null
for (let i = 0; i < 60; i++) {
  await sleep(500)
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
    const list = await r.json()
    const t = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl)
    if (t) {
      target = t
      break
    }
  } catch {
    /* 还没起来 */
  }
}
if (!target) {
  console.error(`连不上 WebView2 的调试端口（${PORT}）`)
  console.error('  exe 可能没起来，或者 WebView2 不认这个环境变量')
  shutdown()
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', () => reject(new Error('WebSocket 连不上')))
})

let id = 0
const pending = new Map()
const errors = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    return
  }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params?.exceptionDetails?.text ?? 'unknown')
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
    errors.push(String(m.params.args?.[0]?.value ?? 'console error'))
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

await send('Page.enable')
await send('Runtime.enable')
await send('DOM.enable')
await sleep(1200)

// ---------------------------------------------------------------- 1. 跑在 Tauri 里吗
console.log('\n[1] 运行环境')
const env = JSON.parse(
  await evaluate(`JSON.stringify({
    tauriInternals: typeof window.__TAURI_INTERNALS__ !== 'undefined',
    protocol: location.protocol,
    href: location.href.slice(0, 60),
  })`),
)
check('确实跑在 Tauri 里（有 __TAURI_INTERNALS__）', env.tauriInternals)
/*
 * ⚠️ 别断言「协议不是 http」—— 那是错的。
 *    Tauri v2 **在 Windows 上用的就是 `http://tauri.localhost/`**
 *    （`tauri://` 是 macOS/Linux 那套）。所以判据要看 host 是不是
 *    tauri 自己那个，而不是看协议名。
 */
check(
  '跑在 Tauri 的自定义源下（不是普通网页）',
  env.href.includes('tauri.localhost') || env.protocol === 'tauri:',
  `href=${env.href}`,
)

// ---------------------------------------------------------------- 2. 无边框 + 自绘标题栏
console.log('\n[2] 窗口外观')
const bar = JSON.parse(
  await evaluate(`(() => {
    const tb = document.querySelector('.titlebar');
    const wins = document.querySelectorAll('[data-tid^="win-"]');
    return JSON.stringify({ hasTitleBar: !!tb, winBtns: wins.length });
  })()`),
)
check('自绘标题栏存在（无边框后必须自己画）', bar.hasTitleBar)
check('窗口控制按钮渲染出来了（浏览器里是隐藏的）', bar.winBtns === 3, `按钮数=${bar.winBtns}`)

// ---------------------------------------------------------------- 3. 塞一个 PDF 进去
console.log('\n[3] 打开 PDF（决定性验证）')
const doc0 = await send('DOM.getDocument', { depth: -1 })
const q = await send('DOM.querySelector', { nodeId: doc0.root.nodeId, selector: 'input[type=file]' })
await send('DOM.setFileInputFiles', { files: [PDF], nodeId: q.nodeId })

let canvases = 0
for (let i = 0; i < 80; i++) {
  await sleep(400)
  canvases = await evaluate(`document.querySelectorAll('.pdf-page-canvas').length`)
  if (canvases > 0) break
}
check('页面真的渲染出来了（有画布）', canvases > 0, `画布数=${canvases}`)

const pages = await evaluate(`document.querySelector('[data-tid="page-input"]')?.max ?? ''`)
check('页数解析出来了', Number(pages) === 15, `numPages=${pages}`)

// 截图：数字全绿不等于看起来对，exe 的界面得自己看一眼
const SHOTS = resolve(ROOT, 'exe-shots')
await mkdir(SHOTS, { recursive: true })
const shot = await send('Page.captureScreenshot', { format: 'png' })
const shotPath = resolve(SHOTS, '01-exe-loaded.png')
await writeFile(shotPath, Buffer.from(shot.data, 'base64'))
console.log(`     截图: ${shotPath}`)

// ---------------------------------------------------------------- 4. worker 是不是真的在 worker 线程
console.log('\n[4] worker 是否真的在独立线程')
/*
 * 决定性判据：如果 worker 加载失败，pdf.js 会**退回主线程**渲染 ——
 * 页面照样能显示，所以"能显示"不等于"worker 没问题"。
 * 区分办法：主线程渲染时，一次渲染会把 UI 卡住；
 * 而 worker 正常时，渲染期间主线程是空闲的（这里用"渲染期间还能响应 JS"来判断）。
 */
const workerInfo = JSON.parse(
  await evaluate(`(() => {
    // pdf.js 把 worker 挂在全局；取不到就说明不是走的 worker 路径
    const w = window.__eplWorkerProbe;
    return JSON.stringify({
      hasProbe: typeof w !== 'undefined',
      info: w ?? null,
    });
  })()`),
)
console.log(`     worker 探针: ${JSON.stringify(workerInfo)}`)

// 更硬的判据：主线程是否会被一次渲染卡住
const blocked = await evaluate(`
  (async () => {
    // 触发一次整页重渲染（改缩放），然后测主线程在这期间的响应延迟
    const t0 = performance.now();
    let maxGap = 0;
    let last = performance.now();
    let running = true;
    const tick = () => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    document.querySelector('[data-tid="zoom-in"]')?.click();
    await new Promise(r => setTimeout(r, 2500));
    running = false;
    return Math.round(maxGap);
  })()
`)
console.log(`     渲染期间主线程最大卡顿: ${blocked} ms`)
check(
  '渲染没有把主线程卡死（说明 worker 真的在工作）',
  blocked < 700,
  `最大间隔 ${blocked} ms（worker 正常时应该在几十 ms 量级）`,
)

// ---------------------------------------------------------------- 5. 文件列表（桌面端专有能力）
console.log('\n[5] 文件列表：真实路径 + 持久化 + 懒加载')
/*
 * 系统文件对话框在 headless 下没法模拟，所以不测"点添加文件"。
 * 改测**更有价值的两件事**：列表能不能跨会话记住、点开文件夹是不是只扫一层。
 * 做法：直接往 localStorage 里写一份"上次记住的列表"，重载看它回不回得来。
 */
const TDIR = resolve(ROOT, 'public/testdata')
await evaluate(`
  localStorage.setItem('epl:file-list', JSON.stringify([
    { name: 'testdata', path: ${JSON.stringify(TDIR)}, kind: 'folder' },
  ]))
`)
await send('Page.reload')
await sleep(2600)

await evaluate(clickByTidExpr('文件'))
await sleep(700)

const listRows = await evaluate(
  `document.querySelectorAll('[data-tid="files-panel"] [data-node-id]').length`,
)
check('重载后列表自己回来了（持久化生效）', listRows >= 1, `条目数=${listRows}`)

// 展开文件夹 —— 桌面端这时才去扫盘（懒加载）
await evaluate(`document.querySelector('[data-tid="files-panel"] [data-kind="folder"]')?.click()`)
await sleep(1500)
const kidFiles = await evaluate(
  `document.querySelectorAll('[data-tid="files-panel"] [data-node-id][data-kind="file"]').length`,
)
check('点开文件夹才扫出里面的 PDF（懒加载生效）', kidFiles > 0, `扫出 ${kidFiles} 个`)

const listShot = await send('Page.captureScreenshot', { format: 'png' })
await writeFile(
  resolve(SHOTS, '02-exe-filelist.png'),
  Buffer.from(listShot.data, 'base64'),
)

// 真的点开一个 —— 走 Rust 的 read_pdf_bytes
await evaluate(`
  (() => {
    const rows = [...document.querySelectorAll('[data-tid="files-panel"] [data-kind="file"]')];
    rows.find(r => /1706/.test(r.textContent))?.click();
  })()
`)
let openedFromList = false
for (let i = 0; i < 60; i++) {
  await sleep(400)
  const nm = await evaluate(`(document.querySelector('[data-tid="file-name"]')||{}).textContent||''`)
  if (String(nm).includes('1706')) {
    openedFromList = true
    break
  }
}
check('点列表里的文件真的打开了（Rust 读字节这条路通）', openedFromList)

// ---------------------------------------------------------------- 6. 控制台
console.log('\n[6] 控制台')
const real = errors.filter((e) => !/favicon/i.test(e))
check('没有未捕获异常 / error', real.length === 0, real.slice(0, 3).join(' | ') || '干净')

console.log(`\n==================================================`)
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log(`==================================================\n`)

ws.close()
shutdown()
process.exit(fail ? 1 : 0)
