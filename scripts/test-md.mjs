/**
 * Markdown 阅读通道的端到端验证（浏览器版）。
 *
 * 覆盖：
 *   1. 打开 / 渲染（GFM 表格、任务列表、删除线、代码块、标题）
 *   2. 界面能力矩阵：Markdown 下**没有**批注/页码/单双页/缩略图/保存
 *   3. 字号缩放：真的重排、不产生整页横向滚动、上下限
 *   4. 大纲跳转 + 当前标题高亮
 *   5. 安全：原始 HTML 不执行、恶意链接不落地、越界/远程图片不加载
 *   6. 阅读位置记忆：换一篇再换回来能回到原处
 *   7. 「转 PDF 后批注」说明框
 *   8. PDF 回归冒烟：新分流没把 PDF 那条路弄坏
 *   9. 2 MB 大文件的首屏耗时（记录，不做主观判断）
 *
 * 用法：
 *   1) npm run build
 *   2) npm run serve:dist        （另开一个终端）
 *   3) node scripts/test-md.mjs
 *
 * ⚠️ 判据都要"有牙"：不能只断言"没有报错"——
 *    页面整个白屏时错误数也是 0。所以每条都要求**看得见的证据**
 *    （元素数量、字号真的变了、滚动位置真的动了）。
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TID } from './testids.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = resolve(ROOT, 'md-shots')
await mkdir(SHOTS, { recursive: true })

const URL_TARGET = process.argv[2] ?? 'http://localhost:4173/'
const MD_BASIC = resolve(ROOT, 'public/testdata/md-basic.md')
const MD_UNSAFE = resolve(ROOT, 'public/testdata/md-unsafe.md')
const MD_LARGE = resolve(ROOT, 'public/testdata/md-large.md')
const PDF = resolve(ROOT, 'public/testdata/sample-text-20p.pdf')
const PORT = Number(process.env.EPL_MD_PORT ?? 9521)

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
  [MD_BASIC, '先跑一次：npm run testdata:local（或 node scripts/make-md-testdata.mjs）'],
  [MD_UNSAFE, '先跑一次：node scripts/make-md-testdata.mjs'],
  [MD_LARGE, '先跑一次：node scripts/make-md-testdata.mjs'],
  [PDF, '先跑一次：npm run testdata:local'],
]) {
  if (!existsSync(p)) {
    console.error(`找不到 ${p}\n${hint}`)
    process.exit(1)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userDataDir = await mkdtemp(join(tmpdir(), 'epl-md-'))
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
    // 未保存批注的确认框会挂住 CDP（见 test-viewer.mjs 的说明）
    if (m.method === 'Page.javascriptDialogOpening') {
      send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {})
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

  /** 通过 App 的隐藏 input 打开一个文件（浏览器版的唯一入口） */
  async function openViaInput(path) {
    const { root } = await send('DOM.getDocument', { depth: -1 })
    const { nodeId } = await send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: `input[data-tid="${TID.openInput ?? 'open-input'}"]`,
    })
    if (!nodeId) throw new Error('找不到打开文件的 input')
    await send('DOM.setFileInputFiles', { files: [path], nodeId })
  }

  /** 等"这份文档真的画到界面上"（不是等一个固定的 sleep） */
  async function waitMd(headings = 1, attempts = 60) {
    for (let i = 0; i < attempts; i++) {
      const st = await evaluate(`(() => {
        const v = document.querySelector('[data-tid="${TID.mdViewer}"]');
        if (!v) return null;
        return {
          headings: Number(v.dataset.mdHeadings || 0),
          h: document.querySelectorAll('.md-body h1,.md-body h2,.md-body h3').length,
          busy: !!document.querySelector('.overlay'),
        };
      })()`)
      if (st && !st.busy && st.headings >= headings && st.h > 0) return st
      await sleep(120)
    }
    return null
  }

  async function click(tid) {
    return evaluate(`(() => {
      const b = document.querySelector('[data-tid="${tid}"]');
      if (!b) return false;
      b.click();
      return true;
    })()`)
  }

  await send('Runtime.enable')
  await send('Page.enable')
  await send('DOM.enable')

  console.log(`→ 打开 ${URL_TARGET}`)
  await send('Page.navigate', { url: URL_TARGET })
  await sleep(1500)

  // ---------------------------------------------------------------- 1. 打开与渲染
  console.log('\n[1] 打开 md-basic.md 并渲染')
  const t0 = Date.now()
  await openViaInput(MD_BASIC)
  const st = await waitMd(5)
  check('Markdown 阅读器出现了', !!st, `${Date.now() - t0} ms`)
  check('提取到标题（大纲有内容）', (st?.headings ?? 0) >= 5, `headings=${st?.headings}`)

  const render = JSON.parse(
    await evaluate(`(() => {
      const b = document.querySelector('.md-body');
      const cs = getComputedStyle(b);
      return JSON.stringify({
        h1: b.querySelector('h1')?.textContent ?? '',
        h2count: b.querySelectorAll('h2').length,
        table: b.querySelectorAll('table').length,
        tableWrap: b.querySelectorAll('.md-table-wrap').length,
        task: b.querySelectorAll('.md-task').length,
        taskOn: b.querySelectorAll('.md-task.on').length,
        inputLeft: b.querySelectorAll('input').length,
        // markdown-it 的 ~~x~~ 输出 <s>，不是 GFM 文档里写的 <del> —— 两个都认
        del: b.querySelectorAll('del,s').length,
        pre: b.querySelectorAll('pre').length,
        quote: b.querySelectorAll('blockquote').length,
        extLinks: b.querySelectorAll('a[data-md-href]').length,
        anchorLinks: b.querySelectorAll('a.md-anchor').length,
        // 中文标题必须拿到可用的 id（不然 #锚点 跳不过去）
        cnId: [...b.querySelectorAll('h2')].map(h => h.id).find(x => /标|表|列/.test(x)) ?? '',
        fontSize: parseFloat(cs.fontSize),
        headingsIds: [...b.querySelectorAll('h1,h2,h3')].every(h => !!h.id),
      });
    })()`),
  )
  check('h1 文字正确', render.h1.includes('多格式阅读器'), render.h1)
  check('表格 + 滚动容器都在', render.table === 1 && render.tableWrap === 1)
  check('任务列表变成 span（没有 input 留在正文）', render.task === 3 && render.taskOn === 2 && render.inputLeft === 0, `task=${render.task} on=${render.taskOn} input=${render.inputLeft}`)
  check('删除线 / 代码块 / 引用都渲染了', render.del === 1 && render.pre === 1 && render.quote === 1)
  check('外链被标成受控链接（data-md-href）', render.extLinks >= 2, `ext=${render.extLinks}`)
  check('站内锚点链保留为 .md-anchor', render.anchorLinks >= 1)
  check('所有标题都有 id（含中文）', render.headingsIds && render.cnId !== '', `id=${render.cnId}`)

  // 代码高亮：dynamic chunk 要拉一下，轮询等它落地
  let hl = { kw: 0, text: '', script: 0, nolang: false }
  for (let i = 0; i < 50; i++) {
    hl = JSON.parse(
      await evaluate(`(() => {
        const code = document.querySelector('.md-body pre code');
        const text = code ? (code.textContent || '') : '';
        return JSON.stringify({
          kw: code ? code.querySelectorAll('.hljs-keyword').length : 0,
          text,
          script: document.querySelectorAll('.md-body pre script').length,
          nolang: [...document.querySelectorAll('.md-body pre code')].some(
            (c) => !c.classList.contains('hljs'),
          ),
        });
      })()`),
    )
    if (hl.kw > 0) break
    await sleep(150)
  }
  check('代码块真的被高亮了（有 token span）', hl.kw >= 2, `keyword span=${hl.kw}`)
  check('高亮不改变代码文本', hl.text.includes('function demo'), hl.text.slice(0, 40))
  /*
   * 背景结构（日间，用户定的）：**整个阅读区都是白的**，只有代码块是浅灰。
   * 🔴 颜色判据读**计算样式**，不靠眼睛 —— 第一版 Markdown 直接铺在 PDF 的
   *    灰底（--viewport-bg）上，整片都是灰的。
   */
  const surfaces = JSON.parse(
    await evaluate(`(() => {
      const root = document.documentElement;
      const prev = root.dataset.theme;
      root.dataset.theme = 'light';
      const page = getComputedStyle(document.querySelector('.md-page')).backgroundColor;
      const view = getComputedStyle(document.querySelector('[data-tid="md-viewer"]')).backgroundColor;
      const pre = document.querySelector('.md-body pre');
      const code = pre ? getComputedStyle(pre).backgroundColor : '';
      root.dataset.theme = prev;
      return JSON.stringify({ page, view, code });
    })()`),
  )
  check(
    '日间：阅读区是白的（左右不露灰边），代码块是浅灰',
    surfaces.page === 'rgb(255, 255, 255)' &&
      surfaces.view === 'rgb(255, 255, 255)' &&
      surfaces.code === 'rgb(238, 240, 243)',
    JSON.stringify(surfaces),
  )

  check(
    '浏览器版本地图片：占位是**可点的授权入口**（不再是"仅桌面版"死文案）',
    await evaluate(`(() => {
      const el = document.querySelector('[data-md-need-pick]');
      return !!el &&
        el.classList.contains('pickable') &&
        /文件夹/.test(el.textContent || '') &&
        !/仅桌面版/.test(el.textContent || '');
    })()`),
  )
  check('远程图片不加载（占位 + 无 img）', await evaluate(`document.querySelectorAll('.md-body img').length === 0`))

  // ---------------------------------------------------------------- 1b. 浏览器本地图片（File System Access）
  console.log('\n[1b] 浏览器本地图片：授权文件夹后真的显示')
  /*
   * 无头浏览器弹不了真实的目录选择框，但 **OPFS**（Origin Private File System）
   * 的根句柄和"用户选到的目录句柄"是**同一个接口**：把样本 PNG 写进 OPFS、
   * 把 showDirectoryPicker 换成"返回这个根"的桩，就能用**真代码路径**走完
   * 选目录 → 解析相对路径 → Blob → <img> 的全程（没有为测试开任何后门）。
   */
  const wrote = await evaluate(`(async () => {
    try {
      const res = await fetch('/testdata/md-assets/diagram.png');
      const buf = await res.arrayBuffer();
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('md-assets', { create: true });
      const f = await dir.getFileHandle('diagram.png', { create: true });
      const w = await f.createWritable();
      await w.write(buf);
      await w.close();
      window.showDirectoryPicker = async () => root;
      return true;
    } catch (e) {
      return false;
    }
  })()`)
  check('测试环境就绪（样本写入 OPFS + 选择器打桩）', wrote)

  // lazy 图片不在视口就不解码 —— 先滚过去再点
  await evaluate(`document.querySelector('[data-md-need-pick]')?.scrollIntoView({ block: 'center' })`)
  await sleep(300)
  await evaluate(`document.querySelector('[data-md-need-pick]')?.click()`)
  let browserImg = { ok: false, w: 0, src: '' }
  for (let i = 0; i < 40; i++) {
    browserImg = JSON.parse(
      await evaluate(`(() => {
        const img = document.querySelector('.md-body img');
        return JSON.stringify({
          ok: !!img,
          w: img ? img.naturalWidth : 0,
          src: img ? (img.src.startsWith('blob:') ? 'blob:' : img.src.slice(0, 24)) : '',
        });
      })()`),
    )
    if (browserImg.ok && browserImg.w > 0) break
    await sleep(150)
  }
  check('授权文件夹后本地图片显示出来', browserImg.ok && browserImg.w === 240, `${browserImg.w}px ${browserImg.src}`)
  check('图片走 Blob URL（字节来自授权目录，不是网络）', browserImg.src === 'blob:')
  await shot('01-md-basic')

  // ---------------------------------------------------------------- 2. 能力矩阵
  console.log('\n[2] 界面能力矩阵（Markdown 不该有 PDF 专属控件）')
  const absent = JSON.parse(
    await evaluate(`(() => {
      const tids = ['annot-toggle','save','unsaved','page-input','prev','next','mode-single','mode-dual','pm-select','fit-width','fit-page','undo','redo','side-thumbs'];
      const missing = tids.filter(t => !document.querySelector('[data-tid="'+t+'"]'));
      return JSON.stringify({ missing, total: tids.length, convert: !!document.querySelector('[data-tid="md-convert"]') });
    })()`),
  )
  check('批注/保存/页码/单双页/缩略图入口全部不存在', absent.missing.length === absent.total, `缺 ${absent.missing.length}/${absent.total}`)
  check('「转 PDF 后批注」入口在', absent.convert)
  check(
    '顶栏的目录提示改成了 Markdown 标题',
    /Markdown/.test(await evaluate(`document.querySelector('[data-tid="side-outline"]')?.title ?? ''`)),
  )

  // ---------------------------------------------------------------- 3. 缩放
  console.log('\n[3] 字号缩放（重排，不产生整页横向滚动）')
  const before = Number(await evaluate(`parseFloat(getComputedStyle(document.querySelector('.md-page')).fontSize)`))
  await click(TID.zoomIn)
  await sleep(250)
  const after = Number(await evaluate(`parseFloat(getComputedStyle(document.querySelector('.md-page')).fontSize)`))
  check('放大后字号真的变大了', after > before, `${before}px → ${after}px`)
  check(
    '缩放读数跟着变',
    (await evaluate(`document.querySelector('[data-tid="zoom"]')?.textContent?.trim()`)) === '110%',
    await evaluate(`document.querySelector('[data-tid="zoom"]')?.textContent?.trim()`),
  )

  // 连点到上限：250%
  for (let i = 0; i < 10; i++) {
    await click(TID.zoomIn)
    await sleep(90)
  }
  const maxPct = await evaluate(`document.querySelector('[data-tid="zoom"]')?.textContent?.trim()`)
  const hscroll = JSON.parse(
    await evaluate(`(() => {
      const v = document.querySelector('[data-tid="md-viewer"]');
      return JSON.stringify({ sw: v.scrollWidth, cw: v.clientWidth, top: v.scrollTop });
    })()`),
  )
  check('放大到 250% 封顶', maxPct === '250%', maxPct)
  check('没有整页横向滚动条', hscroll.sw <= hscroll.cw + 1, `scrollWidth=${hscroll.sw} client=${hscroll.cw}`)

  // 缩到下限：75%
  for (let i = 0; i < 12; i++) {
    await click(TID.zoomOut)
    await sleep(90)
  }
  const minPct = await evaluate(`document.querySelector('[data-tid="zoom"]')?.textContent?.trim()`)
  check('缩小到 75% 封底', minPct === '75%', minPct)
  await click(TID.zoom)
  await sleep(200)
  check(
    '点百分比回到 100%',
    (await evaluate(`document.querySelector('[data-tid="zoom"]')?.textContent?.trim()`)) === '100%',
  )
  await shot('02-md-zoom')

  // ---------------------------------------------------------------- 4. 大纲跳转
  console.log('\n[4] 标题大纲：跳转 + 跟随高亮')
  await click(TID.sideOutline)
  await sleep(300)
  const outlineCount = Number(await evaluate(`document.querySelectorAll('[data-tid="${TID.mdOutline}"] [data-heading-id]').length`))
  check('大纲列出了标题', outlineCount >= 5, `${outlineCount} 条`)

  const jumped = JSON.parse(
    await evaluate(`(() => {
      const items = [...document.querySelectorAll('[data-heading-id]')];
      // ⚠️ 必须挑**中间**的标题：文末那几个受"最大滚动量"限制，
      //    物理上就到不了视口顶部，拿它断言会得到一个永远失败的正确实现。
      const target = items.find(x => /表格/.test(x.textContent || '')) ?? items[Math.floor(items.length / 2)];
      if (!target) return JSON.stringify({ ok: false });
      const id = target.dataset.headingId;
      target.click();
      const v = document.querySelector('[data-tid="md-viewer"]');
      const el = document.getElementById(id);
      return JSON.stringify({ ok: true, id, top: v.scrollTop, elTop: el ? el.getBoundingClientRect().top : null });
    })()`),
  )
  /*
   * 跳转是平滑滚动 —— 不能只 sleep 一个固定值再断言：
   * 那样量到的是**动画中间态**（第一次跑出 elTop=98 就是这么来的），
   * 看起来像"实现跳歪了"，其实只是没滚完。
   * 所以轮询到滚动位置稳定为止。
   */
  let afterJump = { top: 0, elTop: null, scTop: 0, active: '' }
  for (let i = 0; i < 25; i++) {
    await sleep(100)
    const cur = JSON.parse(
      await evaluate(`(() => {
        const v = document.querySelector('[data-tid="md-viewer"]');
        const el = document.getElementById(${JSON.stringify(jumped.id ?? '')});
        return JSON.stringify({
          top: v.scrollTop,
          elTop: el ? el.getBoundingClientRect().top : null,
          // 容器的视口位置：标题栏 38 + 工具栏 44 = 82px。
          // ⚠️ 断言必须用**相对容器**的差值 —— 直接拿视口坐标比 0 会永远差 82px
          //    （第一次跑出 elTop=98 就是这么误判的，功能其实是对的）。
          scTop: v.getBoundingClientRect().top,
          active: document.querySelector('[data-heading-id].on')?.dataset.headingId ?? '',
        });
      })()`),
    )
    const settled = Math.abs(cur.top - afterJump.top) < 1
    afterJump = cur
    if (settled && i > 2) break
  }
  check('点大纲后滚动位置动了', afterJump.top > 100, `scrollTop=${Math.round(afterJump.top)}`)
  const relTop = afterJump.elTop === null ? null : afterJump.elTop - afterJump.scTop
  check(
    '目标标题落在阅读区顶部（16px 呼吸空间）',
    relTop !== null && relTop > -2 && relTop < 40,
    `相对阅读区 ${relTop === null ? 'null' : Math.round(relTop)}px`,
  )
  check('大纲高亮了当前标题', afterJump.active !== '', afterJump.active)

  /*
   * 缩放必须"保住读到的那一段"。
   * 字号缩放是重排：如果只让 scrollTop 不变，放大之后同一段文字会被推到几屏之外。
   * 所以这里跳转后连点两次放大，断言**同一个标题还在顶部附近**。
   */
  await click(TID.zoomIn)
  await click(TID.zoomIn)
  await sleep(600)
  const afterZoomJump = JSON.parse(
    await evaluate(`(() => {
      const v = document.querySelector('[data-tid="md-viewer"]');
      const el = document.getElementById(${JSON.stringify(jumped.id ?? '')});
      return JSON.stringify({
        rel: el ? el.getBoundingClientRect().top - v.getBoundingClientRect().top : null,
        pct: document.querySelector('[data-tid="zoom"]')?.textContent?.trim() ?? '',
      });
    })()`),
  )
  check(
    '放大后仍停在原来那一节（重排没把人甩走）',
    afterZoomJump.rel !== null && afterZoomJump.rel < 80,
    `pct=${afterZoomJump.pct} 相对阅读区 ${afterZoomJump.rel === null ? 'null' : Math.round(afterZoomJump.rel)}px`,
  )
  // 回到 100%，后面的位置记忆按这个比例记录
  await click(TID.zoom)
  await sleep(300)
  await shot('03-md-outline')

  // 键盘：PageDown 应该滚动
  const topBefore = afterJump.top
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }))`)
  await sleep(400)
  const topAfter = Number(await evaluate(`document.querySelector('[data-tid="md-viewer"]').scrollTop`))
  check('PageDown 在 Markdown 下是滚动而不是翻页', topAfter > topBefore + 50, `${Math.round(topBefore)} → ${Math.round(topAfter)}`)

  // ---------------------------------------------------------------- 5. 阅读位置记忆
  console.log('\n[5] 阅读位置记忆（换一篇再换回来）')
  await sleep(900) // 等防抖落盘（600ms）
  const saved = JSON.parse(
    await evaluate(`(() => {
      const k = Object.keys(localStorage).filter(x => x.startsWith('epl:md-reading:'));
      const raw = k[0] ? JSON.parse(localStorage.getItem(k[0])) : null;
      return JSON.stringify({ keys: k.length, raw });
    })()`),
  )
  check('写入了独立的 md 阅读位置键', saved.keys === 1 && !!saved.raw, `keys=${saved.keys}`)
  check(
    '记录里有缩放 + 标题锚点 + 偏移',
    !!saved.raw && typeof saved.raw.scale === 'number' && typeof saved.raw.anchorId === 'string' && typeof saved.raw.anchorOffsetRatio === 'number',
    saved.raw ? `scale=${saved.raw.scale} anchor=${saved.raw.anchorId}` : '',
  )
  const savedTop = topAfter

  // 换到另一篇，再换回来 —— 第二个文档的落盘不会覆盖第一篇的记录
  await openViaInput(MD_UNSAFE)
  await waitMd(1)
  await openViaInput(MD_BASIC)
  await waitMd(5)
  await sleep(700)
  const restored = JSON.parse(
    await evaluate(`(() => {
      const v = document.querySelector('[data-tid="md-viewer"]');
      return JSON.stringify({
        top: v.scrollTop,
        pct: document.querySelector('[data-tid="zoom"]')?.textContent?.trim() ?? '',
      });
    })()`),
  )
  check('重开同一篇回到了上次的位置', Math.abs(restored.top - savedTop) < 200, `${Math.round(savedTop)} → ${Math.round(restored.top)}`)
  check('缩放也恢复了', restored.pct === '100%', restored.pct)
  check(
    '没有把 md 的位置写进 PDF 的键（两套键不能混）',
    (await evaluate(`Object.keys(localStorage).filter(k => k.startsWith('epl:reading:')).length`)) === 0,
  )

  // ---------------------------------------------------------------- 5b. 页内查找
  console.log('\n[5b] 页内查找（Ctrl+F）')

  // 走真实路径：全局 keydown 打到 window（和用户按 Ctrl+F 同一条链路）
  await evaluate(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))`,
  )
  await sleep(250)
  check('Ctrl+F 打开了查找条', await evaluate(`!!document.querySelector('[data-tid="md-find"]')`))
  check(
    '输入框自动获得焦点（可以直接打字）',
    await evaluate(`document.activeElement?.dataset?.tid === 'md-find-input'`),
  )

  // 输入关键词（v-model 监听的是 input 事件）
  await evaluate(`(() => {
    const i = document.querySelector('[data-tid="md-find-input"]');
    i.value = '表格';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await sleep(400) // 140ms 防抖 + 一轮 rAF

  const findState = JSON.parse(
    await evaluate(`(() => {
      const hl = CSS.highlights ? CSS.highlights.get('md-find') : null;
      const active = CSS.highlights ? CSS.highlights.get('md-find-active') : null;
      const r = active ? [...active][0] : null;
      const box = r ? r.getBoundingClientRect() : null;
      const sc = document.querySelector('[data-tid="md-viewer"]').getBoundingClientRect();
      return JSON.stringify({
        count: document.querySelector('[data-tid="md-find-count"]')?.textContent?.trim() ?? '',
        painted: hl ? hl.size : -1,
        activeCount: active ? active.size : -1,
        inView: box ? box.top >= sc.top - 6 && box.bottom <= sc.bottom + 6 : false,
      });
    })()`),
  )
  check('计数显示成 "1 / N"', /^1 \/ [2-9]\d*$/.test(findState.count), findState.count)
  check(
    '所有匹配都被高亮（Highlight API 真的注册上了）',
    findState.painted >= 2,
    `painted=${findState.painted}`,
  )
  check('当前匹配单独高亮一份', findState.activeCount === 1)
  /*
   * ⚠️ 注册和"真的画出来"是两件事：`::highlight()` 规则如果被 Vue 的 scoped
   * 拼上属性选择器，浏览器会**当无效规则丢掉** —— 计数、跳转全对，就是一个字不黄。
   * 这条判据查样式表里那条规则还在，正是为了守住这个静默失败。
   */
  check(
    '高亮样式规则被浏览器接受（scoped 没把它拼坏）',
    await evaluate(`(() => {
      const rules = [];
      for (const sh of document.styleSheets) {
        try {
          for (const r of sh.cssRules) rules.push(r.cssText);
        } catch {
          /* 跨域样式表读不了，跳过 */
        }
      }
      return rules.some((t) => t.includes('::highlight(md-find)') && /background-color/.test(t));
    })()`),
  )
  check('第一个匹配被滚进视口（不是只在计数上"跳"了）', findState.inView)

  // 点「下一个」
  await click(TID.mdFindNext)
  await sleep(250)
  const nextState = JSON.parse(
    await evaluate(`(() => {
      const active = CSS.highlights ? CSS.highlights.get('md-find-active') : null;
      const r = active ? [...active][0] : null;
      const box = r ? r.getBoundingClientRect() : null;
      const sc = document.querySelector('[data-tid="md-viewer"]').getBoundingClientRect();
      return JSON.stringify({
        count: document.querySelector('[data-tid="md-find-count"]')?.textContent?.trim() ?? '',
        inView: box ? box.top >= sc.top - 6 && box.bottom <= sc.bottom + 6 : false,
      });
    })()`),
  )
  check('点「下一个」计数前进到 2', /^2 \/ /.test(nextState.count), nextState.count)
  check('第 2 个匹配也被滚进视口', nextState.inView)

  // Enter 也走同一个动作（键盘可达）
  await evaluate(`(() => {
    const i = document.querySelector('[data-tid="md-find-input"]');
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`)
  await sleep(250)
  check(
    'Enter 跳到下一个（3 / N）',
    /^3 \/ /.test(
      (await evaluate(`document.querySelector('[data-tid="md-find-count"]')?.textContent?.trim() ?? ''`)) ||
        '',
    ),
  )

  // 搜不到时要说"无匹配"，且别把旧高亮留在页面上
  await evaluate(`(() => {
    const i = document.querySelector('[data-tid="md-find-input"]');
    i.value = '这个词一定不存在xyzzy';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await sleep(400)
  const noMatch = JSON.parse(
    await evaluate(`(() => {
      const hl = CSS.highlights ? CSS.highlights.get('md-find') : null;
      return JSON.stringify({
        count: document.querySelector('[data-tid="md-find-count"]')?.textContent?.trim() ?? '',
        painted: hl ? hl.size : 0,
      });
    })()`),
  )
  check('无匹配时给出明确文案', noMatch.count === '无匹配', noMatch.count)
  check('无匹配时不残留旧高亮', noMatch.painted === 0, `painted=${noMatch.painted}`)

  // Esc 关闭：高亮必须一起清掉（否则关掉查找条还满屏黄底）
  await evaluate(`(() => {
    const i = document.querySelector('[data-tid="md-find-input"]');
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  })()`)
  await sleep(250)
  const closed = JSON.parse(
    await evaluate(`(() => {
      const hl = CSS.highlights ? CSS.highlights.get('md-find') : null;
      const act = CSS.highlights ? CSS.highlights.get('md-find-active') : null;
      return JSON.stringify({
        bar: !!document.querySelector('[data-tid="md-find"]'),
        painted: hl ? hl.size : 0,
        active: act ? act.size : 0,
      });
    })()`),
  )
  check('Esc 关掉了查找条', !closed.bar)
  check('关闭后全局高亮被清干净（不留黄底）', closed.painted === 0 && closed.active === 0)

  /*
   * 浏览器惯例：**选中一段文字再按 Ctrl+F**，应该直接带进查找框。
   * 选中"表格"两个字（正文里的第一次出现），再开查找条。
   */
  const selLen = Number(
    await evaluate(`(() => {
      const body = document.querySelector('.md-body');
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = (n.nodeValue || '').indexOf('表格');
        if (i >= 0) {
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + 2);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
          return String(sel.toString().length);
        }
      }
      return '0';
    })()`),
  )
  await evaluate(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))`,
  )
  await sleep(350)
  const prefilled = JSON.parse(
    await evaluate(`(() => {
      const i = document.querySelector('[data-tid="md-find-input"]');
      return JSON.stringify({
        value: i ? i.value : '',
        count: document.querySelector('[data-tid="md-find-count"]')?.textContent?.trim() ?? '',
      });
    })()`),
  )
  check('选中文字后 Ctrl+F 会自动带入（选区内 2 个字）', selLen === 2, `len=${selLen}`)
  check('查找框被预填成选中的词，并已经出结果', prefilled.value === '表格' && /^1 \/ [2-9]/.test(prefilled.count), `${prefilled.value} · ${prefilled.count}`)
  await evaluate(`(() => {
    const i = document.querySelector('[data-tid="md-find-input"]');
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  })()`)
  await sleep(200)

  // ---------------------------------------------------------------- 6. 安全
  console.log('\n[6] 安全：注入 / 恶意链接 / 越界图片')
  await openViaInput(MD_UNSAFE)
  await waitMd(1)
  await sleep(400)
  const safe = JSON.parse(
    await evaluate(`(() => {
      const b = document.querySelector('.md-body');
      return JSON.stringify({
        xss: window.__mdXss ?? null,
        script: b.querySelectorAll('script,iframe,style,object,embed,form,input').length,
        preScript: b.querySelectorAll('pre script').length,
        codeAlert: /__mdXss = 6/.test(b.querySelector('pre code')?.textContent || ''),
        styleAttr: b.querySelectorAll('[style]').length,
        jsLinks: b.querySelectorAll('a[href^="javascript:" i], a[href^="file:" i], a[href^="data:" i]').length,
        deadLinks: b.querySelectorAll('a.md-link-dead').length,
        imgs: b.querySelectorAll('img').length,
        blocked: [...b.querySelectorAll('[data-md-blocked]')].map(e => e.dataset.mdBlocked),
        normal: /正常显示/.test(b.textContent || ''),
      });
    })()`),
  )
  check('原始 HTML 里的脚本没执行', safe.xss === null, String(safe.xss))
  check('正文里没有任何可执行/表单元素', safe.script === 0, `count=${safe.script}`)
  check(
    '代码块里的 <script> 只是文字（高亮不会把它变成元素）',
    safe.codeAlert === true && safe.preScript === 0,
    `preScript=${safe.preScript}`,
  )
  check('内联 style 属性被清掉', safe.styleAttr === 0, `count=${safe.styleAttr}`)
  check('javascript:/file:/data: 链接没有留下 href', safe.jsLinks === 0, `count=${safe.jsLinks}`)
  check(
    '不支持的协议（ftp / 相对路径）变成死链样式',
    safe.deadLinks >= 2,
    `count=${safe.deadLinks}`,
  )
  check('没有加载任何图片（含远程/越界）', safe.imgs === 0, `imgs=${safe.imgs}`)
  const ALLOWED_REASONS = ['remote', 'absolute', 'scheme', 'empty', 'desktop-only', 'no-path', 'missing', 'limit']
  check(
    '每张图都被替换成带原因的占位（远程图片被点名）',
    safe.blocked.length >= 4 &&
      safe.blocked.includes('remote') &&
      safe.blocked.every((r) => ALLOWED_REASONS.includes(r)),
    safe.blocked.join(','),
  )
  check('正常内容仍然渲染（净化不是把整篇吃掉）', safe.normal)
  await shot('04-md-unsafe')

  // ---------------------------------------------------------------- 7. 转 PDF 引导
  console.log('\n[7] 转 PDF 后批注说明框')
  check('点开说明框', await click(TID.mdConvert))
  await sleep(300)
  check('说明框出现了', await evaluate(`!!document.querySelector('[data-tid="md-convert-dialog"]')`))
  const dlg = JSON.parse(
    await evaluate(`(() => {
      const d = document.querySelector('[data-tid="md-convert-dialog"]');
      return JSON.stringify({
        text: d.textContent || '',
        copy: !!d.querySelector('[data-tid="md-convert-copy"]'),
        reveal: !!d.querySelector('[data-tid="md-convert-reveal"]'),
        close: !!d.querySelector('[data-tid="md-convert-close"]'),
      });
    })()`),
  )
  check('文案说清了"先转 PDF 再批注"', /转成 PDF|转 PDF/.test(dlg.text) && /批注/.test(dlg.text))
  check('三个动作都在（复制路径 / 打开文件夹 / 关闭）', dlg.copy && dlg.reveal && dlg.close)
  check('浏览器版明说没有真实路径', /浏览器版/.test(dlg.text))
  await shot('05-md-convert')
  await click(TID.mdConvertClose)
  await sleep(200)
  check('能关闭', !(await evaluate(`!!document.querySelector('[data-tid="md-convert-dialog"]')`)))

  // ---------------------------------------------------------------- 8. 不支持的类型
  console.log('\n[8] 不支持的类型要给明确提示')
  const TXT = join(userDataDir, 'nope.txt')
  await writeFile(TXT, 'hello\n')
  await openViaInput(TXT)
  await sleep(500)
  const errText = await evaluate(`document.querySelector('.err')?.innerText ?? ''`)
  check('拖/选 .txt 被拒绝并说明支持范围', /只支持 PDF/.test(errText) && /Markdown/.test(errText), errText.slice(0, 60))

  // ---------------------------------------------------------------- 9. PDF 回归冒烟
  console.log('\n[9] PDF 通道回归（新分流不能弄坏旧链路）')
  await openViaInput(PDF)
  let pdfOk = false
  for (let i = 0; i < 40; i++) {
    pdfOk = await evaluate(`document.querySelectorAll('.pdf-page-canvas').length > 0`)
    if (pdfOk) break
    await sleep(200)
  }
  check('PDF 仍然能打开并画出页面', pdfOk)
  check('PDF 的批注/页码/双页入口回来了', JSON.parse(
    await evaluate(`(() => {
      const t = ['annot-toggle','page-input','mode-dual','save'];
      return JSON.stringify(t.every(x => !!document.querySelector('[data-tid="'+x+'"]')));
    })()`),
  ))
  check('切回 PDF 后 Markdown 阅读器消失', !(await evaluate(`!!document.querySelector('[data-tid="md-viewer"]')`)))
  await shot('06-pdf-back')

  // ---------------------------------------------------------------- 10. 大文件
  console.log('\n[10] 2 MB 大文件首屏')
  const t1 = Date.now()
  await openViaInput(MD_LARGE)
  const big = await waitMd(20, 150)
  const ms = Date.now() - t1
  check('大文件能渲染出标题', !!big, `${ms} ms, headings=${big?.headings}`)
  check('首屏耗时在可接受范围（< 8s，记录用）', ms < 8000, `${ms} ms`)
  const bigScroll = JSON.parse(
    await evaluate(`(() => {
      const v = document.querySelector('[data-tid="md-viewer"]');
      return JSON.stringify({ sh: v.scrollHeight, cw: v.clientWidth, sw: v.scrollWidth });
    })()`),
  )
  check('大文件也没有整页横向滚动', bigScroll.sw <= bigScroll.cw + 1, `sw=${bigScroll.sw} cw=${bigScroll.cw}`)
  /*
   * md-large 的代码块**都没标语言** —— 正好验证"不自动猜语言"这条取舍：
   * 4778 个标题的文档要是每个块都跑 highlightAuto，缩放/滚动会明显掉帧。
   */
  check(
    '没标语言的代码块保持纯文本（不自动猜语言）',
    await evaluate(
      `[...document.querySelectorAll('.md-body pre code')].length > 0 &&
       [...document.querySelectorAll('.md-body pre code')].every((c) => !c.classList.contains('hljs'))`,
    ),
  )

  // ---------------------------------------------------------------- 收尾
  const ignored = consoleErrors.filter(
    (e) =>
      // 浏览器版读不到本地图片是**预期**结果（UI 已经说明），控制台不应有它的报错
      !/favicon|ResizeObserver/i.test(e),
  )
  check('没有未预期的控制台错误', ignored.length === 0, ignored.slice(0, 3).join(' | '))

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
  if (failed) process.exitCode = 1
} finally {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  child?.kill()
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
}
