/**
 * 批注交互（M7）端到端验证：选色 · 拖动 · 改大小 · 撤销/重做 · 三种指针模式。
 *
 * 为什么要单独一个脚本而不是塞进 test-viewer.mjs：
 * 那套测的是"阅读器"（渲染/懒加载/缩放/版面），断言建立在"文档上没有批注"的前提上；
 * 这一套测的是"编辑器"，会往页面上画东西、拖动、撤销 —— 混在一起会互相干扰
 * （比如 test-viewer 断言"高亮是黄色"，这里偏偏要把高亮改成绿色）。
 *
 * 判据用**数据 + 像素双通道**：
 *   · 数据：`__eplViewer.annots()` 读 rect / color，能抓到"框没动""手柄方向反了"
 *   · 像素：数画布里特定颜色的像素，能抓到"数据对了但没画出来"
 *
 * 用法：node scripts/test-interact.mjs [url]
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clickByTidExpr, TID } from './testids.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = resolve(ROOT, 'interact-shots')
await mkdir(SHOTS, { recursive: true })

const URL_TARGET = process.argv[2] ?? 'http://localhost:4173/'
const PDF = resolve(ROOT, 'public/testdata/real-1706.03762.pdf')
/** 扫描件风格样本：整页矢量图形，**没有文本层**（由 make-scan-sample.mjs 生成） */
const SCAN = resolve(ROOT, 'public/testdata/scan-like.pdf')
const PORT = Number(process.env.EPL_PORT ?? 9511)

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
if (!existsSync(SCAN)) {
  console.error(`找不到扫描件样本：${SCAN}\n先跑 node scripts/make-scan-sample.mjs`)
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userDataDir = await mkdtemp(join(tmpdir(), 'epl-interact-'))
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

const near = (a, b, tol) => Math.abs(a - b) <= tol

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
  /**
   * 页面弹过的原生对话框（confirm / alert）。
   *
   * ⚠️ 必须主动处理：CDP 下对话框会**一直挂着把页面卡死**，
   * 而且默认行为是 dismiss（等于用户点"取消"）—— 于是"换文档"永远不发生，
   * 看起来像功能坏了，其实是对话框没处理。
   */
  const dialogs = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id !== undefined && pending.has(m.id)) {
      const { resolve: res, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(JSON.stringify(m.error))) : res(m.result)
      return
    }
    if (m.method === 'Page.javascriptDialogOpening') {
      dialogs.push(String(m.params.message ?? '').slice(0, 240))
      void send('Page.handleJavaScriptDialog', { accept: true })
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

  /** 截一块区域，返回 base64（不落盘）。
   *  用来做"高亮前 vs 高亮后"的同区域像素对比。 */
  const captureClip = async (clip) => {
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } })
    return r.data
  }

  /**
   * 对比同一区域的两张截图，回答一个问题：**加了高亮之后，字本身变了吗？**
   *
   * 判据（这是"染背景"和"盖色板"的分水岭）：
   *  - multiply 只能让像素**变暗或不变**（黑 × 任何色 = 黑）。所以"原本是字的像素
   *    任何一个被提亮"就说明走的是半透明覆盖，直接判失败。
   *  - 反过来，原本是白底的像素必须真的变成高亮色 —— 否则等于没画上去。
   *
   * 两张 PNG 丢回页面里解码（浏览器自带解码器，省掉一个 Node 端 PNG 库）。
   */
  const compareShots = async (b64Before, b64After) =>
    JSON.parse(
      await evaluate(`
        (async () => {
          const load = async (b64) => {
            const img = new Image();
            img.src = 'data:image/png;base64,' + b64;
            await img.decode();
            const c = document.createElement('canvas');
            c.width = img.naturalWidth; c.height = img.naturalHeight;
            const x = c.getContext('2d');
            x.drawImage(img, 0, 0);
            return x.getImageData(0, 0, c.width, c.height).data;
          };
          const A = await load(${JSON.stringify(b64Before)});
          const B = await load(${JSON.stringify(b64After)});
          const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
          let textN = 0, bgN = 0;
          let beforeSum = 0, afterSum = 0, maxAfter = 0, lightened = 0;
          let bgR = 0, bgG = 0, bgB = 0;
          const n = Math.min(A.length, B.length);
          for (let i = 0; i < n; i += 4) {
            const la = lum(A, i), lb = lum(B, i);
            if (la < 120) {              // 字的笔画（含抗锯齿边缘）
              textN++; beforeSum += la; afterSum += lb;
              if (lb > maxAfter) maxAfter = lb;
              if (lb > la + 2) lightened++;
            } else if (la > 240) {       // 干净的白底
              bgN++; bgR += B[i]; bgG += B[i+1]; bgB += B[i+2];
            }
          }
          return JSON.stringify({
            textN, bgN,
            beforeLum: textN ? beforeSum / textN : 0,
            afterLum: textN ? afterSum / textN : 0,
            maxAfterLum: maxAfter,
            lightened,
            bg: bgN ? [bgR / bgN, bgG / bgN, bgB / bgN] : null,
          });
        })()
      `),
    )

  await send('Runtime.enable')
  await send('Page.enable')
  await send('DOM.enable')

  // ---------------------------------------------------------------- 探针

  /** 点工具栏上某个按钮（按文字精确匹配） */
  const toolbarBtn = (label) => evaluate(clickByTidExpr(label))

  /**
   * 确保颜色菜单是打开的（色板在「批注」按钮的 ▼ 里，默认不显示）。
   *
   * ⚠️ 早期版本色板常驻在工具栏上，直接 `querySelectorAll('.sw')` 就行；
   *    改版后不先展开的话拿到的是**空数组** —— 测试会静默失败（返回 null），
   *    看起来像"颜色没生效"，其实是根本没点到色块。
   *    点 ▼ 会顺带展开批注工具，所以不用先点「批注」。
   */
  const ensureColorMenu = `
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    if (!document.getElementById('epl-color-menu')) {
      document.querySelector('[data-tid="color-caret"]')?.click();
      await sleep(260);
    }
  `

  /** 点第 i 个色块（0 起）。返回它的背景色，便于确认点对了 */
  const clickSwatch = (i) =>
    evaluate(`
      (async () => {
        ${ensureColorMenu}
        const sw = document.querySelectorAll('#epl-color-menu .sw');
        if (!sw[${i}]) return null;
        const bg = getComputedStyle(sw[${i}]).backgroundColor;
        sw[${i}].click();
        await sleep(80);
        return bg;
      })()
    `)

  /**
   * 数一下当前有几个可用色。
   *
   * ⚠️ 自己开的菜单要**自己关掉** —— 留着这个浮层会挡住后续的鼠标操作
   *    （它是 fixed + z-index 200，下一次点击会先落到它上面）。
   */
  const swatchCount = () =>
    evaluate(`
      (async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const had = !!document.getElementById('epl-color-menu');
        if (!had) {
          document.querySelector('[data-tid="color-caret"]')?.click();
          await sleep(260);
        }
        const n = document.querySelectorAll('#epl-color-menu .sw').length;
        if (!had) {
          document.querySelector('[data-tid="color-caret"]')?.click();
          await sleep(80);
        }
        return n;
      })()
    `)

  const snap = async () => JSON.parse(await evaluate(`JSON.stringify(globalThis.__eplViewer.snapshot())`))
  const annots = async () => JSON.parse(await evaluate(`JSON.stringify(globalThis.__eplViewer.annots())`))

  /** 选中框 + 8 个手柄在**屏幕**上的位置 —— 直接测用户看到和点到的东西 */
  const selGeometry = async () =>
    JSON.parse(
      await evaluate(`
        (() => {
          const box = document.querySelector('.sel-box');
          if (!box) return JSON.stringify(null);
          const r = box.getBoundingClientRect();
          const handles = {};
          for (const h of document.querySelectorAll('.sel-handle')) {
            const hr = h.getBoundingClientRect();
            handles[h.dataset.handle] = { x: hr.left + hr.width / 2, y: hr.top + hr.height / 2 };
          }
          return JSON.stringify({
            left: r.left, top: r.top, width: r.width, height: r.height,
            cx: r.left + r.width / 2, cy: r.top + r.height / 2,
            handles, handleCount: Object.keys(handles).length,
          });
        })()
      `),
    )

  /** 数批注浮层上"某个颜色"的像素 —— 数据对了但没画出来，靠这条抓 */
  const colorPixels = async (rgb, tol = 40) =>
    Number(
      await evaluate(`
        (() => {
          // 每页两层 canvas（under=高亮 / over=其余），全部扫一遍
          const layers = [...document.querySelectorAll('.page-slot .annot-layer')];
          if (!layers.length) return 0;
          let n = 0;
          for (const layer of layers) {
            const d = layer.getContext('2d').getImageData(0, 0, layer.width, layer.height).data;
            for (let i = 0; i < d.length; i += 4) {
              if (d[i+3] < 40) continue;
              if (Math.abs(d[i]-${rgb[0]}) <= ${tol} &&
                  Math.abs(d[i+1]-${rgb[1]}) <= ${tol} &&
                  Math.abs(d[i+2]-${rgb[2]}) <= ${tol}) n++;
            }
          }
          return n;
        })()
      `),
    )

  /**
   * 某条批注在**屏幕**上的中心点。
   *
   * 页面空间 → 屏幕：`x_screen = slot.left + x_page * scale`，
   * `y_screen = slot.top + slot.height - y_page * scale`（y 轴翻转）。
   *
   * ⚠️ 别用"创建时点击的那一点"当中心：文本框是从点击处**向左上**长出来的，
   * 点下的那一点是框的右下角，拿它当中心会点空。
   */
  /**
   * 在批注浮层上量"一条横线有多**厚**"。
   *
   * 判据取**该列 alpha 的总和**，而不是"数有几行不透明"：
   * 细笔在 150% 缩放下只有 1~2 个设备像素，抗锯齿会把边界摊成半透明，
   * 数行数会出现"1 行 vs 2 行"这种一像素之差 —— 渲染参数一变就假红。
   * alpha 总和正比于墨量，三档之间是 1 : 2 : 4 的量级差，稳定得多。
   *
   * ⚠️ 两层 canvas 都要扫（under=高亮 / over=其余），笔迹在 over 那层。
   *    只查第一张会量到空的 under 层 → 恒为 0。
   */
  const strokeInk = async (screenX, screenY, winPx = 22) =>
    Number(
      await evaluate(`
        (() => {
          const layers = [...document.querySelectorAll('.page-slot .annot-layer')];
          let best = 0;
          for (const layer of layers) {
            const r = layer.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) continue;
            if (${screenX} < r.left || ${screenX} > r.right) continue;
            if (${screenY} < r.top || ${screenY} > r.bottom) continue;
            const sx = layer.width / r.width, sy = layer.height / r.height;
            const cx = Math.round((${screenX} - r.left) * sx);
            const cy = Math.round((${screenY} - r.top) * sy);
            const half = Math.round(${winPx} * sy);
            const y0 = Math.max(0, cy - half);
            const y1 = Math.min(layer.height, cy + half);
            if (y1 <= y0) continue;
            const d = layer.getContext('2d').getImageData(cx, y0, 1, y1 - y0).data;
            let sum = 0;
            for (let i = 3; i < d.length; i += 4) sum += d[i];
            if (sum > best) best = sum;
          }
          return best;
        })()
      `),
    )

  const centerOf = async (id) =>
    JSON.parse(
      await evaluate(`
        (() => {
          const a = globalThis.__eplViewer.annots().find(x => x.id === ${JSON.stringify(id)});
          if (!a) return JSON.stringify(null);
          const snap = globalThis.__eplViewer.snapshot();
          const s = document.querySelector('.page-slot[data-page="' + a.pageNumber + '"]');
          if (!s) return JSON.stringify(null);
          const r = s.getBoundingClientRect();
          return JSON.stringify({
            x: r.left + ((a.rect[0] + a.rect[2]) / 2) * snap.scale,
            y: r.top + r.height - ((a.rect[1] + a.rect[3]) / 2) * snap.scale,
          });
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

  const dragOn = async (x0, y0, x1, y1, steps = 12) => {
    await mouseAt('mousePressed', x0, y0, 1)
    await sleep(30)
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      await mouseAt('mouseMoved', x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, 1)
      await sleep(12)
    }
    await mouseAt('mouseReleased', x1, y1, 0)
    await sleep(260)
  }

  const tap = async (x, y) => {
    await mouseAt('mousePressed', x, y, 1)
    await sleep(30)
    await mouseAt('mouseReleased', x, y, 0)
    await sleep(220)
  }

  /** 发一个组合键。modifiers：Ctrl=2 · Shift=8 */
  const hotkey = async (key, vk, modifiers = 0) => {
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code: key,
      windowsVirtualKeyCode: vk,
      modifiers,
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code: key,
      windowsVirtualKeyCode: vk,
      modifiers,
    })
    await sleep(280)
  }
  const UNDO = () => hotkey('z', 90, 2)
  const REDO = () => hotkey('Z', 90, 2 | 8)
  const DEL = () => hotkey('Delete', 46, 0)

  // ---------------------------------------------------------------- 打开文档

  console.log(`→ 打开 ${URL_TARGET}`)
  await send('Page.navigate', { url: URL_TARGET })
  await sleep(2000)

  console.log('\n[1] 打开 PDF')
  const { root } = await send('DOM.getDocument', { depth: -1 })
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
  if (!ready) {
    await shot('00-load-failed')
    throw new Error('文档没加载起来')
  }

  await toolbarBtn('单页')
  await evaluate(`document.querySelector('.viewport').scrollTop = 0; true`)
  await sleep(800)

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
  check('拿到第 1 页位置', !!box && box.w > 100, box ? `${Math.round(box.w)}×${Math.round(box.h)}` : 'null')

  const s1 = await snap()
  check('默认指针模式是「选择」', s1.pointerMode === 'select', `mode=${s1.pointerMode}`)
  check('默认没有工具、色板不显示', s1.tool === 'none' && (await swatchCount()) === 0)

  // ---------------------------------------------------------------- 2. 手写选色

  console.log('\n[2] 手写 → 选蓝色 → 画一笔')
  check('切到「手写」', await toolbarBtn('手写'))
  await sleep(200)
  check('出现色板（10 个色块）', (await swatchCount()) === 10, `块数=${await swatchCount()}`)

  const blueBg = await clickSwatch(5)
  check('点中第 6 个色块（蓝）', /rgb\(33,\s*102,\s*235\)/.test(String(blueBg)), String(blueBg))
  await sleep(150)

  const inkX = box.x + box.w / 2
  const inkY = box.y + Math.min(box.h * 0.42, 380)
  await dragOn(inkX - 80, inkY, inkX + 80, inkY + 30)

  const list2 = await annots()
  const ink = list2.find((a) => a.kind === 'ink')
  check('画出了一条手写批注', !!ink, `批注数=${list2.length}`)
  check(
    '写进数据的是**蓝**色，不是默认红（色板真的生效了）',
    !!ink && near(ink.color[0], 0.13, 0.02) && near(ink.color[1], 0.4, 0.02) && near(ink.color[2], 0.92, 0.02),
    ink ? `color=[${ink.color.map((n) => n.toFixed(2)).join(', ')}]` : '找不到',
  )
  const bluePx = await colorPixels([33, 102, 235])
  const redPx = await colorPixels([230, 48, 48])
  check('画布上真的出现蓝色像素', bluePx > 200, `blue=${bluePx}px`)
  check('画布上没有默认红的墨迹', redPx < 50, `red=${redPx}px`)
  await shot('01-ink-blue')

  // ---------------------------------------------------------------- 2b. 笔尖粗细

  console.log('\n[2b] 手写笔尖粗细：三档')
  const widthBtns = async () =>
    Number(await evaluate(`document.querySelectorAll('[data-tid^="ink-width-"]').length`))
  check('手写工具激活时出现 3 个笔尖档位', (await widthBtns()) === 3, `按钮数=${await widthBtns()}`)

  const activeIdx = Number(
    await evaluate(
      `[...document.querySelectorAll('[data-tid^="ink-width-"]')].findIndex(b => b.classList.contains('on'))`,
    ),
  )
  // 与加这个功能之前的线宽（1.6pt）一致，老用户手感不变
  check('默认停在「中」档（1.6pt）', activeIdx === 1, `index=${activeIdx}`)

  // 三档各画一条**水平**短线，再量它有多厚
  const band = JSON.parse(
    await evaluate(`
      (() => {
        const p = document.querySelector('.page-slot[data-page="1"]').getBoundingClientRect();
        const v = document.querySelector('.viewport').getBoundingClientRect();
        const top = Math.max(p.top, v.top), bottom = Math.min(p.bottom, v.bottom);
        const left = Math.max(p.left, v.left), right = Math.min(p.right, v.right);
        return JSON.stringify({ top, bottom, left, right });
      })()
    `),
  )
  const h = band.bottom - band.top
  check('页面可视区域够高，能画三条互不干扰的线', h > 260, `高=${Math.round(h)}px`)

  const ys = [0.18, 0.48, 0.78].map((f) => band.top + h * f)
  const lx0 = band.left + 40
  const lx1 = Math.min(band.right - 40, lx0 + 160)
  const tids = [TID.inkWidthThin, TID.inkWidthMid, TID.inkWidthThick]
  const names = ['细', '中', '粗']
  const inkSums = []
  for (let i = 0; i < 3; i++) {
    check(
      `点「${names[i]}」档`,
      await evaluate(
        `(() => { const b = document.querySelector('[data-tid="${tids[i]}"]'); if (!b) return false; b.click(); return true; })()`,
      ),
    )
    await sleep(200)
    await mouseAt('mousePressed', lx0, ys[i], 1)
    for (let k = 1; k <= 10; k++) {
      await mouseAt('mouseMoved', lx0 + ((lx1 - lx0) * k) / 10, ys[i], 1)
      await sleep(8)
    }
    await mouseAt('mouseReleased', lx1, ys[i], 0)
    await sleep(350)
    inkSums.push(await strokeInk((lx0 + lx1) / 2, ys[i]))
  }
  const fmt = (n) => Math.round(n)
  // ★ 像素判据：数据对了但没画粗，只有这条能抓（画布上墨量必须真的递增）
  check(
    '画布上墨量递增：细 < 中 < 粗',
    inkSums[0] < inkSums[1] && inkSums[1] < inkSums[2],
    inkSums.map(fmt).join(' < '),
  )
  check(
    '粗笔至少是细笔的 2 倍墨量（档位差别要看得见）',
    inkSums[2] >= inkSums[0] * 2,
    `${fmt(inkSums[0])} → ${fmt(inkSums[2])}`,
  )
  const inkWidths = (await annots()).filter((a) => a.kind === 'ink').map((a) => a.lineWidth)
  check(
    '写进数据的是三档实际线宽 0.8 / 1.6 / 3.2',
    [0.8, 1.6, 3.2].every((w) => inkWidths.some((v) => Math.abs(v - w) < 0.01)),
    inkWidths.join(', '),
  )
  await shot('02-ink-widths')

  // ---------------------------------------------------------------- 3. 高亮改色

  console.log('\n[3] 高亮 → 选绿色 → 划选文字')
  check('切到「高亮」', await toolbarBtn('高亮'))
  await sleep(200)
  // 高亮走 multiply：黑会把整行乘黑（字消失）、白等于没画 → 这两块必须不出现
  const hlSwatches = await swatchCount()
  check('高亮色板挡掉了黑/白（10 → 8）', hlSwatches === 8, `块数=${hlSwatches}`)
  await clickSwatch(6)
  await sleep(150)

  const line = JSON.parse(
    await evaluate(`
      (() => {
        const slot = document.querySelector('.page-slot[data-page="1"]');
        if (!slot) return JSON.stringify(null);
        const spans = [...slot.querySelectorAll('.text-layer span')]
          .filter(s => (s.textContent || '').trim().length > 6);
        if (!spans.length) return JSON.stringify(null);
        const r = spans[0].getBoundingClientRect();
        return JSON.stringify({ x1: r.left + 1, x2: r.right - 1, y: r.top + r.height / 2 });
      })()
    `),
  )
  check('找到可选的文字行', !!line)
  if (line) {
    // 高亮**前**先把这一行原样截下来 —— 这是后面"字有没有被改"的基准
    const clip = {
      x: Math.floor(line.x1),
      y: Math.floor(line.y - 9),
      width: Math.max(20, Math.ceil(line.x2 - line.x1)),
      height: 18,
    }
    const before = await captureClip(clip)

    await dragOn(line.x1, line.y, line.x2, line.y, 10)
    const hl = (await annots()).find((a) => a.kind === 'highlight')
    check('生成了高亮批注', !!hl)
    check(
      '高亮用的是选中的**绿**色（不是默认黄）',
      !!hl && near(hl.color[0], 0.1, 0.02) && near(hl.color[1], 0.72, 0.02) && near(hl.color[2], 0.55, 0.02),
      hl ? `color=[${hl.color.map((n) => n.toFixed(2)).join(', ')}]` : '找不到',
    )

    // ---------------------------------------------------------------- 高亮不污染文字
    // 用户反馈的原话："高亮已经影响到字本来的颜色了"。
    // 这里用**浏览器合成后的真实像素**来判，而不是只看数据或只看单层画布。
    const after = await captureClip(clip)
    const cmp = await compareShots(before, after)
    check(
      '对比区域里真的有字也有白底（判据没空转）',
      cmp.textN > 40 && cmp.bgN > 100,
      `字 ${cmp.textN}px / 白底 ${cmp.bgN}px`,
    )
    check(
      '🔴 高亮后**没有一个字的像素被提亮**（multiply 只能变暗，盖板会提亮）',
      cmp.lightened === 0,
      `被提亮 ${cmp.lightened}px，字亮度 ${cmp.beforeLum.toFixed(1)} → ${cmp.afterLum.toFixed(1)}`,
    )
    check(
      '字在高亮区里仍然是深色（字还是黑的，没被冲成灰）',
      cmp.afterLum < 45,
      `平均亮度 ${cmp.afterLum.toFixed(1)}（改前 ${cmp.beforeLum.toFixed(1)}）`,
    )
    check(
      '白底真的被染成了高亮绿（背景上色生效）',
      !!cmp.bg &&
        Math.abs(cmp.bg[0] - 26) < 35 &&
        Math.abs(cmp.bg[1] - 184) < 35 &&
        Math.abs(cmp.bg[2] - 140) < 35,
      cmp.bg ? `底色 rgb(${cmp.bg.map((n) => n.toFixed(0)).join(', ')})` : 'null',
    )

    // 结构层：高亮必须在 under 层且整层 multiply，alpha 必须满格
    const hlLayer = JSON.parse(
      await evaluate(`
        (() => {
          const u = document.querySelector('.page-slot .annot-layer-under');
          if (!u) return JSON.stringify({ has: false });
          const cs = getComputedStyle(u);
          const d = u.getContext('2d').getImageData(0, 0, u.width, u.height).data;
          let opaque = 0, painted = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i+3] > 10) { painted++; if (d[i+3] >= 250) opaque++; }
          }
          return JSON.stringify({
            has: true, blend: cs.mixBlendMode, zIndex: cs.zIndex,
            painted, opaque,
          });
        })()
      `),
    )
    check('高亮画在独立的 under 层上', hlLayer.has)
    check('under 层整层是 multiply 混合', hlLayer.blend === 'multiply', `mix-blend-mode=${hlLayer.blend}`)
    // ⚠️ 不能要求"每一个着色像素都 alpha=255" —— 四边形边界的抗锯齿天生是半透明。
    // 判"主体"即可：盖板写法下不透明像素占比是 **0**（整层 alpha=140）。
    const opaqueRatio = hlLayer.painted ? hlLayer.opaque / hlLayer.painted : 0
    check(
      '高亮主体是**不透明**的（不是 alpha=.55 的半透明板）',
      hlLayer.painted > 100 && opaqueRatio > 0.85,
      `不透明占比 ${(opaqueRatio * 100).toFixed(1)}%（${hlLayer.opaque}/${hlLayer.painted}px，余量是边缘抗锯齿）`,
    )

    await shot('02-highlight-green')
  }

  // ---------------------------------------------------------------- 4. 文本框

  /** 元素的屏幕中心（真实鼠标点它用） */
  const centerOfEl = async (sel) =>
    JSON.parse(
      await evaluate(`(() => {
        const e = document.querySelector(${JSON.stringify(sel)});
        if (!e) return 'null';
        const r = e.getBoundingClientRect();
        return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      })()`),
    )
  /**
   * 用**真实鼠标**点一个元素。
   *
   * 🔴 这条规矩值得单独立一个函数：`el.click()` 只派发 `click`，
   *    **没有 pointerdown / pointerup**。而"点空白处结束编辑""选中即进编辑"
   *    这些逻辑全挂在 pointerdown 上 —— 用 `el.click()` 去点就等于把那段代码绕过去了。
   *    用户报的"选颜色要按两下"就是这么漏掉的（数据那层明明是对的）。
   */
  const tapEl = async (sel) => {
    const c = await centerOfEl(sel)
    if (!c) throw new Error(`tapEl 找不到元素：${sel}`)
    await tap(c.x, c.y)
  }
  /** 文本框工具条的**界面**状态：色板勾在第几个（-1 没开）+ A 按钮的颜色 */
  const uiTextColor = async () =>
    JSON.parse(
      await evaluate(`(() => {
        const btn = document.querySelector('[data-tid="te-color"]');
        const all = [...document.querySelectorAll('.te-swatches .te-sw')];
        return JSON.stringify({
          open: all.length > 0,
          onIndex: all.findIndex((e) => e.classList.contains('on')),
          btnColor: btn ? getComputedStyle(btn).color : null,
        });
      })()`),
    )
  const parseRgb = (s) => (String(s).match(/[\d.]+/g) ?? []).map(Number)

  console.log('\n[4] 文本框：点页面就地出现编辑框（复刻 Edge）')
  check('切到「文字」', await toolbarBtn('文字'))
  await sleep(200)

  const ftX = box.x + box.w * 0.3
  const ftY = box.y + Math.min(box.h * 0.65, 560)
  await tap(ftX, ftY)
  await sleep(500)

  // 旧行为（居中模态）必须彻底消失：它是用户明确要求换掉的东西
  check('不再弹出居中模态输入框', !(await evaluate(`!!document.querySelector('.modal')`)))
  check('就地出现了编辑框', await evaluate(`!!document.querySelector('[data-tid="text-edit"]')`))
  check('左边是拖动用的实心条', await evaluate(`!!document.querySelector('[data-tid="te-grip"]')`))
  check('右边是调宽度的圆圈', await evaluate(`!!document.querySelector('[data-tid="te-widen"]')`))
  check(
    '其余三边是虚线（左边被实心条占掉，所以左边无边框）',
    await evaluate(`(() => {
      const s = getComputedStyle(document.querySelector('[data-tid="text-edit"]'));
      return s.borderTopStyle === 'dashed' && s.borderRightStyle === 'dashed'
          && s.borderBottomStyle === 'dashed' && s.borderLeftStyle === 'none';
    })()`),
  )
  check(
    '光标已经落在框里（点完就能直接打字，不用再点一次）',
    await evaluate(`document.activeElement?.dataset?.tid === 'te-input'`),
  )
  check(
    '工具条齐了：字号三档 + 字色 + 删除',
    (await evaluate(`document.querySelectorAll('[data-tid^="te-size-"]').length`)) === 3 &&
      (await evaluate(`!!document.querySelector('[data-tid="te-color"]')`)) &&
      (await evaluate(`!!document.querySelector('[data-tid="te-delete"]')`)),
  )
  check(
    '编辑框背景是透明的（暗色主题下填底色会让字看不清）',
    /rgba\(0, 0, 0, 0\)|transparent/.test(
      String(await evaluate(`getComputedStyle(document.querySelector('[data-tid="te-input"]')).backgroundColor`)),
    ),
    String(await evaluate(`getComputedStyle(document.querySelector('[data-tid="te-input"]')).backgroundColor`)),
  )
  /*
   * 实心条**不能压住正文**。
   *
   * ⚠️ 这条是用户报上来的："你左边的框挡住了一些字"。
   *    判据只量几何就行，不用看截图 —— 它压住的是文字，而文字不会因此让位
   *    （编辑区必须占满整个框宽，否则换行位置就和写回 PDF 的宽度不一致）。
   *    ⚠️ 也**不能**反过来"把正文往右挤 14px"来避让，那是拿排版一致性换的。
   */
  const gripGeo = JSON.parse(
    await evaluate(`(() => {
      const g = (s) => { const e = document.querySelector(s); if (!e) return null;
        const r = e.getBoundingClientRect(); return { l: r.left, r: r.right }; };
      return JSON.stringify({ grip: g('[data-tid="te-grip"]'), input: g('[data-tid="te-input"]'), box: g('[data-tid="text-edit"]') });
    })()`),
  )
  check(
    '左实心条在正文**左边**，不遮挡首字符',
    !!gripGeo.grip && !!gripGeo.input && gripGeo.grip.r <= gripGeo.input.l + 0.5,
    `实心条右边缘 ${Math.round(gripGeo.grip?.r)} / 正文左边缘 ${Math.round(gripGeo.input?.l)}`,
  )
  check(
    '实心条虽然在框外，但仍挂在编辑框上（跟着一起动）',
    !!gripGeo.grip && !!gripGeo.box && gripGeo.grip.r <= gripGeo.box.l + 0.5,
    `实心条右 ${Math.round(gripGeo.grip?.r)} / 框左 ${Math.round(gripGeo.box?.l)}`,
  )
  await shot('03-freetext-inline')

  // ---- 直接打字（用真实输入事件，不是直接改 DOM）
  const TYPED = '测试文本框 hello world，这一句要足够长，才能看出它会不会在框宽用完时自动换行。'
  await send('Input.insertText', { text: TYPED })
  await sleep(600)

  const ft = (await annots()).find((a) => a.kind === 'freetext')
  check('生成了文本框批注', !!ft, `批注数=${(await annots()).length}`)
  const s4 = await snap()
  check('新建的框自动被选中', s4.sel?.kind === 'freetext', s4.sel ? s4.sel.kind : 'null')
  check('打进去的字进了数据', !!ft && String(ft.text).includes('测试文本框'))

  /*
   * ★ 自动换行是这块的核心诉求之一，判据要能真的抓住：
   *   ① 数据里必须出现**显式换行**（PDF 内容流没有自动换行，只能靠它）
   *   ② 每一行都必须**真的在框宽之内** —— 只判"行数 > 1"的话，
   *      把框宽设成 0 让它疯狂折行也能过，那没意义
   */
  const lines = String(ft?.text ?? '').split('\n')
  check('文字到框宽就自动换行（数据里出现显式换行）', lines.length >= 2, `${lines.length} 行`)
  const wPt = ft ? ft.rect[2] - ft.rect[0] : 0
  const maxLine = Number(
    await evaluate(`(() => {
      const c = document.createElement('canvas').getContext('2d');
      c.font = ${JSON.stringify(`${ft?.fontSize ?? 11}px "Microsoft YaHei", system-ui, sans-serif`)};
      return Math.max(...${JSON.stringify(lines)}.map((l) => c.measureText(l).width));
    })()`),
  )
  check(
    '每一行都没超出框宽',
    maxLine <= wPt,
    `最宽行 ${maxLine.toFixed(1)}pt / 框宽 ${wPt.toFixed(1)}pt`,
  )
  await shot('03b-freetext-typed')

  // ---- 字号三档
  const sizeBefore = ft?.fontSize
  const hBefore = ft ? ft.rect[3] - ft.rect[1] : 0
  await tapEl('[data-tid="te-size-2"]') // 大（真实鼠标，同色板那条道理）
  const ftBig = (await annots()).find((a) => a.id === ft?.id)
  check('点「大」档 → 数据里的 fontSize 变大', ftBig && ftBig.fontSize > (sizeBefore ?? 0), `${sizeBefore} → ${ftBig?.fontSize}`)
  check(
    '字号按钮的高亮也一次就跟上（同一个"界面慢一拍"的坑）',
    await evaluate(`document.querySelector('[data-tid="te-size-2"]')?.classList.contains('on') === true`),
  )
  check(
    '字号变大后按新字号**重新断行**（行数或行高跟着变）',
    !!ftBig && ftBig.rect[3] - ftBig.rect[1] >= hBefore,
    `高 ${hBefore.toFixed(1)} → ${(ftBig ? ftBig.rect[3] - ftBig.rect[1] : 0).toFixed(1)}pt`,
  )
  check(
    '换行仍然没超框',
    Number(
      await evaluate(`(() => {
        const c = document.createElement('canvas').getContext('2d');
        c.font = ${JSON.stringify('16px "Microsoft YaHei", system-ui, sans-serif')};
        return Math.max(...${JSON.stringify(String(ftBig?.text ?? '').split('\n'))}.map((l) => c.measureText(l).width));
      })()`),
    ) <= (ftBig ? ftBig.rect[2] - ftBig.rect[0] : 0),
  )
  await shot('03c-freetext-big')

  // ---- 字色（用框自带工具条）
  await tapEl('[data-tid="te-color"]')
  const teSwatchCount = await evaluate(`document.querySelectorAll(".te-swatches .te-sw").length`)
  check("字色色板展开了，且是完整色板（含黑/白 —— 文字必须能用黑色）", teSwatchCount === 10, `${teSwatchCount} 色`)
  await tapEl('.te-swatches .te-sw:nth-child(9)') // 黑（色板里第 9 个）
  const ftBlack = (await annots()).find((a) => a.id === ft?.id)
  check(
    '选黑色 → 数据里的 color 变黑',
    !!ftBlack && ftBlack.color[0] < 0.1 && ftBlack.color[1] < 0.1 && ftBlack.color[2] < 0.1,
    ftBlack ? `color=[${ftBlack.color.map((n) => n.toFixed(2)).join(', ')}]` : '找不到',
  )
  /*
   * ★ 界面必须**一次**就跟上。
   *
   * 用户报的是"选择颜色时需要按两下才能正确选中"。根因**不在数据**（画布当场就变了），
   * 而在 `textEditFree` 这个 computed 还指着旧对象 —— 色板勾选和 A 按钮的颜色慢一拍，
   * 用户看不到勾，以为没选中就又点一次（第二下之所以"生效"，是那次同步把 ref 追上了）。
   *
   * ⚠️ 所以判据必须查**界面**。只查 `annots().color` 的话，这个 bug 永远抓不到 ——
   *    上一版就是这么漏过去的。
   */
  const uiBlack = await uiTextColor()
  check('一次点击后色板就勾在「黑」上（不用点两下）', uiBlack.onIndex === 8, `勾选索引=${uiBlack.onIndex}`)
  check(
    '一次点击后 A 按钮的颜色也跟着变黑',
    parseRgb(uiBlack.btnColor)[0] < 60,
    uiBlack.btnColor ?? 'null',
  )
  await shot('03d-freetext-black')
  /*
   * 改回蓝色，后面几张截图好看一点。
   *
   * ⚠️ 色板选完**不会自动关**（用户可能想连着调几档试试），所以这里必须写成
   *    「没开才点」—— 无条件点一次 `te-color` 会把它**关掉**，紧接着那次 swatch 点击
   *    就静默失效：截图里字还是黑的，而脚本一声不吭。（第一版就是这么写的。）
   */
  if (!(await uiTextColor()).open) await tapEl('[data-tid="te-color"]')
  await tapEl('.te-swatches .te-sw:nth-child(6)') // 蓝
  const backToBlue = (await annots()).find((a) => a.id === ft?.id)
  const uiBlue = await uiTextColor()
  check(
    '（截图整理）字色确实改回蓝色了（数据 + 界面都对）',
    !!backToBlue && backToBlue.color[2] > 0.8 && backToBlue.color[0] < 0.3 && uiBlue.onIndex === 5,
    backToBlue ? `color=[${backToBlue.color.map((n) => n.toFixed(2)).join(', ')}] 勾选索引=${uiBlue.onIndex}` : '找不到',
  )
  await tapEl('[data-tid="te-color"]') // 收起色板，免得挡住后面的拖动

  // ---------------------------------------------------------------- 5. 拖动（左实心条）

  console.log('\n[5] 拖左边那条实心条 = 移动文本框')

  /** 就地编辑框上两个把手在屏幕上的坐标 */
  const textHandleAt = async (tid) =>
    JSON.parse(
      await evaluate(`(() => {
        const el = document.querySelector('[data-tid="${tid}"]');
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      })()`),
    )

  // ⚠️ 必须**现在**重新读：上面改过字号，`ft` 那份快照的高度已经过期了
  const ftNow = (await annots()).find((a) => a.id === ft?.id)
  const beforeRect = [...(ftNow ? ftNow.rect : [0, 0, 0, 0])]
  const grip = await textHandleAt('te-grip')
  check('拿到了实心条的屏幕坐标', !!grip)
  const MOVE_DX = 70
  const MOVE_DY = 40
  await dragOn(grip.x, grip.y, grip.x + MOVE_DX, grip.y + MOVE_DY)

  const afterMove = (await annots()).find((a) => a.id === ft?.id)
  check(
    '数据里的 rect 跟着平移了',
    !!afterMove && near(afterMove.rect[0] - beforeRect[0], MOVE_DX / s4.scale, 6),
    afterMove ? `Δx=${(afterMove.rect[0] - beforeRect[0]).toFixed(1)}pt（期望≈${(MOVE_DX / s4.scale).toFixed(1)}）` : '找不到',
  )
  check(
    '宽高没变（拖的是位置，不是尺寸）',
    !!afterMove &&
      near(afterMove.rect[2] - afterMove.rect[0], beforeRect[2] - beforeRect[0], 0.6) &&
      near(afterMove.rect[3] - afterMove.rect[1], beforeRect[3] - beforeRect[1], 0.6),
    afterMove ? `${(afterMove.rect[2] - afterMove.rect[0]).toFixed(1)}×${(afterMove.rect[3] - afterMove.rect[1]).toFixed(1)}pt` : '',
  )
  const gripAfter = await textHandleAt('te-grip')
  check(
    '编辑框自己跟着走到了新位置',
    !!gripAfter && near(gripAfter.x - grip.x, MOVE_DX, 8) && near(gripAfter.y - grip.y, MOVE_DY, 8),
    gripAfter ? `Δ=(${(gripAfter.x - grip.x).toFixed(0)}, ${(gripAfter.y - grip.y).toFixed(0)})px` : 'null',
  )
  await shot('04-freetext-moved')

  // ---------------------------------------------------------------- 6. 调宽度（右圆圈）

  console.log('\n[6] 拖右边那个圆圈 = 调文本框宽度')
  const w0 = afterMove ? afterMove.rect[2] - afterMove.rect[0] : 0
  const widen = await textHandleAt('te-widen')
  check('拿到了圆圈的屏幕坐标', !!widen)
  const WIDEN_DX = 60
  await dragOn(widen.x, widen.y, widen.x + WIDEN_DX, widen.y)

  const afterWiden = (await annots()).find((a) => a.id === ft?.id)
  const w1 = afterWiden ? afterWiden.rect[2] - afterWiden.rect[0] : 0
  check('宽度真的变大了', w1 > w0 + 3, `${w0.toFixed(1)}pt → ${w1.toFixed(1)}pt（屏幕 +${WIDEN_DX}px）`)
  check(
    '变宽之后**重新断行**了（行数减少，或至少没有溢出）',
    !!afterWiden &&
      Number(
        await evaluate(`(() => {
          const c = document.createElement('canvas').getContext('2d');
          c.font = ${JSON.stringify('16px "Microsoft YaHei", system-ui, sans-serif')};
          return Math.max(...${JSON.stringify(String(afterWiden.text).split('\n'))}.map((l) => c.measureText(l).width));
        })()`),
      ) <= w1,
  )
  await shot('05-freetext-widened')

  // ---------------------------------------------------------------- 7. 点空白 → 收起并融合

  console.log('\n[7] 点空白处 → 收起编辑框，文字与 PDF 融为一体')
  const vpBox = JSON.parse(
    await evaluate(`(() => {
      const r = document.querySelector('.viewport').getBoundingClientRect();
      return JSON.stringify({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
    })()`),
  )
  /*
   * ⚠️ 两个坑都踩过：
   *   ① 必须点在**视口内** —— 视口外的坐标不会命中页面，点了等于没点；
   *   ② 必须点在**框外** —— 文本框长高之后，页面下方 88% 处可能已经落在框里，
   *      那样点下去只是把光标移进框内，编辑态不会结束。
   * 所以取页面的**左上角空白边距**：既在视口内，又离所有批注都远。
   */
  const blankX = box.x + 12
  const blankY = Math.max(vpBox.top + 12, box.y + 12)
  await tap(blankX, blankY)
  await sleep(600)

  check('编辑框已经收起', !(await evaluate(`!!document.querySelector('[data-tid="text-edit"]')`)))
  const merged = (await annots()).find((a) => a.kind === 'freetext')
  check('批注本体还在（文字留下来了）', !!merged && String(merged.text).length > 0)
  check(
    '画布上只画字、没有底色和边框（"融为一体"的像素证据）',
    (await colorPixels([255, 255, 255], 6)) < 40000,
    `纯白像素 ${await colorPixels([255, 255, 255], 6)}`,
  )
  await shot('06-freetext-merged')

  // ---- 历史：整段编辑塌成一条（新建的框，撤一次就该整个消失）
  console.log('\n[7b] 撤销 / 重做（整段编辑 = 一条历史）')
  const s7 = await snap()
  check('有可撤销的历史', s7.canUndo === true)
  console.log('    撤销前 kinds =', JSON.stringify((await annots()).map((a) => a.kind)))
  await UNDO()
  console.log('    撤销后 kinds =', JSON.stringify((await annots()).map((a) => a.kind)))
  console.log('    撤销后 canRedo =', (await snap()).canRedo)
  check(
    '撤销一次 = 整个文本框消失（新建 + 打字 + 拖动 + 调宽 塌成一条）',
    !(await annots()).some((a) => a.kind === 'freetext'),
    `剩余批注=${(await annots()).length}`,
  )
  await REDO()
  const back7 = (await annots()).find((a) => a.kind === 'freetext')
  check(
    '重做一次 = 文本框连同内容一起回来',
    !!back7 && String(back7.text).includes('测试文本框'),
  )
  await shot('07-redone')

  /*
   * ---- 重新编辑：点回那个已经收起的框
   *
   * 用户报的："想修改文字时，点击文本框把原来的文本全部清除了，我需要在原来的文本基础上修改"。
   * 根因是 `.te-input` 是个**空 div** —— 谁都没往里面写过原文，于是进编辑态看到的是空白，
   * 一打字整段就被顶掉（数据丢失级）。
   * ⚠️ 上一版测不到，是因为这条路径（编辑**已有**框）压根没测 —— 全是"新建 + 打字"。
   */
  console.log('\n[7c] 重新编辑已有文本框：原文必须还在（在原文基础上改）')
  const beforeReedit = (await annots()).find((a) => a.kind === 'freetext')
  const reCenter = await centerOf(beforeReedit.id)
  await tap(reCenter.x, reCenter.y)
  await sleep(600)
  check('点已有文本框 → 又进了编辑态', await evaluate(`!!document.querySelector('[data-tid="text-edit"]')`))
  const reText = await evaluate(`document.querySelector('[data-tid="te-input"]')?.innerText ?? null`)
  check(
    '编辑区里带着**原文**（不是一张白纸）',
    typeof reText === 'string' && reText.replace(/\n/g, '').length > 0,
    JSON.stringify(String(reText).slice(0, 24)),
  )
  check(
    '编辑区里的文字和批注数据一致',
    String(reText ?? '').replace(/\n$/, '') === String(beforeReedit.text ?? ''),
    `编辑区 ${JSON.stringify(String(reText).slice(0, 16))} / 数据 ${JSON.stringify(String(beforeReedit.text).slice(0, 16))}`,
  )
  await shot('07c-reedit-keeps-text')

  /*
   * 而且在原文基础上**接着打字**应该变成"追加"，不是"替换整段"。
   * 光标默认落在末尾（见 focusTextEditor），所以这里直接补字。
   */
  await send('Input.insertText', { text: '（补一句）' })
  await sleep(400)
  const appended = (await annots()).find((a) => a.id === beforeReedit.id)
  check(
    '接着打字是**追加**，原句还在',
    !!appended && String(appended.text).includes('测试文本框') && String(appended.text).includes('（补一句）'),
    JSON.stringify(String(appended?.text ?? '').slice(0, 30)),
  )

  /*
   * 空操作不该进历史：点进框里看看、再点走 —— 撤销栈不该多一条。
   *
   * ⚠️ 判据要用**行为**，不要数栈深度（数不出"有没有牙"）：
   *    如果那一下留了个 before==after 的空记录，下面这次撤销会"白按" ——
   *    文字里还会带着刚追加的那句。所以直接断言"第一次撤销就把追加退掉了"。
   */
  await tap(blankX, blankY)
  await sleep(500)
  check('点走之后编辑框收起了', !(await evaluate(`!!document.querySelector('[data-tid="text-edit"]')`)))
  await UNDO()
  await sleep(300)
  const afterNoopUndo = (await annots()).find((a) => a.id === beforeReedit.id)
  check(
    '点进框再点走（什么都没改）没留下空历史 —— 一次撤销就退掉了那次追加',
    !!afterNoopUndo &&
      String(afterNoopUndo.text).includes('测试文本框') &&
      !String(afterNoopUndo.text).includes('（补一句）'),
    JSON.stringify(String(afterNoopUndo?.text ?? '').slice(0, 30)),
  )
  await REDO()
  await sleep(300)

  // ---------------------------------------------------------------- 8. 改选中项颜色

  console.log('\n[8] 选中后改色（改用第 2 节那条手写，避免和文本框的编辑态搅在一起）')
  const inkForColor = (await annots()).find((a) => a.kind === 'ink')
  check('找得到之前画的手写批注', !!inkForColor)
  if (inkForColor) {
    const c8 = await centerOf(inkForColor.id)
    await tap(c8.x, c8.y)
    const s8b = await snap()
    check('点中了手写批注', s8b.sel?.id === inkForColor.id, s8b.sel ? s8b.sel.kind : 'null')
    await clickSwatch(2) // 红
    await sleep(300)
    const rf = (await annots()).find((a) => a.id === inkForColor.id)
    check(
      '选中后点色板 = 改**这一条**的颜色（可撤销）',
      !!rf && near(rf.color[0], 0.9, 0.02) && near(rf.color[1], 0.19, 0.02),
      rf ? `color=[${rf.color.map((n) => n.toFixed(2)).join(', ')}]` : '找不到',
    )
    await UNDO()
    const back = (await annots()).find((a) => a.id === inkForColor.id)
    check(
      '改色也能被撤销',
      !!back && near(back.color[0], 0.13, 0.02) && near(back.color[2], 0.92, 0.02),
      back ? `撤销后 color=[${back.color.map((n) => n.toFixed(2)).join(', ')}]` : '找不到',
    )
    await REDO()
  }
  await shot('08-recolor')

  // ---------------------------------------------------------------- 9. 三种指针模式

  console.log('\n[9] 指针模式：滚动 / 拖动 / 选择')

  // ---- 滚动模式：点批注不应该选中
  check('切到「滚动」', await toolbarBtn('滚动'))
  await sleep(200)
  const c9 = await centerOf(ft.id)
  await tap(c9.x, c9.y) // 就点在批注正中间
  const s9 = await snap()
  check('滚动模式下点批注**不会**选中（避免翻页误拖）', s9.sel === null, `sel=${s9.sel?.kind ?? 'null'}`)

  // ---- 拖动模式：自动清工具 + 左键平移
  check('切到「拖动」', await toolbarBtn('拖动'))
  await sleep(250)
  const s9b = await snap()
  check('切到拖动模式会自动退出批注工具', s9b.tool === 'none', `tool=${s9b.tool}`)

  const countBeforePan = (await annots()).length
  const scrollBefore = await evaluate(`document.querySelector('.viewport').scrollTop`)
  const panY = box.y + 200
  await dragOn(box.x + box.w / 2, panY, box.x + box.w / 2, panY - 150, 12)
  const scrollAfter = await evaluate(`document.querySelector('.viewport').scrollTop`)
  check(
    '拖动模式下左键拖拽平移了视口',
    scrollAfter > scrollBefore + 80,
    `scrollTop ${scrollBefore} → ${scrollAfter}`,
  )
  check(
    '平移没有顺手画出任何批注（抓手不该落到画布上）',
    (await annots()).length === countBeforePan,
    `${countBeforePan} → ${(await annots()).length}`,
  )
  await shot('09-pan')

  // ---- 回到选择模式：能点中并拖动
  check('切回「选择」', await toolbarBtn('选择'))
  await sleep(200)
  await evaluate(`document.querySelector('.viewport').scrollTop = 0; true`)
  await sleep(600)

  const c10 = await centerOf(ft.id)
  await tap(c10.x, c10.y)
  const s10 = await snap()
  check('选择模式下点批注能选中', s10.sel?.kind === 'freetext', `sel=${s10.sel?.kind ?? 'null'}`)

  // ---------------------------------------------------------------- 10. 删除所选

  console.log('\n[10] 删除所选 + 撤销')
  /*
   * ⚠️ 先选中一条**非文本框**的批注。
   *    文本框被选中时焦点在可编辑区里，`Delete` 归它（那是打字用的），
   *    应用级快捷键会主动让路 —— 这是刻意的（见 App.vue 里 onKeydown 的注释），
   *    所以拿"选中文本框 + Delete"来测应用级删除本身就不成立。
   */
  const inkForDel = (await annots()).find((a) => a.kind === 'ink')
  check('找得到一条非文本批注用来测删除', !!inkForDel)
  if (inkForDel) {
    const cd = await centerOf(inkForDel.id)
    await tap(cd.x, cd.y)
    await sleep(200)
  }
  const countBefore = (await annots()).length
  await DEL()
  const countAfter = (await annots()).length
  check('Delete 删掉了选中项', countAfter === countBefore - 1, `${countBefore} → ${countAfter}`)
  const s11 = await snap()
  check('删除后选中态被清掉（不会指向空气）', s11.sel === null)

  await UNDO()
  const countBack = (await annots()).length
  check('撤销把删掉的那条找回来了', countBack === countBefore, `${countAfter} → ${countBack}`)
  await shot('10-delete-undo')

  // ---------------------------------------------------------------- 11. 高亮拖动 + 不变量

  console.log('\n[11] 拖动高亮（markup）：只能平移，且内容必须待在 /Rect 内')
  const hl = (await annots()).find((a) => a.kind === 'highlight')
  check('页面上有高亮批注', !!hl)
  if (hl) {
    const hc = await centerOf(hl.id)
    await tap(hc.x, hc.y)
    const s11 = await snap()
    check('markup 类也能被选中', s11.sel?.kind === 'highlight', `sel=${s11.sel?.kind ?? 'null'}`)

    const hg = await selGeometry()
    check(
      '高亮**不给**改大小手柄（拉伸高亮会脱离原文，没有意义）',
      !!hg && hg.handleCount === 0,
      hg ? `手柄=${hg.handleCount}` : 'null',
    )

    const hlBefore = [...hl.rect]
    await dragOn(hc.x, hc.y, hc.x - 60, hc.y + 26)
    const hlAfter = (await annots()).find((a) => a.id === hl.id)
    check(
      '高亮的 rect 跟着平移了',
      !!hlAfter && Math.abs(hlAfter.rect[0] - hlBefore[0]) > 5,
      hlAfter ? `x0 ${hlBefore[0].toFixed(1)} → ${hlAfter.rect[0].toFixed(1)}pt` : '找不到',
    )
    check(
      '平移后 /Rect 仍然**正好**是 QuadPoints 的包围盒（否则写回 PDF 会被查看器裁掉）',
      !!hlAfter && hlAfter.contentInsideRect === true,
      hlAfter ? `inside=${hlAfter.contentInsideRect}` : '',
    )
    const allOk = (await annots()).every((a) => a.contentInsideRect)
    check('所有批注的内容都待在各自 /Rect 内', allOk, allOk ? '全部通过' : '有越界')

    // 页面在同一时刻只能有一个选中框，且 markup 选中时 DOM 里一个手柄都不该有
    // （截图缩略图上"看着像有手柄"分不清，所以这条用 DOM 数出来）
    const boxes = await evaluate(`document.querySelectorAll('.sel-box').length`)
    const handles = await evaluate(`document.querySelectorAll('.sel-handle').length`)
    check(
      '全场只有 1 个选中框、且 markup 选中时 0 个手柄',
      boxes === 1 && handles === 0,
      `sel-box=${boxes}, sel-handle=${handles}`,
    )
    await shot('11-highlight-moved')

    await UNDO()
    const hlBack = (await annots()).find((a) => a.id === hl.id)
    check(
      '拖动高亮也能被撤销',
      !!hlBack && near(hlBack.rect[0], hlBefore[0], 0.6),
      hlBack ? `x0 回到 ${hlBack.rect[0].toFixed(1)}pt` : '找不到',
    )
  }

  // ---------------------------------------------------------------- 12. 控制台

  console.log('\n[12] 区域高亮 + 换文档时的「未保存」提醒')
  /*
   * 这一节一次验证两件事，因为它们共用"换文档"这一个动作：
   *
   * ① **退出提醒**：有未保存批注时打开新文件，必须先弹确认。
   *    这条 beforeunload 管不到（页面压根没卸载），只能靠应用内 confirm。
   *
   * ② **区域高亮不依赖文本层**：在**真正没有文本层**的样本上，
   *    文字高亮一条都画不出来，区域高亮照样能画 —— 这就是 B1 要补的缺口。
   *
   * ⚠️ ②的对照必须在扫描件样本上做。曾经想在文字版 PDF 上找"空白处"做对照，
   *    结果失败：拖动经过空白区时浏览器照样会把附近的字选进选区，对照不成立。
   */
  {
    check(
      '换文档前确实有未保存的批注（提醒的前提）',
      (await annots()).length > 0,
      `${(await annots()).length} 条`,
    )

    const dlgBefore = dialogs.length
    const r2 = await send('DOM.getDocument', { depth: 1 })
    const f2 = await send('DOM.querySelector', {
      nodeId: r2.root.nodeId,
      selector: 'input[type=file]',
    })
    await send('DOM.setFileInputFiles', { files: [SCAN], nodeId: f2.nodeId })

    let swapped = false
    for (let i = 0; i < 80; i++) {
      await sleep(300)
      const c = await evaluate(`document.querySelectorAll('.pdf-page-canvas').length`)
      const loading = await evaluate(`!!document.querySelector('.loading')`)
      const fname = await evaluate(`(document.querySelector('[data-tid="file-name"]')||{}).textContent||''`)
      if (!loading && c > 0 && String(fname).includes('scan-like')) {
        swapped = true
        break
      }
    }
    check(
      '有未保存批注时打开新文件 → **弹了确认框**',
      dialogs.length > dlgBefore,
      dialogs.slice(dlgBefore).join(' | ').slice(0, 130) || '没弹（批注会被静默丢掉）',
    )
    check('接受确认后换成了扫描件样本', swapped)
    if (!swapped) throw new Error('没换成扫描件样本，后面的对照做不了')

    check('换文档后批注清空了', (await annots()).length === 0, `${(await annots()).length} 条`)

    const spanCount = Number(
      await evaluate(`document.querySelectorAll('.page-slot .text-layer span').length`),
    )
    check('样本确实**没有文本层**（对照的前提）', spanCount === 0, `span=${spanCount}`)

    const slot = JSON.parse(
      await evaluate(`
        (() => {
          const s = document.querySelector('.page-slot[data-page="1"]');
          const r = s.getBoundingClientRect();
          return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height });
        })()
      `),
    )
    const bx = Math.round(slot.x + slot.w * 0.2)
    const by = Math.round(slot.y + slot.h * 0.3)
    const bw = Math.round(slot.w * 0.5)
    const bh = Math.round(slot.h * 0.08)

    // ① 文字高亮：没有文本层 → 选不出东西 → 一条都生成不了
    await toolbarBtn('高亮')
    await sleep(220)
    await dragOn(bx, by, bx + bw, by + bh)
    await sleep(280)
    check(
      '扫描件上文字高亮**画不出来**（没有文本层可依附）',
      (await annots()).length === 0,
      `count=${(await annots()).length}`,
    )
    await toolbarBtn('高亮') // 退出工具

    // ② 区域高亮：同样这块地方照样能画
    check('切到「区域高亮」', await toolbarBtn('区域高亮'))
    await sleep(220)
    check('工具状态已切到 area', (await snap()).tool === 'area', `tool=${(await snap()).tool}`)
    await dragOn(bx, by, bx + bw, by + bh)
    await sleep(300)
    const area = (await annots()).find((a) => a.kind === 'area')
    check(
      '扫描件上区域高亮**能画出来**（B1 要补的缺口）',
      !!area,
      area ? `rect=${area.rect.map((n) => n.toFixed(0)).join(',')}pt` : '没生成',
    )
    await shot('12-area-on-scan')

    if (area) {
      const rgb255 = area.color.map((c) => Math.round(c * 255))
      const px = await colorPixels(rgb255, 40)
      check('画布上真的有色块（不是只有数据）', px > 400, `${px} px，色 rgb(${rgb255.join(',')})`)

      const underPx = Number(
        await evaluate(`
          (() => {
            const u = document.querySelector('.page-slot .annot-layer-under');
            if (!u) return 0;
            const d = u.getContext('2d').getImageData(0, 0, u.width, u.height).data;
            let n = 0;
            for (let i = 0; i < d.length; i += 4) if (d[i+3] > 200) n++;
            return n;
          })()
        `),
      )
      check(
        '区域高亮画在 under 层且 alpha 满格（跟文字高亮同一条渲染路径）',
        underPx > 400,
        `under 层不透明像素 ${underPx}`,
      )

      /*
       * 选中前**必须先退出工具** —— 这不是测试怪癖，是真实用户路径：
       * 区域高亮跟手写/方框一样**画完不自动退出**（连续盖好几块是常态），
       * 所以工具还开着时点下去是"再画一块"，不会变成选中。
       */
      await hotkey('Escape', 27)
      await sleep(180)
      check('Esc 退出了区域高亮工具', (await snap()).tool === 'none', `tool=${(await snap()).tool}`)

      const ac = await centerOf(area.id)
      await tap(ac.x, ac.y)
      const g = await selGeometry()
      check(
        '区域高亮**给**改大小手柄（它没有依附的文字，框本身就是内容）',
        !!g && g.handleCount === 8,
        g ? `手柄=${g.handleCount}` : 'null',
      )

      if (g?.handles?.se) {
        const r0 = [...area.rect]
        await dragOn(g.handles.se.x, g.handles.se.y, g.handles.se.x + 80, g.handles.se.y + 50)
        await sleep(280)
        const r1 = (await annots()).find((a) => a.id === area.id)
        check(
          '拉手柄能把区域高亮改大',
          !!r1 && r1.rect[2] - r1.rect[0] > r0[2] - r0[0] + 20,
          r1 ? `宽 ${(r0[2] - r0[0]).toFixed(0)} → ${(r1.rect[2] - r1.rect[0]).toFixed(0)}pt` : '找不到',
        )
        await shot('12-area-resized')
      }
    }

    await hotkey('Escape', 27)
    await sleep(150)
  }
  console.log('\n[13] 控制台')
  check(
    '没有未捕获异常 / error',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | ') || '干净',
  )

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`)
} catch (e) {
  failed++
  console.error('\n💥 测试崩了：', e)
} finally {
  try {
    if (ws?.readyState === 1) await send('Browser.close')
  } catch {
    /* ignore */
  }
  try {
    child?.kill('SIGKILL')
  } catch {
    /* ignore */
  }
  try {
    await rm(userDataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  process.exit(failed > 0 ? 1 : 0)
}
