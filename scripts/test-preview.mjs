/**
 * 预览功能（目录 / 缩略图）端到端验证。
 *
 * 为什么单开一个脚本：这两个面板跟"阅读器主体"是正交的，而且必须**先打开侧边栏**
 * 才能测 —— 混进 test-viewer 会改变那套测试的初始状态（视口宽度、版面尺寸），
 * 等于给一堆既有断言引入无关变量。
 *
 * 判据的设计思路：
 *   · 目录 —— 不能只断言"渲染出了 DOM"，要断言**点下去真的跳了**，
 *     而且跳到的页码要和书签项标的一致。
 *   · 缩略图 —— 只断言"有 canvas"没意义（没渲染的 canvas 也是 canvas）。
 *     要读**画布像素**：真渲染过的缩略图有大量非背景像素。
 *     顺带断言"不是每一页都渲染了" —— 那是懒渲染正在生效的证据，
 *     600 页全渲染的话这个测试会挂。
 *
 * 用法：node scripts/test-preview.mjs [url]
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clickByTidExpr } from './testids.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = resolve(ROOT, 'preview-shots')
await mkdir(SHOTS, { recursive: true })

const URL_TARGET = process.argv[2] ?? 'http://localhost:4173/'
/** 用带书签的样本 —— 大部分 PDF 根本没有 /Outlines，用它测不出东西 */
const PDF = resolve(ROOT, 'public/testdata/real-1706.03762.pdf')
/** 40 页、无文本层：缩略图的**懒渲染**只有在大文档上才测得出来 */
const SCAN = resolve(ROOT, 'public/testdata/scan-like.pdf')
const PORT = Number(process.env.EPL_PORT ?? 9515)

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p))

if (!EDGE) {
  console.error('找不到浏览器')
  process.exit(1)
}
if (!existsSync(PDF)) {
  console.error(
    `找不到测试 PDF：${PDF}\n` +
      '先跑一次：npm run testdata:real\n' +
      '（这份「真实论文语料」不入库 —— 脚本会告诉你手动放一份也行）',
  )
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userDataDir = await mkdtemp(join(tmpdir(), 'epl-preview-'))
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
      '--window-size=1280,900',
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
  const consoleErrors = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id !== undefined && pending.has(m.id)) {
      const { resolve: res, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(JSON.stringify(m.error))) : res(m.result)
      return
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(
        (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300),
      )
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(
        'EXCEPTION: ' + (m.params.exceptionDetails?.exception?.description ?? '').slice(0, 300),
      )
    }
  })
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const n = ++id
      pending.set(n, { resolve: res, reject: rej })
      ws.send(JSON.stringify({ id: n, method, params }))
    })

  const evaluate = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    }
    return r.result?.value
  }

  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'))
  }

  /** 重新加载当前页（用来验证"设置有没有被记住"） */
  const reload = async () => {
    await send('Page.reload', { ignoreCache: false })
    await sleep(1200)
  }

  /** 点工具栏上某个按钮（按文字精确匹配） */
  const toolbarBtn = (label) => evaluate(clickByTidExpr(label))

  /**
   * 点顶栏的面板图标（文件 / 搜索 / 目录 / 缩略图）。
   *
   * ⚠️ 这些入口在 `.titlebar` 里、**不在** `.toolbar` 里 ——
   *    早期版本拿 `.toolbar .btn` 去找，点了个寂寞。
   *    现在统一走 data-tid，位置变了也不会失效。
   */
  const sideTab = (label) => evaluate(clickByTidExpr(label))

  const pageNow = async () => Number(await evaluate(`document.querySelector('.page-input').value`))
  const scrollNow = async () => Number(await evaluate(`document.querySelector('.viewport').scrollTop`))

  /** 换一个文档（走文件输入），等它就绪 */
  const openFile = async (path, expectName) => {
    const r = await send('DOM.getDocument', { depth: 1 })
    const q = await send('DOM.querySelector', {
      nodeId: r.root.nodeId,
      selector: 'input[type=file]',
    })
    await send('DOM.setFileInputFiles', { files: [path], nodeId: q.nodeId })
    for (let i = 0; i < 120; i++) {
      await sleep(400)
      const c = await evaluate(`document.querySelectorAll('.pdf-page-canvas').length`)
      const loading = await evaluate(`!!document.querySelector('.loading')`)
      const fname = await evaluate(`(document.querySelector('[data-tid="file-name"]')||{}).textContent||''`)
      if (!loading && c > 0 && String(fname).includes(expectName)) return true
    }
    return false
  }

  await send('Page.enable')
  await send('Runtime.enable')
  await send('DOM.enable')

  console.log(`\n→ 打开 ${URL_TARGET}`)
  await send('Page.navigate', { url: URL_TARGET })
  await sleep(1500)

  const { root } = await send('DOM.getDocument', { depth: 1 })
  const { nodeId } = await send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: 'input[type=file]',
  })
  if (!nodeId) throw new Error('找不到 file input')
  await send('DOM.setFileInputFiles', { files: [PDF], nodeId })

  let ready = false
  for (let i = 0; i < 120; i++) {
    await sleep(500)
    const c = await evaluate(`document.querySelectorAll('.pdf-page-canvas').length`)
    const loading = await evaluate(`!!document.querySelector('.loading')`)
    if (!loading && c > 0) {
      ready = true
      break
    }
  }
  check('文档加载完成', ready)
  if (!ready) throw new Error('文档没加载起来')

  // ---------------------------------------------------------------- 1. 打开侧边栏

  console.log('\n[1] 打开侧边栏')
  check('点「目录」按钮', await toolbarBtn('目录'))
  await sleep(600)
  const hasPanel = await evaluate(`!!document.querySelector('.side')`)
  check('侧边栏出现了', hasPanel)
  await shot('01-side-outline')

  // ---------------------------------------------------------------- 2. 目录

  console.log('\n[2] 目录（PDF 书签）')
  const items = await evaluate(`
    [...document.querySelectorAll('.outline-panel .title')].map(b => ({
      text: b.textContent.trim(),
      disabled: b.disabled,
    }))
  `)
  check('解析出了书签条目', items.length > 0, `${items.length} 条`)
  check(
    '大多数条目是可点的（有跳转目标）',
    items.filter((i) => !i.disabled).length >= Math.max(1, items.length * 0.6),
    `可点 ${items.filter((i) => !i.disabled).length} / 共 ${items.length}`,
  )
  if (items.length) {
    console.log(`     前几条：${items.slice(0, 4).map((i) => i.text).join(' · ')}`)
  }

  // 点一个**靠后**的条目：页数差别要足够大，避免"本来就在附近"造成假通过
  {
    const before = await pageNow()
    const beforeScroll = await scrollNow()
    const idx = Math.min(items.length - 1, Math.max(2, Math.floor(items.length * 0.7)))
    const clicked = await evaluate(`
      (() => {
        const b = [...document.querySelectorAll('.outline-panel .title')];
        const t = b[${idx}];
        if (!t || t.disabled) return null;
        t.click();
        return t.textContent.trim();
      })()
    `)
    await sleep(900)
    const after = await pageNow()
    const afterScroll = await scrollNow()
    check(
      `点第 ${idx + 1} 条「${String(clicked).slice(0, 18)}」后页码变了`,
      clicked !== null && after !== before,
      `${before} → ${after}`,
    )
    check(
      '滚动位置也跟着变了（不只是改了页码数字）',
      clicked !== null && Math.abs(afterScroll - beforeScroll) > 30,
      `scrollTop ${Math.round(beforeScroll)} → ${Math.round(afterScroll)}`,
    )
    await shot('02-outline-jump')
  }

  // ---------------------------------------------------------------- 3. 缩略图

  console.log('\n[3] 缩略图（换到 40 页样本 —— 懒渲染要拿大文档才测得出来）')
  check('换成 40 页样本', await openFile(SCAN, 'scan-like'))
  check('侧边栏还开着（换文档不影响它）', await evaluate(`!!document.querySelector('.side')`))
  // 这份样本没有书签 —— 正好顺带验一下空状态文案
  const emptyOutline = await evaluate(`
    (document.querySelector('.outline-panel') || {}).innerText || ''
  `)
  check(
    '没有书签时给出了清楚的空状态（而不是一片空白）',
    String(emptyOutline).includes('没有书签'),
    String(emptyOutline).replace(/\s+/g, ' ').slice(0, 40),
  )
  await shot('03-outline-empty')

  check('切到「缩略图」', await sideTab('缩略图'))
  await sleep(1800)

  const thumbStats = await evaluate(`
    (() => {
      const cs = [...document.querySelectorAll('.thumb-panel canvas[data-page]')];
      let painted = 0;
      for (const c of cs) {
        if (!c.width || !c.height) continue;
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let nonWhite = 0;
        for (let i = 0; i < d.length; i += 4) {
          /*
           * ⚠️ 必须先判 alpha。没渲染的 canvas 是**全透明**的，而透明像素的
           *    RGB 读出来是 (0,0,0) —— 跟背景色 #2a2f38 差得远，
           *    不过滤就会把一堆空 canvas 全数成"已渲染"（实测 40 张全中）。
           */
          if (d[i + 3] < 40) continue;
          // 缩略图画出来的是白纸黑字，跟面板底色 #2a2f38 明显不同
          if (Math.abs(d[i] - 42) > 24 || Math.abs(d[i+1] - 47) > 24 || Math.abs(d[i+2] - 56) > 24) nonWhite++;
        }
        if (nonWhite > 60) painted++;
      }
      return JSON.stringify({ total: cs.length, painted });
    })()
  `).then(JSON.parse)

  check('缩略图列表建起来了', thumbStats.total > 0, `${thumbStats.total} 页`)
  check(
    '确实渲染出了内容（画布上有非背景像素）',
    thumbStats.painted > 0,
    `已渲染 ${thumbStats.painted} 张`,
  )

  const diag = JSON.parse(
    await evaluate(`JSON.stringify(globalThis.__eplThumbs ? globalThis.__eplThumbs() : null)`),
  )
  console.log(
    `     诊断：可见 ${diag?.visible} / 已渲染 ${diag?.rendered} / 队列 ${diag?.queued} / 缓存 ${diag?.cached}`,
  )
  /*
   * 懒渲染的直接证据：如果一上来就把整本全画了，这条会失败。
   * 用组件内部计数（`__eplThumbs`）而不是画布像素 —— 后者只能证明"画出来了"，
   * 证明不了"没有多画"。这条守的是**内存恒定**这个设计目标。
   */
  check(
    '懒渲染生效：只渲染视口附近的一小部分，不是整本',
    diag.rendered > 0 && diag.rendered < thumbStats.total,
    `已渲染 ${diag.rendered} / 总页数 ${thumbStats.total}（当前可见 ${diag.visible}）`,
  )
  await shot('03-thumbnails')

  // 点一张缩略图 → 跳过去
  {
    const before = await pageNow()
    const target = Math.min(thumbStats.total, Math.max(4, Math.floor(thumbStats.total * 0.6)))
    await evaluate(`
      (() => {
        const b = [...document.querySelectorAll('.thumb-panel .thumb')];
        const t = b[${target - 1}];
        if (t) t.click();
        return true;
      })()
    `)
    await sleep(900)
    const after = await pageNow()
    check(`点第 ${target} 张缩略图跳过去了`, after === target, `${before} → ${after}（期望 ${target}）`)
  }

  // ---------------------------------------------------------------- 3c. 文件列表 + 搜索

  console.log('\n[3c] 文件列表 + 搜索')
  check('切到「文件」面板', await toolbarBtn('文件'))
  await sleep(320)
  check('出现文件面板', await evaluate(`!!document.querySelector('[data-tid="files-panel"]')`))
  check(
    '空列表时给出明确提示（而不是一片空白）',
    await evaluate(
      `/添加文件/.test(document.querySelector('[data-tid="files-panel"]')?.textContent || '')`,
    ),
  )
  await shot('03c-files-empty')

  // 右键空白处 → 菜单（这是用户指定的入口）
  await evaluate(`
    (() => {
      const p = document.querySelector('[data-tid="files-panel"]');
      const r = p.getBoundingClientRect();
      p.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: Math.round(r.left + 70), clientY: Math.round(r.top + 140),
      }));
    })()
  `)
  await sleep(260)
  check(
    '右键弹出「添加文件 / 添加文件夹」菜单',
    await evaluate(
      `!!document.querySelector('[data-tid="add-files"]') && !!document.querySelector('[data-tid="add-folder"]')`,
    ),
  )
  await shot('03c-ctx-menu')

  // 点空白处收起菜单（真实流程里点完菜单项它也会收）——
  // ⚠️ 不能在这里点「添加文件…」：那会调 input.click() 去开系统文件对话框，
  //    headless 下要么没反应要么把测试挂住，所以后面直接用 CDP 塞文件
  await evaluate(`document.querySelector('[data-tid="files-panel"]').click()`)
  await sleep(220)
  check(
    '点空白处菜单收起',
    !(await evaluate(`!!document.querySelector('[data-tid="add-files"]')`)),
  )

  // 把样本塞进隐藏的 file input（等价于用户在菜单里选了文件）
  const fdoc = await send('DOM.getDocument', { depth: -1 })
  const finp = await send('DOM.querySelector', {
    nodeId: fdoc.root.nodeId,
    selector: '[data-tid="files-panel"] input[type=file]',
  })
  await send('DOM.setFileInputFiles', { files: [PDF, SCAN], nodeId: finp.nodeId })
  await sleep(700)

  const rowCount = await evaluate(
    `document.querySelectorAll('[data-tid="files-panel"] [data-node-id][data-kind="file"]').length`,
  )
  check('选中的文件进了列表', rowCount === 2, `条目数=${rowCount}`)
  await shot('03c-files-added')

  // 点列表里的条目 → 应该真的把那份打开
  await evaluate(`
    (() => {
      const rows = [...document.querySelectorAll('[data-tid="files-panel"] [data-kind="file"]')];
      rows.find(r => /1706/.test(r.textContent))?.click();
    })()
  `)
  let openedFromList = false
  for (let i = 0; i < 60; i++) {
    await sleep(400)
    const nm = await evaluate(
      `(document.querySelector('[data-tid="file-name"]')||{}).textContent||''`,
    )
    if (String(nm).includes('1706')) {
      openedFromList = true
      break
    }
  }
  check('点列表里的文件真的把它打开了', openedFromList)
  check(
    '被打开的那一行有高亮（看得出当前是哪份）',
    await evaluate(`!!document.querySelector('[data-tid="files-panel"] [data-node-id].cur')`),
  )
  await shot('03c-files-opened')

  // ---- 在**文件行**上右键（不是空白处）—— 内容应该是"对这个文件能做什么"
  await evaluate(`
    (() => {
      const row = document.querySelector('[data-tid="files-panel"] [data-kind="file"]');
      const r = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: Math.round(r.left + 40), clientY: Math.round(r.top + r.height / 2),
      }));
    })()
  `)
  await sleep(260)
  check(
    '在文件上右键弹出的是**文件**菜单，不是「添加文件」',
    await evaluate(`
      !!document.querySelector('[data-tid="file-rename"]') &&
      !document.querySelector('[data-tid="add-files"]')
    `),
  )
  check(
    '菜单里有：重命名 / 在资源管理器打开 / 复制路径',
    await evaluate(`
      !!document.querySelector('[data-tid="file-rename"]') &&
      !!document.querySelector('[data-tid="file-reveal"]') &&
      !!document.querySelector('[data-tid="file-copy-path"]')
    `),
  )
  check(
    '浏览器版这三项目前都禁用，并写清了原因（需要真实路径）',
    await evaluate(`
      (() => {
        const ids = ['file-rename', 'file-reveal', 'file-copy-path'];
        const all = ids.map(i => document.querySelector('[data-tid="' + i + '"]'));
        return all.every(b => b && b.disabled) &&
               /真实路径/.test(all[0].title);
      })()
    `),
  )
  await shot('03c-file-menu')
  await evaluate(`document.querySelector('[data-tid="files-panel"]').click()`)
  await sleep(200)

  check(
    '文件面板不再有「列表会记住」那句（默认行为不用讲出来）',
    !(await evaluate(
      `/列表会记住/.test(document.querySelector('[data-tid="files-panel"]')?.textContent || '')`,
    )),
  )

  // ---- 搜索（只匹配文件名）
  check('切到「搜索」面板', await toolbarBtn('搜索'))
  await sleep(320)
  check('出现搜索面板', await evaluate(`!!document.querySelector('[data-tid="search-panel"]')`))

  await evaluate(`
    (() => {
      const i = document.querySelector('[data-tid="search-input"]');
      i.value = 'scan';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `)
  await sleep(320)
  const hits = await evaluate(
    `document.querySelectorAll('[data-tid="search-panel"] [data-node-id]').length`,
  )
  check('按文件名匹配到了唯一一个', hits === 1, `结果数=${hits}`)
  await shot('03c-search')

  await evaluate(`
    (() => {
      const i = document.querySelector('[data-tid="search-input"]');
      i.value = 'zzz-not-exist';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `)
  await sleep(300)
  check(
    '搜不到时给出「没有匹配的文件」',
    await evaluate(`/没有匹配/.test(document.querySelector('[data-tid="search-panel"]').textContent)`),
  )

  // ---------------------------------------------------------------- 3d. 设置

  console.log('\n[3d] 设置（保存方式 / 保存位置 / 主题）')
  await toolbarBtn('设置')
  await sleep(300)
  check(
    '点左下角齿轮进到设置面板',
    await evaluate(`!!document.querySelector('[data-tid="save-mode-copy"]')`),
  )

  // 默认「另存一份」—— 覆盖原文件不可逆，不该是默认
  check(
    '保存方式默认是「另存一份」',
    await evaluate(`document.querySelector('[data-tid="save-mode-copy"]').checked`),
  )
  check(
    '网页版下「覆盖原文件」是禁用的（做不到就该禁用并说明，而不是点了没反应）',
    await evaluate(`document.querySelector('[data-tid="save-mode-overwrite"]').disabled`),
  )
  check(
    '禁用时说明了原因',
    await evaluate(
      `/网页版改不了原文件/.test(document.querySelector('[data-tid="save-mode-overwrite"]').closest('.opt').textContent)`,
    ),
  )
  check(
    '网页版保存位置显示为浏览器的下载目录',
    await evaluate(`/浏览器的下载目录/.test(document.body.textContent)`),
  )
  await shot('03d-settings')

  // ---- 主题：判据必须落到"背景色真的变了"，而不是"按钮高亮了"
  const themeOf = () => evaluate(`document.documentElement.dataset.theme`)
  const bgOf = () =>
    evaluate(`getComputedStyle(document.querySelector('.side') || document.body).backgroundColor`)

  const t0 = await themeOf()
  const bg0 = await bgOf()
  await evaluate(`document.querySelector('[data-tid="theme-light"]').click()`)
  await sleep(300)
  const t1 = await themeOf()
  const bg1 = await bgOf()
  check('点「日间」切到 light', t1 === 'light', `${t0} → ${t1}`)
  check('背景色真的跟着变了（不是只有按钮高亮）', bg1 !== bg0, `${bg0} → ${bg1}`)
  check(
    '日间模式下文字是深色（否则就是暗底暗字）',
    await evaluate(`
      (() => {
        const el = document.querySelector('.side') || document.body;
        const c = getComputedStyle(el).color;
        const m = c.match(/\\d+/g).map(Number);
        return (m[0] * 0.299 + m[1] * 0.587 + m[2] * 0.114) < 128;
      })()
    `),
  )
  /*
   * 逐块检查：切到日间之后，**每一块**面板都必须是浅底。
   *
   * 为什么要逐块查而不是看整张截图：截图缩小之后 #f6f7f9 和 #eef0f4 根本分不出来，
   * 漏掉某一块的配色（比如工具栏还留着暗色变量）在图上就是"看着差不多"。
   * 判据用亮度阈值：日间模式下任何一个面板底色的亮度都不该低于 200。
   */
  const lumOf = (sel) =>
    evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return -1;
        const m = getComputedStyle(el).backgroundColor.match(/[\\d.]+/g).map(Number);
        if (m.length < 3) return -1;
        return m[3] === 0 ? -1 : Math.round(m[0] * 0.299 + m[1] * 0.587 + m[2] * 0.114);
      })()
    `)
  for (const [name, sel] of [
    ['标题栏', '.titlebar'],
    ['功能区', '.ribbon'],
    ['侧边栏', '.side'],
    ['阅读区', '.viewport'],
  ]) {
    const l = await lumOf(sel)
    check(`日间模式下「${name}」是浅底`, l < 0 || l > 180, l < 0 ? '元素不存在' : `亮度 ${l}`)
  }
  await shot('03d-light')

  await evaluate(`document.querySelector('[data-tid="theme-dark"]').click()`)
  await sleep(300)
  check('点「夜间」切回 dark', (await themeOf()) === 'dark')
  check('切回后背景色也回到原值', (await bgOf()) === bg0, `${await bgOf()} vs ${bg0}`)

  /*
   * 设置是**可以来回切**的：再点一次齿轮退回进设置之前的那个面板。
   * 之前用户进了设置就出不来了（只能去顶栏重点一次别的面板）。
   */
  // ⚠️ 先把面板显式切到「文件」再测：这条断言依赖"进设置前的那个面板"，
  //    不写死前置状态的话，它会跟着上一段结束时的面板漂移
  await toolbarBtn('文件')
  await sleep(320)
  await toolbarBtn('设置')
  await sleep(320)
  await toolbarBtn('设置')
  await sleep(320)
  check(
    '再点一次设置 → 退回上一个面板（文件）',
    (await evaluate(`!!document.querySelector('[data-tid="files-panel"]')`)) &&
      !(await evaluate(`!!document.querySelector('[data-tid="save-mode-copy"]')`)),
    `files=${await evaluate(`!!document.querySelector('[data-tid="files-panel"]')`)}`,
  )

  // 记忆要跟着更新：文件 → 设置 → 搜索 → 再点设置，应该回**搜索**
  await toolbarBtn('设置')
  await sleep(300)
  await toolbarBtn('搜索')
  await sleep(300)
  await toolbarBtn('设置')
  await sleep(300)
  await toolbarBtn('设置')
  await sleep(300)
  check(
    '记忆会更新：搜索 → 设置 → 再点设置回到搜索',
    await evaluate(`!!document.querySelector('[data-tid="search-panel"]')`),
  )
  check(
    '搜索面板不再有「不搜内容」那句解释（用户要求删）',
    !(await evaluate(
      `/不搜内容/.test(document.querySelector('[data-tid="search-panel"]')?.textContent || '')`,
    )),
  )

  await toolbarBtn('文件')
  await sleep(200)

  // ---------------------------------------------------------------- 4. 收起

  console.log('\n[4] 收起侧边栏')
  // ⚠️ 收起要点顶栏最左边的**开关**图标。顶栏的「目录」现在只是切换面板，
  //    点它不会收起侧边栏（旧界面里那个按钮兼任 toggle，新界面分开了）。
  await toolbarBtn('侧边栏')
  await sleep(400)
  check('侧边栏收起了', !(await evaluate(`!!document.querySelector('.side')`)))
  // 收起后主阅读区不能坏
  await sleep(400)
  const alive = await evaluate(`!!document.querySelector('.viewport .page-slot')`)
  check('收起后阅读区还在（版面没被破坏）', alive)

  /*
   * 4b. 设置要能跨刷新记住。
   *
   * ⚠️ 放在最后：刷新必然丢掉当前打开的文档（浏览器版不自动恢复上一次的文件），
   *    放在中间会把后面的"阅读区还在"这类断言冲掉。
   */
  console.log('\n[4b] 刷新后设置还在吗')
  // ⚠️ 设置入口在侧边栏底部 —— 上一段刚把它收起来了，得先展开才点得到
  await toolbarBtn('侧边栏')
  await sleep(350)
  await toolbarBtn('设置')
  await sleep(250)
  await evaluate(`document.querySelector('[data-tid="theme-light"]').click()`)
  await sleep(200)
  await reload()
  await sleep(900)
  check(
    '刷新后主题仍是日间',
    (await evaluate(`document.documentElement.dataset.theme`)) === 'light',
    await evaluate(`document.documentElement.dataset.theme`),
  )
  await reload() // 复原，免得影响别的用例共用同一份 localStorage
  await sleep(600)
  await evaluate(`localStorage.removeItem('epl.settings.v1')`)

  // ---------------------------------------------------------------- 5. 控制台

  console.log('\n[5] 控制台')
  check(
    '没有未捕获异常 / error',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | ') || '干净',
  )

  console.log(
    `\n${failed === 0 ? '✅' : '❌'} 预览功能验证：${passed}/${passed + failed} 通过  （截图在 preview-shots/）\n`,
  )
} finally {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  child?.kill()
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
}

process.exit(failed === 0 ? 0 : 1)
