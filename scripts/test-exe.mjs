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
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clickByTidExpr } from './testids.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXE = resolve(ROOT, 'src-tauri/target/release/edge-pdf-lite.exe')
const PDF = resolve(ROOT, 'public/testdata/real-1706.03762.pdf')
const PORT = 9333

/** 测试用到的两个目录，提前定义 —— 下面启动 exe 时要拿它们拼白名单 */
const TESTDATA_DIR = resolve(ROOT, 'public/testdata')
const SAVE_DIR = resolve(ROOT, 'exe-shots', 'save-test')
/*
 * 路径白名单（见 src-tauri/src/lib.rs 的「路径闸门」一节）。
 *
 * 端到端测试没法操作系统对话框，所以用这个环境变量**在启动 exe 之前**把测试要碰的
 * 目录预先放行。注意它不是后门：环境变量是**启动进程的人**给的，前端 JS 改不了它 ——
 * 能改它的人本来就能直接换掉 exe。反过来，它也让"闸门真的生效"这件事可测了。
 */
const ALLOW_ROOTS = [TESTDATA_DIR, SAVE_DIR].join(';')

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

/*
 * 数据目录隔离 —— **测试绝不碰用户的真实 profile**。
 *
 * 🔴 以前这里是"把 `%LOCALAPPDATA%\<identifier>` 整个 rename 到临时目录、跑完再还"。
 *    两个问题：
 *      1. WebView2 的子进程常还攥着目录句柄 → **还原经常失败**（现场留了几十份副本），
 *         用户下次打开就发现**书单没了**。测试不许改用户数据。
 *      2. 它还往 localStorage **整条覆盖** `epl:file-list` —— 就算还回去了，内容也已经被测试顶掉。
 *
 * 现在的做法：`WEBVIEW2_USER_DATA_FOLDER` 是 **WebView2 自己的**环境变量（实测有效：
 * 设了之后 profile 真的落在那个目录，真实那份一个字节都没动）。
 * 关键是我们 Rust 侧的 `data_root()` **也读同一个变量**，所以自愈、标记文件、
 * 路径白名单全都跟着进沙箱，不会出现"WebView2 用沙箱、自愈却去动真实目录"这种错位。
 *
 * 每次从零开始（删掉重建）—— 这样连"WebView2 缓存了旧 index.html"那个老坑也一并躲开。
 */
const SANDBOX = join(tmpdir(), 'epl-exe-test-sandbox')
await rm(SANDBOX, { recursive: true, force: true }).catch(() => {})
await mkdir(SANDBOX, { recursive: true })

// ---------------------------------------------------------------- 启动 exe
// ⚠️ 先把它建出来：白名单里的路径是在 exe 启动那一刻解析的，
//    目录不存在虽然也能解析（拿父目录拼回来），但没必要让测试依赖这条兜底路径
await mkdir(SAVE_DIR, { recursive: true })

const proc = spawn(EXE, [], {
  stdio: 'ignore',
  env: {
    ...process.env,
    // ⚠️ 没有这个环境变量，WebView2 不会开调试端口，CDP 连不上去
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    // 把整个数据目录（profile + 白名单 + 自愈标记）挪进沙箱，真实那份完全不动
    WEBVIEW2_USER_DATA_FOLDER: SANDBOX,
    // 预先放行测试要碰的目录（理由见文件头附近 ALLOW_ROOTS 的说明）
    EPL_ALLOW_ROOTS: ALLOW_ROOTS,
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
    // ⚠️ console.error(x) 的 x 可能是对象/Error —— 只取 value 会得到 undefined，
    //    于是错误变成一条没有内容的 "console error"，根本看不出是什么坏了
    const a = m.params.args?.[0]
    const txt =
      a?.value ??
      a?.description ??
      a?.preview?.properties?.map((p) => `${p.name}=${p.value}`).join(' ') ??
      '（无内容的 console error）'
    errors.push(String(txt))
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
const TDIR = TESTDATA_DIR
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

// ---------------------------------------------------------------- 5b. 上次打开的文档
console.log('\n[5b] 重开后自动打开上次那篇 PDF')

/*
 * 用户的原始诉求："我看了一篇 pdf 之后关闭了软件，重新打开需要我重新打开本来的 pdf。
 * 上次阅读的位置记录下来了，但是上次阅读的 pdf 没有记录下来。"
 *
 * 所以这里要验**两件事**，缺一不可：
 *   ① 打开文件时把路径记下来了（不然重开就无从下手）
 *   ② 重开之后**不用手点**，那篇真的自己打开了，而且渲染出来了
 *      —— 光看文件名对不够，"只是设了个名字、画布是空的"也得判红
 *
 * ⚠️ 用整页重载模拟"关掉软件再打开"：WebView2 的 profile 不丢，
 *    localStorage 和真实文件系统都还是原样，跟进程重启的效果等价。
 */
const lastDoc = JSON.parse((await evaluate(`localStorage.getItem('epl:last-doc')`)) ?? 'null')
check(
  '从列表打开文件时记住了路径',
  !!lastDoc?.path && /1706/.test(String(lastDoc.path)),
  String(lastDoc?.path ?? '(没记)'),
)

await send('Page.reload')
await sleep(3000)

let restoredName = ''
for (let i = 0; i < 60; i++) {
  restoredName = String(
    await evaluate(`(document.querySelector('[data-tid="file-name"]')||{}).textContent||''`),
  )
  if (restoredName.includes('1706')) break
  await sleep(400)
}
check(
  '重开后**不用手点**就打开了上次那篇 PDF',
  restoredName.includes('1706'),
  `当前=${restoredName || '(空)'}`,
)

const canvasesAfterReload = await evaluate(`document.querySelectorAll('.pdf-page-canvas').length`)
check(
  '而且真的渲染出来了（不是只挂了个文件名）',
  canvasesAfterReload > 0,
  `画布=${canvasesAfterReload}`,
)

const pageAfterReload = await evaluate(
  `Number(document.querySelector('[data-tid="page-input"]')?.value ?? 0)`,
)
check('页码也恢复了（阅读位置记忆没被这次改动破坏）', pageAfterReload >= 1, `page=${pageAfterReload}`)

// 文件不在了的时候不能卡住，也不能每次都白试
const ghost = join(TDIR, 'definitely-not-here.pdf')
await evaluate(
  `localStorage.setItem('epl:last-doc', JSON.stringify({ path: ${JSON.stringify(ghost)}, name: '不存在.pdf', updatedAt: Date.now() }))`,
)
await send('Page.reload')
await sleep(3000)
const backToWelcome = await evaluate(`!!document.querySelector('.welcome')`)
check(
  '路径失效时回到欢迎页，不会卡在空白',
  backToWelcome,
  `#app 子节点=${await evaluate(`document.querySelector('#app').children.length`)}`,
)
const ghostLeft = await evaluate(`localStorage.getItem('epl:last-doc')`)
check(
  '并且把失效记录清掉了（不会每次启动都白试一遍）',
  !ghostLeft || ghostLeft === 'null',
  String(ghostLeft),
)

// ---------------------------------------------------------------- 6. 保存批注
console.log('\n[6] 保存批注：另存到指定目录 / 覆盖原文件（含自动 .bak）')

/*
 * 这一段测的是**桌面端独有的保存能力**，也是用户这轮提的核心诉求：
 * "按下保存之后显示了保存，但我不知道保存到了哪里"。
 *
 * 用到一条不容易想到的事实：**「覆盖原文件」只在"从文件列表打开"时才可用**。
 * 拖放和 <input type=file> 都只给一个临时 File 对象，没有真实路径 ——
 * 所以覆盖那一段必须走文件列表，不能图省事用 file input。
 */

const invoke = (cmd, args) =>
  evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})})`)

/** 数一个 PDF 里所有页的 /Annots 总数（用项目自己的 pdf-lib 依赖，不额外装东西） */
async function countAnnots(path) {
  try {
    // ⚠️ 包名是 @cantoo/pdf-lib（pdf-lib 的 fork），不是 pdf-lib
    const { PDFDocument } = await import('@cantoo/pdf-lib')
    const p = await PDFDocument.load(await readFile(path), {
      ignoreEncryption: true,
      updateMetadata: false,
    })
    let n = 0
    for (const page of p.getPages()) n += page.node.Annots()?.size() ?? 0
    return n
  } catch (e) {
    console.log(`     （解析失败：${String(e.message).slice(0, 80)}）`)
    return -1
  }
}

// ---- 6a. 默认保存目录
const defDir = await invoke('default_save_dir')
check(
  '默认保存目录在文档库里，不是安装目录（安装目录在 Program Files 下是只读的）',
  typeof defDir === 'string' && /edge-pdf-lite/i.test(defDir) && !/Program Files/i.test(defDir),
  String(defDir),
)
check(
  '默认保存目录已经建好了（第一次保存不该遇到"目录不存在"）',
  await invoke('path_exists', { path: defDir }),
)

// ---- 6b. 另存一份到指定目录
// （SAVE_DIR 定义在文件顶部 —— 启动 exe 时要拿它拼白名单）
// 每次重跑都要先清空：否则上一轮的 .bak 还在，Rust 会往后排成 .bak2
await rm(SAVE_DIR, { recursive: true, force: true }).catch(() => {})
await mkdir(SAVE_DIR, { recursive: true })

// 把设置改成"另存到 SAVE_DIR"（等价于用户在设置面板里点了「更改…」）
await evaluate(`
  localStorage.setItem('epl.settings.v1', JSON.stringify({
    saveMode: 'copy',
    saveDir: ${JSON.stringify(SAVE_DIR)},
    theme: 'dark',
  }))
`)
await send('Page.reload')
await sleep(2600)

// 先记下原件自带多少批注（113 条），后面要拿"恰好 +1"来判有没有写进去
const annotsBefore = await countAnnots(PDF)

// 打开 PDF 并画一笔，否则没有批注可存
await send('DOM.enable')
{
  const root = await send('DOM.getDocument', { depth: 1 })
  const q = await send('DOM.querySelector', { nodeId: root.root.nodeId, selector: 'input[type=file]' })
  await send('DOM.setFileInputFiles', { files: [PDF], nodeId: q.nodeId })
}
let ready6 = false
for (let i = 0; i < 60; i++) {
  await sleep(400)
  ready6 = await evaluate(`!!document.querySelector('.page-slot[data-page="1"]')`)
  if (ready6) break
}
check('保存测试用的 PDF 打开了', ready6)

await evaluate(clickByTidExpr('手写'))
await sleep(250)
{
  const box = JSON.parse(
    await evaluate(`
      (() => {
        const s = document.querySelector('.page-slot[data-page="1"]');
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
  const cx = box.x + box.w / 2
  const cy = box.y + Math.min(box.h * 0.4, 380)
  await mouseAt('mousePressed', cx - 70, cy, 1)
  for (let i = 1; i <= 10; i++) {
    await mouseAt('mouseMoved', cx - 70 + i * 14, cy + Math.sin(i / 2) * 15, 1)
    await sleep(12)
  }
  await mouseAt('mouseReleased', cx + 70, cy, 0)
  await sleep(400)
}
check(
  '画上了一笔（有东西可存）',
  (await evaluate(`Number(document.querySelector('[data-tid="annot-count"]')?.textContent ?? 0)`)) > 0,
)

await evaluate(clickByTidExpr('保存批注'))
// 等提示条出现，并从里面读路径。失败时把错误框的内容也捞出来，
// 否则"什么都没发生"这种症状查不出是保存失败还是压根没触发。
let toastText = ''
let errText = ''
for (let i = 0; i < 80; i++) {
  await sleep(300)
  toastText = await evaluate(`(document.querySelector('.toast') || {}).textContent || ''`)
  errText = await evaluate(`(document.querySelector('.err') || {}).textContent || ''`)
  if (/已保存/.test(toastText) || errText) break
}
if (errText) console.log(`     保存报错: ${errText.replace(/\s+/g, ' ').slice(0, 180)}`)
const hasOpenBtn = await evaluate(`!!document.querySelector('[data-tid="toast-open-dir"]')`)
check(
  '保存后提示里带上了**完整路径**（用户就是想知道存哪了）',
  /已保存/.test(toastText) && /save-test/i.test(toastText),
  toastText.replace(/\s+/g, ' ').slice(0, 110) || '（没有提示）',
)
check('提示右边有「打开文件夹」按钮', hasOpenBtn)

/*
 * 在 **Node 侧**解析路径，不要在页面里写正则。
 *
 * ⚠️ 坑：把正则写进 evaluate 的模板字符串时，`\.` 会被 JS 当成无效转义而**吞掉反斜杠**
 *    （模板字符串里 `\.` === `.`）。结果 `\.pdf` 变成 `.pdf`，于是路径被匹配到
 *    `edge-pdf` 就截断了 —— 看起来像"文件没写成功"，其实是解析错了。
 *    Node 侧的普通正则没有这层转义，直接在这儿做最省事。
 */
const savedName = (toastText.match(/[A-Za-z]:\\[^]*?\.pdf/) ?? [''])[0].trim()
check('从提示里解析出了落盘路径', !!savedName, savedName)
if (savedName) {
  check('文件真的写到磁盘上了', await invoke('path_exists', { path: savedName }))
  const bytes = await readFile(savedName).catch(() => Buffer.alloc(0))
  check('内容是有效 PDF（%PDF 头）', bytes.subarray(0, 5).toString('latin1') === '%PDF-')

  /*
   * 判"批注写进去了"用 **pdf-lib 解析**，不要搜字节串。
   *
   * ⚠️ 搜 `edge-pdf-lite` 这种写法在这个样本上会假红：2.2 MB 的论文 PDF
   *    对象流是 Flate 压缩的，作者名不以明文出现（小样本 annot-fixture.pdf
   *    没压缩，所以以前那条断言能过）。用解析出来的 /Annots 数量才跟压缩无关。
   */
  /*
   * ⚠️ 判据必须是**精确 +1**，不能写"大于 0"。
   * 这个样本自带 113 条批注 —— 写成 `> 0` 的话，writer 一行都没写也照样绿。
   */
  const annotCount = await countAnnots(savedName)
  check(
    '写回后批注数 = 原件 + 1（直查 /Annots，不经 UI）',
    annotCount === annotsBefore + 1,
    `${annotsBefore} → ${annotCount}`,
  )
  check('文件名带「已批注」后缀，不跟原件混淆', /已批注/.test(savedName), savedName.split(/[\\/]/).pop())
}

// ---- 6c. 覆盖原文件（必须走文件列表，才有真实路径）
const copyPath = join(SAVE_DIR, 'overwrite-target.pdf')
await copyFile(PDF, copyPath)
const beforeSize = (await stat(copyPath)).size
const annotsBefore2 = await countAnnots(copyPath)

await evaluate(`
  localStorage.setItem('epl:file-list', JSON.stringify([
    { name: 'overwrite-target.pdf', path: ${JSON.stringify(copyPath)}, kind: 'file' },
  ]));
  localStorage.setItem('epl.settings.v1', JSON.stringify({
    saveMode: 'overwrite',
    saveDir: ${JSON.stringify(SAVE_DIR)},
    theme: 'dark',
  }));
`)
await send('Page.reload')
await sleep(2600)

await evaluate(clickByTidExpr('文件'))
await sleep(700)
await evaluate(`document.querySelector('[data-tid="files-panel"] [data-kind="file"]')?.click()`)
let ready6c = false
for (let i = 0; i < 60; i++) {
  await sleep(400)
  ready6c = /overwrite-target/.test(
    await evaluate(`(document.querySelector('[data-tid="file-name"]')||{}).textContent||''`),
  )
  if (ready6c) break
}
check('从文件列表打开了副本（这样才有真实路径可覆盖）', ready6c)

await evaluate(clickByTidExpr('手写'))
await sleep(250)
{
  const box = JSON.parse(
    await evaluate(`
      (() => {
        const s = document.querySelector('.page-slot[data-page="1"]');
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
  const cx = box.x + box.w / 2
  const cy = box.y + Math.min(box.h * 0.5, 460)
  await mouseAt('mousePressed', cx - 60, cy, 1)
  for (let i = 1; i <= 10; i++) {
    await mouseAt('mouseMoved', cx - 60 + i * 12, cy + Math.cos(i / 2) * 14, 1)
    await sleep(12)
  }
  await mouseAt('mouseReleased', cx + 60, cy, 0)
  await sleep(400)
}

await evaluate(clickByTidExpr('保存批注'))
let toast2 = ''
for (let i = 0; i < 80; i++) {
  await sleep(300)
  toast2 = await evaluate(`(document.querySelector('.toast') || {}).textContent || ''`)
  if (/已覆盖/.test(toast2)) break
}
check('提示明说「已覆盖原文件」', /已覆盖/.test(toast2), toast2.slice(0, 90))

const afterSize = (await stat(copyPath)).size
check('原文件确实被改写了', afterSize !== beforeSize, `${beforeSize} → ${afterSize} 字节`)
{
  const n = await countAnnots(copyPath)
  check('覆盖后的原文件批注数 = 原来 + 1', n === annotsBefore2 + 1, `${annotsBefore2} → ${n}`)
}

const bakPath = join(SAVE_DIR, 'overwrite-target.bak.pdf')
check('自动留了一份 .bak', existsSync(bakPath))
if (existsSync(bakPath)) {
  const bak = await readFile(bakPath)
  check(
    '.bak 是**覆盖前**的原件（不含我们写进去的作者名）',
    !bak.includes(Buffer.from('edge-pdf-lite')),
    `${(bak.length / 1024).toFixed(1)} KB`,
  )
  check('.bak 字节数与原件一致', bak.length === beforeSize, `${bak.length} vs ${beforeSize}`)
  check(
    '.bak 的批注数与原件一致（备份是覆盖前的状态，不是覆盖后的）',
    (await countAnnots(bakPath)) === annotsBefore2,
    `${await countAnnots(bakPath)} vs ${annotsBefore2}`,
  )
}

const shot6 = await send('Page.captureScreenshot', { format: 'png' })
await writeFile(resolve(SHOTS, '03-exe-saved.png'), Buffer.from(shot6.data, 'base64'))

// ---------------------------------------------------------------- 7. 文件的右键菜单
console.log('\n[7] 文件右键：重命名 / 复制路径 / 在资源管理器打开')

const REN_SRC = join(SAVE_DIR, 'rename-me.pdf')
await copyFile(PDF, REN_SRC)
await evaluate(`
  localStorage.setItem('epl:file-list', JSON.stringify([
    { name: 'rename-me.pdf', path: ${JSON.stringify(REN_SRC)}, kind: 'file' },
  ]))
`)
await send('Page.reload')
await sleep(2600)
await evaluate(clickByTidExpr('文件'))
await sleep(700)

const ctxOnFile = () =>
  evaluate(`
    (() => {
      const row = document.querySelector('[data-tid="files-panel"] [data-kind="file"]');
      if (!row) return false;
      const r = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: Math.round(r.left + 40), clientY: Math.round(r.top + r.height / 2),
      }));
      return true;
    })()
  `)

await ctxOnFile()
await sleep(320)
check(
  '桌面端右键文件，三项都可用（有真实路径，跟浏览器版的禁用相反）',
  await evaluate(`
    ['file-rename', 'file-reveal', 'file-copy-path'].every((i) => {
      const b = document.querySelector('[data-tid="' + i + '"]');
      return b && !b.disabled;
    })
  `),
)
{
  const s = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(resolve(SHOTS, '04-exe-file-menu.png'), Buffer.from(s.data, 'base64'))
}

// ---- 重命名
await evaluate(`document.querySelector('[data-tid="file-rename"]').click()`)
await sleep(380)
check('出现行内输入框（不是弹对话框 —— 对话框在 CDP 下会把页面卡住）', await evaluate(`!!document.querySelector('[data-tid="rename-input"]')`))
const draft = await evaluate(`document.querySelector('[data-tid="rename-input"]')?.value ?? ''`)
check('输入框里只有主文件名，后缀不在编辑范围内', draft === 'rename-me', `"${draft}"`)
/*
 * 必须断言**自动聚焦**：字符串 ref 在 v-for 里会变成数组，`.focus()` 于是报错，
 * 而这条错误只在控制台里，界面上只是"没聚焦"—— 很容易被当成小毛病放过。
 */
check(
  '输入框自动聚焦了（不用再点一下才能改）',
  await evaluate(`document.activeElement === document.querySelector('[data-tid="rename-input"]')`),
  await evaluate(`document.activeElement?.getAttribute?.('data-tid') ?? document.activeElement?.tagName`),
)
check(
  '内容被全选了（直接打字就能覆盖原名字）',
  await evaluate(`
    (() => {
      const i = document.querySelector('[data-tid="rename-input"]');
      return i.selectionStart === 0 && i.selectionEnd === i.value.length && i.value.length > 0;
    })()
  `),
)

await evaluate(`
  (() => {
    const i = document.querySelector('[data-tid="rename-input"]');
    i.value = 'renamed-ok';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()
`)
await sleep(1000)
const REN_DST = join(SAVE_DIR, 'renamed-ok.pdf')
check('磁盘上的文件**真的**改名了', await invoke('path_exists', { path: REN_DST }))
check('是改名不是复制（原名已经不在了）', !(await invoke('path_exists', { path: REN_SRC })))
check(
  '后缀没被改（还是 .pdf）',
  /\.pdf$/i.test(await evaluate(`document.querySelector('[data-tid="files-panel"]').textContent.match(/renamed-ok[^\\s]*/)?.[0] ?? ''`)),
  await evaluate(`document.querySelector('[data-tid="files-panel"]').textContent.match(/renamed-ok[^\\s]*/)?.[0] ?? '（没找到）'`),
)

// ---- 复制路径：剪贴板在 CDP 里可能被拒，但**无论如何都要有反馈**
await ctxOnFile()
await sleep(320)
await evaluate(`document.querySelector('[data-tid="file-copy-path"]').click()`)
/*
 * ⚠️ **必须轮询，不能"等够时间再读"** —— 提示条只显示 2.6 秒（`showToast`），
 *    而复制有两种节奏：顺利时几乎立刻出提示、剪贴板没回音时要等 2 秒兜底（见 copyPath）。
 *    写死一个 sleep 必然踩在两种节奏的缝里：第一版等 2.6 秒，正好卡在提示条过期上，
 *    于是"功能明明是好的，测试却红"。
 */
let cpToast = ''
for (let i = 0; i < 14; i++) {
  cpToast = await evaluate(`(document.querySelector('.toast') || {}).textContent || ''`)
  if (cpToast) break
  await sleep(300)
}
check(
  '复制路径给了反馈（剪贴板是看不见的操作，静默=不知道成没成）',
  /已复制路径|复制失败|复制没有回应/.test(cpToast),
  cpToast.replace(/\s+/g, ' ').slice(0, 80),
)

// ---------------------------------------------------------------- 7b. 路径闸门
console.log('\n[7b] 路径闸门：白名单之外一律拒绝')
/*
 * 为什么这一段值得单独存在：
 *
 * 上面所有功能都建立在"前端没被攻破"这个前提上 —— 而那是**我们控制不了的**
 * （pdf.js 将来出个 XSS、或者某次改动引进了注入点，谁都不好说）。
 * 路径闸门是唯一一道**不依赖那个前提**的墙：即使有人能在这套前端里跑任意 JS，
 * `read_pdf_bytes` 也读不到白名单之外的东西、`write_pdf_b64` 也写不进去。
 *
 * 所以判据必须是"**拒绝**"，而不是"没读到" —— 而且每一次都要有阳性对照，
 * 免得把该放行的也挡了（那种"安全"是坏的）。
 */

/**
 * 调一个命令，并分辨"被拒绝了"和"成功了" —— 这一段判的正是这个区别。
 *
 * ⚠️ **不把返回值本身带回来**：`read_pdf_bytes` 回的是几十万个数字的数组
 *    （Tauri 的 IPC 用 JSON 序列化 `Vec<u8>`），经 CDP 的 `returnByValue`
 *    传回来会把连接搞死 —— 第一版就是这么写，整个脚本挂在中途，
 *    还连带把用户的数据目录留在了临时目录里没还回去。
 *    这里只把"长度"和"布尔值"这种小东西带回来，判据够用了。
 *
 * ⚠️ 错误信息要取 `String(e)`：被拒绝时 Tauri 抛的是**字符串**（命令返回的 Err(String)），
 *    不是 Error 对象 —— 只取 `exception.description` 会得到一句没用的
 *    "Uncaught (in promise)"，于是"拒绝了没有"能判、"拒绝得对不对"判不了。
 */
const tryInvoke = async (cmd, args) =>
  JSON.parse(
    await evaluate(`(async () => {
      try {
        const v = await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})});
        return JSON.stringify({
          ok: true,
          len: (v != null && v.length !== undefined) ? v.length : null,
          val: (typeof v === 'boolean') ? v : null,
        });
      } catch (e) {
        return JSON.stringify({ ok: false, err: String(e) });
      }
    })()`),
  )

// 一个**不在**白名单里的真 PDF：先拷过去，保证"被拒绝"只可能是白名单的原因，
// 而不是"文件不存在"或者"后缀不对"
const OUTSIDE_DIR = tmpdir()
const OUTSIDE_PDF = join(OUTSIDE_DIR, 'epl-outside.pdf')
await copyFile(PDF, OUTSIDE_PDF)

let r = await tryInvoke('read_pdf_bytes', { path: OUTSIDE_PDF })
check('白名单外的 PDF 读不出来', !r.ok && /拒绝访问/.test(r.err), r.ok ? `竟然读到了 ${r.len} 字节` : r.err)

r = await tryInvoke('list_dir', { path: OUTSIDE_DIR })
check('白名单外的目录列不出来', !r.ok && /拒绝访问/.test(r.err), r.ok ? `竟然列出了 ${r.len} 项` : '')

// 写入：不仅要拒绝，还要确认磁盘上**真的没多出文件**（证明是"写在前面挡住的"）
// ⚠️ 先清掉可能的历史残留：否则"没留下文件"这条会被上一轮（比如变异测试）留下的垃圾误判成红
const OUTSIDE_OUT = join(OUTSIDE_DIR, 'epl-write-test.pdf')
await rm(OUTSIDE_OUT, { force: true }).catch(() => {})
r = await tryInvoke('write_pdf_b64', {
  path: OUTSIDE_OUT,
  b64: Buffer.from('%PDF-1.4\n').toString('base64'),
  makeBackup: false,
})
check('白名单外写不进去', !r.ok && /拒绝访问/.test(r.err), r.ok ? '竟然写进去了' : '')
check('被拒绝的写入没有在磁盘上留下文件', !existsSync(OUTSIDE_OUT))

/*
 * ⚠️ 这一条看着吹毛求疵，实际是在防**数据丢失**：
 *    前端区分"被拒绝"和"文件不在了"的方式正好相反（拒绝→保留条目，
 *    不在了→从列表里删掉）。闸门要是回 `false` 而不是报错，
 *    用户一开软件就会看到自己的文件列表被静默清空。
 */
r = await tryInvoke('path_exists', { path: OUTSIDE_PDF })
check('白名单外的 path_exists 是**报错**而不是回 false', !r.ok, r.ok ? `回了 ${r.val}` : '')

// `..` 穿越：前端递过来的是**没归一化**的字符串，Rust 侧必须自己解析出真实路径
const ESCAPE = `${TESTDATA_DIR}\\..\\..\\..\\epl-escape.pdf`
r = await tryInvoke('read_pdf_bytes', { path: ESCAPE })
check('带 .. 的路径也穿越不出白名单', !r.ok && /拒绝访问/.test(r.err), r.ok ? '竟然读到了' : '')

/*
 * 重命名不能变成"把文件挪到任意位置"。
 * ⚠️ 拿**副本**去试，不碰真样本 —— 万一哪天这条判据失效（比如变异测试），
 *    被挪走的是一份随时可再生成的拷贝，不是那个要求逐字节稳定的语料。
 */
const PROBE = join(TESTDATA_DIR, 'epl-rename-probe.pdf')
await copyFile(PDF, PROBE)
r = await tryInvoke('rename_file', { path: PROBE, newName: '..\\epl-evil.pdf' })
check('重命名不接受带路径分隔符的新名字', !r.ok && /不合法/.test(r.err), r.err)
check('被拒绝的重命名没动到原文件', existsSync(PROBE))
await rm(PROBE, { force: true }).catch(() => {})
// 万一（变异测试时）真的成功了，把这坨垃圾清掉，别留在仓库外面
await rm(resolve(TESTDATA_DIR, '..', '..', '..', 'epl-evil.pdf'), { force: true }).catch(() => {})

// ---- 阳性对照：闸门不能把该放行的也挡掉
r = await tryInvoke('read_pdf_bytes', { path: PDF })
check('（对照）放行目录里的 PDF 照常读得到', r.ok && r.len > 1000, r.ok ? `${r.len} 字节` : r.err)
r = await tryInvoke('list_dir', { path: TESTDATA_DIR })
check('（对照）放行目录照常列得出来', r.ok && r.len > 0, r.ok ? `${r.len} 项` : r.err)

// 后缀那一道：路径放行 ≠ 什么文件都能读
const NOT_PDF = join(TESTDATA_DIR, 'not-a-pdf.txt')
await writeFile(NOT_PDF, 'hello\n')
r = await tryInvoke('read_pdf_bytes', { path: NOT_PDF })
check('（对照）放行目录里的非 .pdf 仍然读不了（后缀那一道）', !r.ok && /只处理/.test(r.err), r.ok ? '竟然读到了' : r.err)
await rm(NOT_PDF, { force: true }).catch(() => {})

// 放行列表要能跨重启活着，否则"上次打开的文件"和整个文件列表下次全读不了
// （路径在沙箱里 —— 测试不碰用户的真实数据目录）
const WHITELIST = join(SANDBOX, 'allowed-paths.txt')
const wl = existsSync(WHITELIST) ? await readFile(WHITELIST, 'utf8') : ''
check(
  '放行列表落盘了（否则重启后文件列表全废）',
  wl.includes('edge-pdf-lite'),
  existsSync(WHITELIST) ? WHITELIST : '文件不存在',
)

// ---------------------------------------------------------------- 8. 控制台
console.log('\n[8] 控制台')
const real = errors.filter((e) => !/favicon/i.test(e))
check('没有未捕获异常 / error', real.length === 0, real.slice(0, 3).join(' | ') || '干净')

console.log(`\n==================================================`)
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log(`==================================================\n`)

ws.close()
shutdown()

/*
 * 收尾：**没有"把用户数据换回来"这一步了** —— 数据目录整个跑在沙箱里
 * （`WEBVIEW2_USER_DATA_FOLDER`），真实 profile 从头到尾没被碰过。
 * 沙箱留在临时目录里不删，想看现场（localStorage、白名单、标记文件）随时能翻。
 */
console.log(`沙箱（测试用过的数据目录）：${SANDBOX}`)

process.exit(fail ? 1 : 0)
