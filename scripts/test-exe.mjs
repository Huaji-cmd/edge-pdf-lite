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
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
/**
 * 「原件在哪」和「保存目录在哪」**故意分开**。
 * 只有分开才测得出 `.bak` 到底跟着谁走（用户报的就是这个：设了保存目录，
 * bak 还是掉在原书旁边）。
 */
const SRC_DIR = resolve(ROOT, 'exe-shots', 'src-test')
/*
 * 路径白名单（见 src-tauri/src/lib.rs 的「路径闸门」一节）。
 *
 * 端到端测试没法操作系统对话框，所以用这个环境变量**在启动 exe 之前**把测试要碰的
 * 目录预先放行。注意它不是后门：环境变量是**启动进程的人**给的，前端 JS 改不了它 ——
 * 能改它的人本来就能直接换掉 exe。反过来，它也让"闸门真的生效"这件事可测了。
 */
const ALLOW_ROOTS = [TESTDATA_DIR, SAVE_DIR, SRC_DIR].join(';')

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
/** 页面上弹过的原生对话框（关窗口时的"未保存"确认就在这里） */
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
    dialogs.push({ type: m.params?.type, message: m.params?.message ?? '' })
    /*
     * 一律按「取消」关掉。
     * 🔴 不处理的话，原生 confirm 会**阻塞页面** → CDP 的 evaluate 永远不返回，
     *    整套测试的表现是"卡死"而不是"失败"（跟 beforeunload 那个坑同源）。
     */
    ws.send(
      JSON.stringify({
        id: ++id,
        method: 'Page.handleJavaScriptDialog',
        params: { accept: false },
      }),
    )
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

/*
 * ---- 5b. 展开状态要跨面板切换记住 -------------------------------------------
 *
 * 用户报的："打开大纲之后返回文件列表，又要重新展开一次文件夹。"
 * 根因：FilesPanel 是 `v-if` 切换的，组件一卸载 `expanded` 这个 ref 就没了。
 * 现在存进 localStorage（键用真实路径，不用会话内自增的 id）。
 *
 * ⚠️ 判据量的是**切回来之后还有几行文件**：没记住的话只剩 1 行（那个文件夹），
 *    记住了才是 kidFiles 那么多。
 */
await evaluate(clickByTidExpr('目录'))
await sleep(420)
check(
  '切到了目录面板（文件面板真的卸载了）',
  !(await evaluate(`!!document.querySelector('[data-tid="files-panel"]')`)),
)
await evaluate(clickByTidExpr('文件'))
await sleep(1600)
const rowsBack = Number(
  await evaluate(
    `document.querySelectorAll('[data-tid="files-panel"] [data-node-id][data-kind="file"]').length`,
  ),
)
check(
  '从大纲切回文件面板，文件夹**仍然是展开的**（不用再点一次）',
  rowsBack === kidFiles && rowsBack > 0,
  `切走前 ${kidFiles} 行 → 切回 ${rowsBack} 行`,
)

/*
 * ---- 5c. 刷新：磁盘上新出现的 PDF 要能扫出来 --------------------------------
 *
 * 用户报的："另存一个文件后列表不显示，得重开。"
 * 做法：真的往被监视的目录里拷一个 PDF，点刷新，看它出不出来。
 */
{
  const probePath = join(TDIR, 'refresh-probe.pdf')
  await copyFile(PDF, probePath)
  const before = Number(
    await evaluate(
      `document.querySelectorAll('[data-tid="files-panel"] [data-node-id][data-kind="file"]').length`,
    ),
  )
  await evaluate(`document.querySelector('[data-tid="files-refresh"]')?.click()`)
  await sleep(1600)
  const after = Number(
    await evaluate(
      `document.querySelectorAll('[data-tid="files-panel"] [data-node-id][data-kind="file"]').length`,
    ),
  )
  const sawProbe = await evaluate(
    `(document.querySelector('[data-tid="files-panel"]')?.textContent || '').includes('refresh-probe')`,
  )
  check(
    '磁盘上新放的 PDF，点刷新就出现在列表里（不用重开应用）',
    sawProbe && after > before,
    `${before} → ${after} 行${sawProbe ? '' : '（没看到 refresh-probe）'}`,
  )
  await rm(probePath, { force: true })
}

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

/*
 * ---- 5c. 关掉再开：侧边栏的开合 / 停在哪一栏 / 文件夹展开都要还在 ---------
 *
 * 用户的原话："关掉应用重新打开，如果左边侧边栏是展开的就是展开，文件列表也是这样。"
 *
 * 这一段**不点任何按钮** —— 重载完直接量。点一下再量等于自己把状态又打开了一遍，
 * 那种判据再怎么错都容易绿。
 *
 * ⚠️ 断言的基准 `kidFiles` 是"加 refresh-probe 之前"的数：那个探针文件在 5a 末尾
 *    已经从磁盘删掉了，重开后重新扫盘应当回到原来的行数 —— 顺便也验证了
 *    "扫盘拿到的是最新文件系统，不是上次的快照"。
 */
check(
  '重开后侧边栏仍然展开（上次开着就一直开着）',
  await evaluate(`!!document.querySelector('.side')`),
)

check(
  '而且停在上次用的「文件」面板',
  await evaluate(`!!document.querySelector('[data-tid="files-panel"]')`),
)

let rowsAfterRestart = 0
for (let i = 0; i < 15; i++) {
  rowsAfterRestart = Number(
    await evaluate(
      `document.querySelectorAll('[data-tid="files-panel"] [data-node-id][data-kind="file"]').length`,
    ),
  )
  if (rowsAfterRestart === kidFiles) break
  await sleep(400)
}
// 只在失败时打印：一眼分辨是"localStorage 里没有展开键"还是"有键但没恢复"
if (rowsAfterRestart !== kidFiles) {
  console.log(
    '     诊断：',
    await evaluate(`
      JSON.stringify({
        expanded: localStorage.getItem('epl:files-expanded'),
        folders: [...document.querySelectorAll('[data-tid="files-panel"] [data-kind="folder"]')]
          .map(e => ({ cls: e.className, html: e.textContent.trim().slice(0, 20) })),
        nodes: document.querySelectorAll('[data-tid="files-panel"] [data-node-id]').length,
        list: localStorage.getItem('epl:file-list'),
      })
    `),
  )
}
check(
  '文件夹的展开状态也还在（重开后一行不少）',
  rowsAfterRestart === kidFiles && rowsAfterRestart > 0,
  `${kidFiles} 行 → 重开 ${rowsAfterRestart} 行`,
)

// 反过来：收起之后重开，也不该自己弹出来
await evaluate(`document.querySelector('[data-tid="sidebar-toggle"]')?.click()`)
await sleep(500)
await send('Page.reload')
await sleep(2600)
check(
  '收起后重开还是收起的（不会强行弹出来）',
  !(await evaluate(`!!document.querySelector('.side')`)),
)

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

/**
 * 读一个 PDF 里所有 FreeText 注释：内容 + `/AP` 用的字体信息。
 *
 * 判"中文到底画出来了没有"**只能看结构**，不能看字节串：
 *   · 嵌入的子集字体一定有 `Type0` + `DescendantFonts[0].FontDescriptor.FontFile2`；
 *   · 退回"占位横线"时一个字体都不会有（横线是画出来的矩形）。
 * 所以这两项就是"真的画了中文"的机器判据。
 *
 * ⚠️ `Contents` 不要用 `lookupMaybe(…, PDFString, PDFHexString)`：写成 `PDFName`
 *    （历史版本的 bug）时会抛 `UnexpectedObjectTypeError`，整个测试崩掉。
 */
async function freeTextInfo(path) {
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFStream } = await import('@cantoo/pdf-lib')
  const p = await PDFDocument.load(await readFile(path), {
    ignoreEncryption: true,
    updateMetadata: false,
  })
  const out = []
  for (const page of p.getPages()) {
    const annots = page.node.Annots()
    if (!annots) continue
    for (let i = 0; i < annots.size(); i++) {
      let d = null
      try {
        d = p.context.lookup(annots.get(i), PDFDict)
      } catch {
        continue
      }
      if (!d) continue
      if (String(d.lookupMaybe(PDFName.of('Subtype'), PDFName)) !== '/FreeText') continue
      const raw = d.get(PDFName.of('Contents'))
      const contents = raw && typeof raw.decodeText === 'function' ? raw.decodeText() : ''
      const fonts = { type0: 0, embedded: 0, base: [] }
      const ap = d.lookupMaybe(PDFName.of('AP'), PDFDict)
      const n = ap ? ap.lookupMaybe(PDFName.of('N'), PDFDict, PDFStream) : null
      const nDict = n instanceof PDFDict ? n : (n?.dict ?? null)
      const res = nDict ? nDict.lookupMaybe(PDFName.of('Resources'), PDFDict) : null
      const fontDict = res ? res.lookupMaybe(PDFName.of('Font'), PDFDict) : null
      if (fontDict) {
        for (const k of fontDict.keys()) {
          const f = fontDict.lookupMaybe(k, PDFDict)
          if (!f) continue
          fonts.base.push(String(f.lookupMaybe(PDFName.of('BaseFont'), PDFName)))
          if (String(f.lookupMaybe(PDFName.of('Subtype'), PDFName)) === '/Type0') fonts.type0++
          const desc = f.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray)
          const cid = desc ? p.context.lookupMaybe(desc.get(0), PDFDict) : null
          const fd = cid ? cid.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict) : null
          if (fd && fd.has(PDFName.of('FontFile2'))) fonts.embedded++
        }
      }
      out.push({ contents, fonts })
    }
  }
  return out
}

/** 等提示条出现，返回它的文字（`until` 是正则，匹配不到就超时返回最后一次内容） */
async function waitToast(until) {
  let t = ''
  for (let i = 0; i < 90; i++) {
    await sleep(300)
    t = await evaluate(`(document.querySelector('.toast') || {}).textContent || ''`)
    if (until.test(t)) break
  }
  return t
}

/** 在第 1 页上按相对位置画一笔手写（调用前必须已经选中「手写」工具） */
async function drawInkAt(fx = 0.5, fy = 0.45) {
  const box = JSON.parse(
    await evaluate(`(() => {
      const s = document.querySelector('.page-slot[data-page="1"]');
      if (!s) return 'null';
      const r = s.getBoundingClientRect();
      return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height });
    })()`),
  )
  if (!box) return false
  const cx = box.x + box.w * fx
  const cy = box.y + Math.min(box.h * fy, 480)
  const mouseAt = (type, x, y, buttons) =>
    send('Input.dispatchMouseEvent', {
      type,
      x: Math.round(x),
      y: Math.round(y),
      button: 'left',
      buttons,
      clickCount: 1,
    })
  await mouseAt('mousePressed', cx - 50, cy, 1)
  for (let i = 1; i <= 8; i++) {
    await mouseAt('mouseMoved', cx - 50 + i * 12, cy + Math.sin(i / 2) * 10, 1)
    await sleep(12)
  }
  await mouseAt('mouseReleased', cx + 46, cy, 0)
  await sleep(350)
  return true
}

/** 从文件列表打开当前唯一那一本，标题栏出现 `name` 就算成功 */
async function openFromList(name) {
  await evaluate(clickByTidExpr('文件'))
  await sleep(700)
  await evaluate(`document.querySelector('[data-tid="files-panel"] [data-kind="file"]')?.click()`)
  for (let i = 0; i < 60; i++) {
    await sleep(400)
    const t = await evaluate(`(document.querySelector('[data-tid="file-name"]')||{}).textContent||''`)
    if (t.includes(name)) return true
  }
  return false
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

// ---------------------------------------------------------------- 6d/6e
/*
 * ---- 6d. 覆盖保存时 `.bak` 落在哪（设置里的开关）
 *
 * 用户报的："另存为的路径设置好了，但直接保存后的 bak 依然跟原文件在同一路径"。
 * 原来的实现把 bak 固定写在**被覆盖文件的旁边**，跟他设的保存位置无关。
 *
 * 判据要**两个目录都看**：只断言"保存目录里有 bak"是不够的 ——
 * 两边各写一份也能通过，而用户抱怨的恰恰是原目录里多出来那一份。
 */
console.log('\n[6d] 覆盖保存时 .bak 的落点（设置开关：同原目录 / 跟保存位置）')

await rm(SRC_DIR, { recursive: true, force: true }).catch(() => {})
await mkdir(SRC_DIR, { recursive: true })
const srcPdf = join(SRC_DIR, 'bak-src.pdf')
const bakBeside = join(SRC_DIR, 'bak-src.bak.pdf')
const bakInSave = join(SAVE_DIR, 'bak-src.bak.pdf')
await copyFile(PDF, srcPdf)

const writeSettings = (extra) => evaluate(`
  localStorage.setItem('epl.settings.v1', JSON.stringify(Object.assign({
    saveMode: 'overwrite',
    saveDir: ${JSON.stringify(SAVE_DIR)},
    backupPos: 'same',
    theme: 'dark',
  }, ${JSON.stringify(extra)})))
`)

await evaluate(`
  localStorage.setItem('epl:file-list', JSON.stringify([
    { name: 'bak-src.pdf', path: ${JSON.stringify(srcPdf)}, kind: 'file' },
  ]));
`)
await writeSettings({ backupPos: 'same' })
await send('Page.reload')
await sleep(2600)
check('从文件列表打开了原件', await openFromList('bak-src'))

await evaluate(clickByTidExpr('手写'))
await sleep(250)
await drawInkAt()
await evaluate(clickByTidExpr('保存批注'))
let toast6d = await waitToast(/已覆盖/)
check('覆盖保存成功', /已覆盖/.test(toast6d), toast6d.replace(/\s+/g, ' ').slice(0, 80))
check(
  'backupPos=same → .bak 在**原文件目录**，保存目录里没有多余的一份',
  existsSync(bakBeside) && !existsSync(bakInSave),
  `原目录=${existsSync(bakBeside)} 保存目录=${existsSync(bakInSave)}`,
)

// 换成「跟保存位置一致」，再覆盖一次
await rm(bakBeside, { force: true })
await rm(bakInSave, { force: true })
const sizeBefore2 = (await stat(srcPdf)).size
await writeSettings({ backupPos: 'saveDir' })
await send('Page.reload')
await sleep(2600)
check('重新打开原件（第二回合）', await openFromList('bak-src'))
await evaluate(clickByTidExpr('手写'))
await sleep(250)
await drawInkAt(0.6, 0.55)
await evaluate(clickByTidExpr('保存批注'))
toast6d = await waitToast(/已覆盖/)
check('第二次覆盖保存成功', /已覆盖/.test(toast6d), toast6d.replace(/\s+/g, ' ').slice(0, 80))
check(
  'backupPos=saveDir → .bak 落在**保存目录**，原目录里没有',
  existsSync(bakInSave) && !existsSync(bakBeside),
  `原目录=${existsSync(bakBeside)} 保存目录=${existsSync(bakInSave)}`,
)
if (existsSync(bakInSave)) {
  const bakSize = (await stat(bakInSave)).size
  check(
    '.bak 是**这次覆盖前**的原件（字节数对得上，不是写完之后再拷的）',
    bakSize === sizeBefore2,
    `${bakSize} vs ${sizeBefore2}`,
  )
}

/*
 * ---- 6e. 中文文本框：字体必须真的嵌进去
 *
 * 用户报的（最严重那条）："打完字保存，中文全部变成灰条，只有纯英文能正常显示"。
 * 根因是标准 14 字体没有 CJK 字形，旧实现干脆画"占位灰条"。
 * 现在改成读系统字体 + 子集化嵌入 —— 判据要看**保存出来的 PDF 结构**。
 */
console.log('\n[6e] 中文文本框：嵌入字体（不再是灰条）')

await writeSettings({ saveMode: 'copy' })
/*
 * 用**文件列表**打开原件，不走 `<input type=file>`：
 * 前一版走 file input，结果 24 秒都没出现页面（reload 之后那个 input 的
 * change 链路在某些时机会哑掉）。文件列表这条路径上面刚验证过是通的，
 * 而且走真实路径更接近用户操作。
 */
await evaluate(`
  localStorage.setItem('epl:file-list', JSON.stringify([
    { name: 'real-1706.03762.pdf', path: ${JSON.stringify(PDF)}, kind: 'file' },
  ]));
  localStorage.removeItem('epl:last-doc');
`)
await send('Page.reload')
await sleep(2600)
check('中文测试用的 PDF 打开了', await openFromList('real-1706'))

const origSize = (await stat(PDF)).size
await evaluate(clickByTidExpr('文本框'))
await sleep(260)
{
  const b = JSON.parse(
    await evaluate(`(() => {
      const s = document.querySelector('.page-slot[data-page="1"]');
      const r = s.getBoundingClientRect();
      return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height });
    })()`),
  )
  const x0 = b.x + 60
  const y0 = b.y + Math.min(b.h * 0.3, 200)
  const mouseAt = (type, x, y, buttons) =>
    send('Input.dispatchMouseEvent', {
      type,
      x: Math.round(x),
      y: Math.round(y),
      button: 'left',
      buttons,
      clickCount: 1,
    })
  await mouseAt('mousePressed', x0, y0, 1)
  for (let i = 1; i <= 6; i++) {
    await mouseAt('mouseMoved', x0 + (260 * i) / 6, y0 + (90 * i) / 6, 1)
    await sleep(16)
  }
  await mouseAt('mouseReleased', x0 + 260, y0 + 90, 0)
  await sleep(700)
  check('拖出一个文本框并进入编辑态', await evaluate(`!!document.querySelector('[data-tid="text-edit"]')`))
  await send('Input.insertText', { text: '中文渲染测试：中英混排 abc 123' })
  await sleep(400)
  // 点页面左上角空白处结束编辑（⚠️ 必须落在框外）
  await mouseAt('mousePressed', b.x + 14, b.y + 14, 1)
  await mouseAt('mouseReleased', b.x + 14, b.y + 14, 0)
  await sleep(600)
}

const ftData = await evaluate(
  `JSON.stringify((globalThis.__eplViewer?.annots?.() ?? []).filter(a => a.kind === 'freetext').map(a => a.text))`,
)
check('文本框内容进了批注数据', /中文渲染测试/.test(String(ftData)), String(ftData).slice(0, 80))

await evaluate(clickByTidExpr('保存批注'))
const toast6e = await waitToast(/已保存/)
check('保存成功', /已保存/.test(toast6e), toast6e.replace(/\s+/g, ' ').slice(0, 90))

const cjkPath = (toast6e.match(/[A-Za-z]:\\[^]*?\.pdf/) ?? [''])[0].trim()
check('从提示里解析出落盘路径', !!cjkPath, cjkPath)
if (cjkPath) {
  const infos = await freeTextInfo(cjkPath)
  const mine = infos.find((i) => i.contents.includes('中文渲染测试'))
  check('保存出的 PDF 里有这条中文 FreeText（内容没丢）', !!mine, `共 ${infos.length} 条 FreeText`)
  check(
    '字体是 **Type0**（CID 字体），不是标准 Helvetica',
    !!mine && mine.fonts.type0 > 0,
    mine ? mine.fonts.base.join(',') : '',
  )
  check(
    '字体**真的嵌入**了（FontDescriptor 里有 FontFile2）—— 这才叫"画出来"而不是灰条',
    !!mine && mine.fonts.embedded > 0,
  )
  const grown = (await stat(cjkPath)).size - origSize
  check(
    '只嵌了用到的字形（子集化）：文件没有暴涨到 +9MB',
    grown > 0 && grown < 3 * 1024 * 1024,
    `+${(grown / 1024).toFixed(1)} KB`,
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
          // ⚠️ read_pdf_bytes 回的是**原始字节**（ArrayBuffer）→ 它没有 .length，
          //    要看 .byteLength。只判 .length 的话这里会静默变成 null，
          //    "读到了多少字节"这条对照就会假红。
          //    （注意：这段是模板字符串里的代码，注释里**不能出现反引号** ——
          //      会把这个模板提前结束掉，报一个莫名其妙的 SyntaxError。）
          len: (v != null && v.length !== undefined) ? v.length
             : (v != null && v.byteLength !== undefined) ? v.byteLength
             : null,
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

/*
 * ---- 6g. 只读原文件 / 带 `\\?\` 的旧保存目录
 *
 * 用户报的："为什么保存位置前面会有 `\\?\`，然后我就保存失败了，报错是 undefined"。
 * 真因是两条独立的毛病叠在一起：
 *   ① 他那个 PDF **是只读的**（网盘/压缩包解出来的）→ `fs::write` 报"拒绝访问"；
 *   ② 前端 `(e as Error).message` 对**字符串** rejection 取不到内容 → 显示 undefined。
 * （`\\?\` 本身不影响写入 —— 下面第 1 条就是拿它当对照组。）
 */
console.log('\n[6g] 只读原文件 / 带 \\\\?\\ 前缀的路径')

{
  // 对照组：直接用扩展长度前缀写一个新文件，必须成功（证明 `\\?\` 无罪）
  const small = await readFile(resolve(ROOT, 'public/testdata/annot-fixture.pdf'))
  const tinyB64 = small.toString('base64')
  const LONG = '\\\\?\\'
  const probe = (p) => `(async () => {
    try {
      const r = await window.__TAURI_INTERNALS__.invoke('write_pdf_b64', {
        path: ${JSON.stringify(p)},
        b64: ${JSON.stringify(tinyB64)},
        makeBackup: false,
        backupDir: null,
      })
      return 'OK ' + JSON.stringify(r)
    } catch (e) {
      return 'ERR ' + (typeof e === 'string' ? e : JSON.stringify(e))
    }
  })()`
  const plain = await evaluate(probe(join(SAVE_DIR, 'prefix-plain.pdf')))
  const longPath = await evaluate(probe(LONG + join(SAVE_DIR, 'prefix-long.pdf')))
  check('普通路径写入成功（对照）', /^OK/.test(plain), String(plain).slice(0, 120))
  check('带 \\\\?\\ 前缀也能写入（它不是失败的原因）', /^OK/.test(longPath), String(longPath).slice(0, 120))
  check(
    '返回值是结构化结果，且路径**不带** `\\?\` 前缀',
    /"path":"[A-Za-z]:/.test(longPath),
    String(longPath).slice(0, 160),
  )
}

// ---- 只读文件覆盖保存（走完整 UI）
const roPath = join(SRC_DIR, 'readonly-src.pdf')
// 上一轮可能留下只读文件 —— 先恢复可写再删
await chmod(roPath, 0o666).catch(() => {})
await rm(roPath, { force: true }).catch(() => {})
await copyFile(PDF, roPath)
// Node 在 Windows 上就是靠写位来表示"只读"
await chmod(roPath, 0o444)
const roModeBefore = (await stat(roPath)).mode
check('测试用副本已经设成只读', (roModeBefore & 0o200) === 0, (roModeBefore & 0o777).toString(8))

await evaluate(`
  localStorage.setItem('epl:file-list', JSON.stringify([
    { name: 'readonly-src.pdf', path: ${JSON.stringify(roPath)}, kind: 'file' },
  ]));
`)
// saveDir 故意塞成老版本那种带 `\\?\` 的脏值 —— 前端要能洗干净再显示/使用
await writeSettings({ saveDir: '\\\\?\\' + SAVE_DIR })
await send('Page.reload')
await sleep(2600)

// 顺手验一下"旧数据里的 \\?\ 会被洗干净再显示"
await evaluate(clickByTidExpr('设置'))
await sleep(700)
const shownDir = await evaluate(`(document.querySelector('.dir-path') || {}).textContent || ''`)
check(
  '设置里显示的是干净路径（没有 `\\?\` 前缀）',
  !!shownDir && !String(shownDir).includes(String.fromCharCode(92, 92, 63, 92)),
  String(shownDir),
)

check('从文件列表打开了只读那份', await openFromList('readonly-src'))
await evaluate(clickByTidExpr('手写'))
await sleep(250)
await drawInkAt()
await evaluate(clickByTidExpr('保存批注'))
const toastRo = await waitToast(/已覆盖/)
check('只读原文件也**保存成功**了', /已覆盖/.test(toastRo), toastRo.replace(/\s+/g, ' ').slice(0, 120))
check(
  '提示里说清了"原文件是只读的，已取消只读"',
  /取消只读/.test(toastRo),
  toastRo.replace(/\s+/g, ' ').slice(0, 120),
)
check(
  '提示里的路径也是干净的',
  !toastRo.includes(String.fromCharCode(92, 92, 63, 92)),
)
const roModeAfter = (await stat(roPath)).mode
check(
  '只读属性真的被取消了（否则下次还会失败一次）',
  (roModeAfter & 0o200) !== 0,
  (roModeAfter & 0o777).toString(8),
)
check(
  '内容确实写进去了（批注数 +1）',
  (await countAnnots(roPath)) === (await countAnnots(PDF)) + 1,
  `${await countAnnots(PDF)} → ${await countAnnots(roPath)}`,
)

// ---------------------------------------------------------------- 8. 控制台
console.log('\n[8] 控制台')
const realErrors = errors.filter((e) => !/favicon/i.test(e))
check(
  '没有未捕获异常 / error',
  realErrors.length === 0,
  realErrors.slice(0, 3).join(' | ') || '干净',
)

/*
 * ---- 6f. 点 ✕ 关窗口时的未保存拦截（**刻意放最后**）
 *
 * 用户报的："做了批注没有保存时没有弹出未保存警告"。
 * 根因：桌面端关窗口走 Tauri 的 CloseRequested → 直接销毁 webview，
 * **不保证**跑页面里的 `beforeunload`。必须显式 `win.onCloseRequested()` 拦。
 *
 * 🔴 这一段之后**不能再有任何页面操作**：
 *    确认框走 Tauri 的原生 dialog（`plugin-dialog` 的 ask），在 Windows 上是
 *    主线程的模态 MessageBox —— 它一弹出来，WebView 的 JS 消息循环就停了，
 *    CDP 的 `Runtime.evaluate` 永远不返回（第一次跑就是在这里把后面全卡死的）。
 *    所以判据只能用**浏览器级**的 `Target.getTargets`，它不经过页面。
 *
 *    反过来说，这也解释了用户报的另一半："点了 ✕ 像死机" —— 以前用
 *    `window.confirm` 是**同样**的效果（页面 JS 整段阻塞）。
 */
console.log('\n[6f] 点 ✕ 关窗口：未保存的批注要拦一下')
// 先回到一个干净状态（上一段结束时工具/面板/批注都攒了一堆历史，
// 直接接着画容易受它们影响；reload 一次最省事）
await send('Page.reload')
await sleep(2600)
check('重新打开只读那份（本次直接用原文件）', await openFromList('readonly-src'))
await evaluate(clickByTidExpr('批注'))
await sleep(320)
await evaluate(clickByTidExpr('手写'))
await sleep(260)
await drawInkAt()
check(
  '现在有未保存的批注（前提）',
  await evaluate(`!!document.querySelector('[data-tid="unsaved"]')`),
)

await evaluate(`document.querySelector('[data-tid="win-close"]')?.click()`)
await sleep(2000)
const alive = await Promise.race([
  send('Target.getTargets')
    .then((t) => (t.targetInfos ?? []).some((x) => x.type === 'page'))
    .catch(() => false),
  sleep(6000).then(() => null),
])
check(
  '点 ✕ 被拦下来了（窗口还在 → 说明弹了"还有批注没保存，确定关闭吗"）',
  alive === true,
  alive === null ? '连浏览器级命令都没响应' : alive === false ? '窗口直接被关掉了' : '',
)

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
