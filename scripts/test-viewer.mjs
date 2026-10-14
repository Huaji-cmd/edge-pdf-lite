/**
 * 阅读器（M2）端到端验证。
 *
 * 用 CDP 驱动本机 Edge 无头，像真人一样：选文件 → 滚动 → 缩放 → 翻页 → 切双页，
 * 每一步都断言，并且截图存到 viewer-shots/ 供人工核对。
 *
 * 用法：node scripts/test-viewer.mjs [url]
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clickByTidExpr } from './testids.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = resolve(ROOT, 'viewer-shots')
await mkdir(SHOTS, { recursive: true })

const URL_TARGET = process.argv[2] ?? 'http://localhost:4173/'
const PDF = resolve(ROOT, 'public/testdata/real-1706.03762.pdf')
const PORT = Number(process.env.EPL_PORT ?? 9501)

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
const userDataDir = await mkdtemp(join(tmpdir(), 'epl-viewer-'))
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
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      consoleErrors.push(
        (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300),
      )
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(
        'EXCEPTION: ' + (m.params.exceptionDetails?.exception?.description ?? '').slice(0, 300),
      )
    }
    /*
     * ⚠️ 有未保存批注时，应用注册了 `beforeunload` —— 重载页面会弹确认框，
     *    而**弹窗期间 CDP 命令会一直等**：套件不是失败，是整个卡死
     *    （实测卡了 7 分钟，什么都看不到）。测试里一律确认 ——
     *    "丢掉未保存的批注"正是我们想要的。
     */
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
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    }
    return r.result?.value
  }

  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'))
  }

  /** 视口内每一页的渲染状态 —— 复用的小探针 */
  const VISIBLE_STATE = `(() => {
    const vp = document.querySelector('.viewport').getBoundingClientRect();
    const vis = [...document.querySelectorAll('.page-slot')].filter(s => {
      const b = s.getBoundingClientRect();
      return b.bottom > vp.top && b.top < vp.bottom;
    });
    return JSON.stringify({
      total: vis.length,
      withCanvas: vis.filter(s => s.querySelector('canvas')).length,
      zoom: document.querySelector('[data-tid="zoom"]')?.innerText ?? '',
      totalCanvases: document.querySelectorAll('.pdf-page-canvas').length,
    });
  })()`

  /** 等"视口内每一页都画出来"，返回最后一次状态 */
  async function waitVisibleRendered(attempts = 25) {
    let st = { total: 0, withCanvas: 0, zoom: '', totalCanvases: 0 }
    for (let i = 0; i < attempts; i++) {
      st = JSON.parse(await evaluate(VISIBLE_STATE))
      if (st.total > 0 && st.withCanvas === st.total) return st
      await sleep(400)
    }
    return st
  }

  await send('Runtime.enable')
  await send('Page.enable')
  await send('DOM.enable')

  console.log(`→ 打开 ${URL_TARGET}`)
  await send('Page.navigate', { url: URL_TARGET })
  await sleep(2000)

  // ---------------------------------------------------------------- 1. 空状态
  console.log('\n[1] 空状态')
  check('显示了欢迎页', await evaluate(`!!document.querySelector('.welcome')`))
  await shot('01-welcome')

  // ---------------------------------------------------------------- 2. 选文件
  console.log('\n[2] 打开本地 PDF')
  const { root } = await send('DOM.getDocument', { depth: -1 })
  const { nodeId } = await send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: 'input[type=file]',
  })
  if (!nodeId) throw new Error('找不到 file input')
  await send('DOM.setFileInputFiles', { files: [PDF], nodeId })

  // 等页面解析完并画出至少一页
  let ready = false
  for (let i = 0; i < 120; i++) {
    await sleep(500)
    const canvases = await evaluate(`document.querySelectorAll('.pdf-page-canvas').length`)
    const loading = await evaluate(`!!document.querySelector('.loading')`)
    if (!loading && canvases > 0) {
      ready = true
      break
    }
  }
  check('文档已加载并出现画布', ready)
  if (!ready) {
    await shot('02-load-failed')
    throw new Error('文档加载失败，已截图')
  }

  const info = JSON.parse(
    await evaluate(`JSON.stringify({
      numPages: document.querySelector('.page-input')?.max ?? '',
      slots: document.querySelectorAll('.page-slot').length,
      canvases: document.querySelectorAll('.pdf-page-canvas').length,
      firstCanvas: (() => {
        const c = document.querySelector('.pdf-page-canvas')
        return c ? c.width + 'x' + c.height : ''
      })(),
      toolbarText: document.querySelector('.toolbar')?.innerText.replace(/\\s+/g, ' ').slice(0, 120) ?? '',
    })`),
  )
  console.log(`     页数=${info.numPages} 插槽=${info.slots} 画布=${info.canvases} 首个画布=${info.firstCanvas}`)
  check('页数被解析出来', Number(info.numPages) > 5, `numPages=${info.numPages}`)
  check('为每一页都建了插槽', info.slots === Number(info.numPages))
  check('只渲染了视口附近的页（懒渲染）', info.canvases > 0 && info.canvases < 12, `画布数=${info.canvases}`)
  check('画布尺寸非零', /^\d+x\d+$/.test(info.firstCanvas) && Number(info.firstCanvas.split('x')[0]) > 100)
  await shot('02-loaded')

  // ---------------------------------------------------------------- 3. Ctrl+滚轮缩放
  console.log('\n[3] Ctrl+滚轮缩放')
  const before = JSON.parse(
    await evaluate(`JSON.stringify({
      zoom: document.querySelector('[data-tid="zoom"]').innerText,
      firstLeft: document.querySelector('.page-slot').getBoundingClientRect().left,
      firstWidth: document.querySelector('.page-slot').getBoundingClientRect().width,
    })`),
  )
  // 在视口中心发 8 次 ctrl+wheel
  await evaluate(`
    (() => {
      const vp = document.querySelector('.viewport');
      const r = vp.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      for (let i = 0; i < 8; i++) {
        vp.dispatchEvent(new WheelEvent('wheel', {
          deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true, clientX: x, clientY: y,
        }));
      }
      return true;
    })()
  `)
  // 等落定（commit 延迟 180ms + 重排）
  await sleep(1500)
  const after = JSON.parse(
    await evaluate(`JSON.stringify({
      zoom: document.querySelector('[data-tid="zoom"]').innerText,
      firstWidth: document.querySelector('.page-slot').getBoundingClientRect().width,
      canvases: document.querySelectorAll('.pdf-page-canvas').length,
    })`),
  )
  console.log(`     缩放 ${before.zoom} → ${after.zoom}，页宽 ${before.firstWidth.toFixed(0)} → ${after.firstWidth.toFixed(0)}`)
  check('缩放百分比变了', before.zoom !== after.zoom)
  check('页面被真正放大了（layout 生效）', after.firstWidth > before.firstWidth * 1.2)

  // ⚠️ 用户报的 bug：放大之后之前渲染过的内容丢失，而且迟迟不重新渲染
  const zoomRender = await waitVisibleRendered(25)
  console.log(
    `     放大后视口内 ${zoomRender.withCanvas}/${zoomRender.total} 页已渲染（全文档存活画布 ${zoomRender.totalCanvases}）`,
  )
  check(
    '放大后视口内的页都重新渲染出来了',
    zoomRender.total > 0 && zoomRender.withCanvas === zoomRender.total,
    `只有 ${zoomRender.withCanvas}/${zoomRender.total} 页有画布`,
  )
  await shot('03-zoomed')

  // ---------------------------------------------------------------- 4. 滚动 + 懒渲染
  console.log('\n[4] 滚动 + 懒渲染')
  const scrollResult = JSON.parse(
    await evaluate(`
      (async () => {
        const vp = document.querySelector('.viewport');
        const t0 = performance.now();
        for (let i = 0; i < 30; i++) {
          vp.scrollTop += 600;
          await new Promise(r => requestAnimationFrame(r));
        }
        await new Promise(r => setTimeout(r, 2500));
        return JSON.stringify({
          scrollTop: Math.round(vp.scrollTop),
          canvases: document.querySelectorAll('.pdf-page-canvas').length,
          currentPage: document.querySelector('.page-input')?.value ?? '',
          ms: Math.round(performance.now() - t0),
        });
      })()
    `),
  )
  console.log(`     scrollTop=${scrollResult.scrollTop} 当前页=${scrollResult.currentPage} 存活画布=${scrollResult.canvases}`)
  check('确实滚动了', scrollResult.scrollTop > 1000)
  check('当前页码跟着更新', Number(scrollResult.currentPage) > 1, `第 ${scrollResult.currentPage} 页`)
  check('离屏页面的画布被回收（内存可控）', scrollResult.canvases < 30, `存活画布=${scrollResult.canvases}`)
  await shot('04-scrolled')

  // ⚠️ 用户报的 bug 路径：位图被回收之后又滚回来，必须能重新渲染。
  // 曾经的写法里 release() 只清 doneKey、不清 wantKey，
  // 于是滚回来时 request() 认为"需求没变"直接 return → 那一页永远空白。
  //
  // 关键：**必须先确认"回收"真的发生了**，否则这条测试等于没测。
  console.log('\n[4b] 滚回去要能重新渲染（回收后复现路径）')
  const recycled = JSON.parse(
    await evaluate(`
      (async () => {
        const vp = document.querySelector('.viewport');
        const before = document.querySelectorAll('.pdf-page-canvas').length;
        vp.scrollTop = vp.scrollHeight;          // 滚到最底
        await new Promise(r => setTimeout(r, 3000));
        return JSON.stringify({
          before,
          after: document.querySelectorAll('.pdf-page-canvas').length,
          scrollTop: Math.round(vp.scrollTop),
          snap: globalThis.__eplViewer?.snapshot?.() ?? null,
        });
      })()
    `),
  )
  console.log(`     滚到底：画布 ${recycled.before} → ${recycled.after}（scrollTop=${recycled.scrollTop}）`)
  if (recycled.snap) {
    const s = recycled.snap
    console.log(`     scale=${s.scale} visible=[${s.visible.join(',')}] slotEls=${s.slotEls} io=${s.ioAlive}`)
    console.log(
      '     状态机：' +
        s.pages
          .map((p) => `${p.p}(${p.want || '-'}|${p.done || '-'}|${p.canvas ? 'C' : '·'})`)
          .join(' '),
    )
  }
  check('滚动到底后确实回收了离屏页面的位图', recycled.after < recycled.before || recycled.after <= 4, `剩余 ${recycled.after}`)

  await evaluate(`
    (async () => {
      document.querySelector('.viewport').scrollTop = 0;
      await new Promise(r => setTimeout(r, 800));
      return true;
    })()
  `)
  const backState = await waitVisibleRendered(25)
  console.log(`     滚回顶部后视口内 ${backState.withCanvas}/${backState.total} 页已渲染`)
  check(
    '滚回已回收过的页面能重新渲染出来',
    backState.total > 0 && backState.withCanvas === backState.total,
    `${backState.withCanvas}/${backState.total}`,
  )
  await shot('04b-back')

  // ---------------------------------------------------------------- 5. 翻页
  console.log('\n[5] 页码跳转')
  const jump = JSON.parse(
    await evaluate(`
      (async () => {
        const input = document.querySelector('.page-input');
        input.value = '10';
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 1200));
        const vp = document.querySelector('.viewport');
        return JSON.stringify({ scrollTop: Math.round(vp.scrollTop), page: input.value });
      })()
    `),
  )
  check('跳到第 10 页后滚动位置改变了', jump.scrollTop > 0, `scrollTop=${jump.scrollTop}`)
  await shot('05-page10')

  // ---------------------------------------------------------------- 6. 适应宽度
  console.log('\n[6] 适应宽度 / 整页')
  const fit = JSON.parse(
    await evaluate(`
      (async () => {
        document.querySelector('[data-tid="fit-width"]')?.click();
        await new Promise(r => setTimeout(r, 900));
        const vp = document.querySelector('.viewport');
        const slot = document.querySelector('.page-slot');
        const sr = slot.getBoundingClientRect();
        const vr = vp.getBoundingClientRect();
        return JSON.stringify({
          zoom: document.querySelector('[data-tid="zoom"]').innerText,
          slotWidth: Math.round(sr.width),
          viewportWidth: Math.round(vr.width),
          overflow: sr.width > vr.width + 2,
        });
      })()
    `),
  )
  console.log(`     适宽后 zoom=${fit.zoom} 页宽=${fit.slotWidth} 视口宽=${fit.viewportWidth}`)
  check('适宽后页面不超过视口宽度', !fit.overflow, `页宽 ${fit.slotWidth} / 视口 ${fit.viewportWidth}`)
  await shot('06-fit-width')

  // ---------------------------------------------------------------- 7. 双页
  console.log('\n[7] 双页并排')
  const dual = JSON.parse(
    await evaluate(`
      (async () => {
        // 先回到靠前的页，截图才有代表性
        const pin = document.querySelector('.page-input');
        pin.value = '5';
        pin.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 1200));

        document.querySelector('[data-tid="mode-dual"]')?.click();
        await new Promise(r => setTimeout(r, 300));
        // 双页下先"适宽"，两页才会同时进视口（否则 195% 下单页就占满了）
        document.querySelector('[data-tid="fit-width"]')?.click();

        // 关键：等"视口内每一页都画出画布"再断言。
        // 这里正是踩过的坑 —— 版面变化后 IO 不再回调，
        // 之前被回收的可见页没人去请求，会一直空白。
        let visibleInfo = { total: 0, withCanvas: 0 };
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 300));
          const vp = document.querySelector('.viewport').getBoundingClientRect();
          const vis = [...document.querySelectorAll('.page-slot')].filter(s => {
            const b = s.getBoundingClientRect();
            return b.bottom > vp.top && b.top < vp.bottom;
          });
          visibleInfo = {
            total: vis.length,
            withCanvas: vis.filter(s => s.querySelector('canvas')).length,
          };
          if (visibleInfo.total >= 2 && visibleInfo.withCanvas === visibleInfo.total) break;
        }

        const slots = [...document.querySelectorAll('.page-slot')].slice(0, 6);
        const tops = slots.map(s => Math.round(s.getBoundingClientRect().top));
        const lefts = slots.map(s => Math.round(s.getBoundingClientRect().left));
        const w = document.querySelector('[data-tid="zoom"]').innerText;
        return JSON.stringify({
          tops, lefts, zoom: w,
          visibleTotal: visibleInfo.total,
          visibleWithCanvas: visibleInfo.withCanvas,
          canvases: document.querySelectorAll('.pdf-page-canvas').length,
        });
      })()
    `),
  )
  console.log(`     前 6 页 top=${dual.tops.join(',')} left=${dual.lefts.join(',')}`)
  console.log(`     适宽后 zoom=${dual.zoom} · 视口内 ${dual.visibleWithCanvas}/${dual.visibleTotal} 页已渲染`)
  check('双页模式：前两页在同一行（top 相同）', dual.tops[0] === dual.tops[1])
  check('双页模式：同一行两页左右不同', dual.lefts[0] !== dual.lefts[1])
  check('双页适宽后同屏能看到两页', dual.visibleTotal >= 2, `视口内 ${dual.visibleTotal} 页`)
  check(
    '视口内每一页都画出来了（含版面变化后新进入的页）',
    dual.visibleTotal > 0 && dual.visibleWithCanvas === dual.visibleTotal,
  )
  await shot('07-dual')

  /*
   * ---------------------------------------------------------------- 7b. 切模式不换页
   *
   * 用户报的："从双页切换成单页时页码会除以 2，这是不对的，切换时保持页码不变"。
   *
   * 根因：双页一行放两页，内容总高差不多只有单页的一半 —— 版面的 y 坐标全变了，
   * 而 `scrollTop` 是像素偏移、不会自己换算。保持同一个偏移，落在的页就变了：
   *   双页第 13 页 → 切单页 → 第 7 页（正好一半）。
   * ⚠️ 判据必须**跟切换前那一页比**，不能跟"最初那页"比 —— 我第一版就是这么写错的：
   *   单页7 → 双页13 → 单页7 会"看起来对"，其实来回都被换了一次页。
   */
  console.log('\n[7b] 切单/双页：当前页保持不变')
  const pageNow = async () => Number(await evaluate(`document.querySelector('.page-input').value`))
  const jumpTo = async (n) => {
    await evaluate(`(() => {
      const i = document.querySelector('.page-input');
      i.value = '${n}';
      i.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    await sleep(900)
    return pageNow()
  }
  const setMode = async (m) => {
    await evaluate(`document.querySelector('[data-tid="mode-${m}"]')?.click()`)
    await sleep(1100)
    return pageNow()
  }

  await setMode('single')
  const p7 = await jumpTo(7)
  check('先回到单页第 7 页', p7 === 7, `第 ${p7} 页`)
  const afterDual = await setMode('dual')
  check('单页 7 → 切双页：还是第 7 页', afterDual === 7, `第 ${afterDual} 页`)

  const p13 = await jumpTo(13)
  check('双页下跳到第 13 页', p13 === 13, `第 ${p13} 页`)
  const afterSingle = await setMode('single')
  check(
    '双页 13 → 切单页：还是第 13 页（不是 7）',
    afterSingle === 13,
    `第 ${afterSingle} 页`,
  )
  const snapAfter = JSON.parse(await evaluate(`JSON.stringify(globalThis.__eplViewer.snapshot())`))
  check('滚动位置与记录的当前页一致（不是只改了显示）', snapAfter.page === 13, `snapshot.page=${snapAfter.page}`)
  await shot('07b-mode-switch-keeps-page')

  // ---------------------------------------------------------------- 8. 文本层
  console.log('\n[8] 文本层（可选中 / 复制 / 查找）')
  const textInfo = JSON.parse(
    await evaluate(`
      (async () => {
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 400));
          if (document.querySelector('.text-layer span')) break;
        }
        const layers = [...document.querySelectorAll('.text-layer')];
        const spans = [...document.querySelectorAll('.text-layer span')];
        // 判据一（强）：文本层容器的尺寸必须和它所属页槽一致。
        // pdf.js 用 --total-scale-factor × 页面原始尺寸 算这个尺寸，
        // 所以尺寸对上了就说明那个变量给对了。
        let boxDiff = null;
        if (layers[0]) {
          const lr = layers[0].getBoundingClientRect();
          const sr = layers[0].closest('.page-slot')?.getBoundingClientRect();
          if (sr) boxDiff = { dw: Math.abs(lr.width - sr.width), dh: Math.abs(lr.height - sr.height) };
        }
        // 判据二（弱，只看有没有整体跑偏）：span 是否大致落在页内。
        // PDF 里本来就有超出页框的文字，所以不能要求 100%。
        const checked = spans.slice(0, 200);
        let inside = 0, sized = 0;
        const outliers = [];
        for (const s of checked) {
          const slot = s.closest('.page-slot');
          if (!slot) continue;
          const sb = slot.getBoundingClientRect();
          const b = s.getBoundingClientRect();
          if (b.width > 0 && b.height > 0) sized++;
          const dx = Math.max(sb.left - b.left, b.right - sb.right, 0);
          const dy = Math.max(sb.top - b.top, b.bottom - sb.bottom, 0);
          if (b.width > 0 && b.height > 0 && dx <= 40 && dy <= 40) inside++;
          else if (outliers.length < 5) {
            outliers.push({
              t: (s.textContent ?? '').slice(0, 18),
              dx: Math.round(dx), dy: Math.round(dy),
              w: Math.round(b.width), h: Math.round(b.height),
            });
          }
        }
        // 选中测试
        let selected = '';
        const first = spans.find(s => (s.textContent ?? '').trim().length > 3);
        if (first) {
          const r = document.createRange();
          r.selectNodeContents(first);
          const g = window.getSelection();
          g.removeAllRanges();
          g.addRange(r);
          selected = g.toString().slice(0, 40);
          g.removeAllRanges();
        }
        return JSON.stringify({
          layers: layers.length,
          spans: spans.length,
          checked: checked.length,
          sized,
          inside,
          outliers,
          boxDiff,
          selected,
          text: (layers[0]?.textContent ?? '').replace(/\\s+/g, ' ').slice(0, 120),
        });
      })()
    `),
  )
  console.log(
    `     文本层 ${textInfo.layers} 层 · span ${textInfo.spans} 个 · 大致在页内 ${textInfo.inside}/${textInfo.checked}`,
  )
  console.log(
    `     文本层尺寸与页槽偏差：${textInfo.boxDiff ? `${textInfo.boxDiff.dw.toFixed(1)} × ${textInfo.boxDiff.dh.toFixed(1)} px` : '取不到'}`,
  )
  if (textInfo.outliers?.length) {
    console.log('     越界的 span（dx/dy = 超出页框多少 px）：')
    for (const o of textInfo.outliers) {
      console.log(`        dx=${o.dx} dy=${o.dy} 尺寸=${o.w}x${o.h}  「${o.t}」`)
    }
  }
  console.log(`     抽到的文字：「${textInfo.text}」`)
  check('生成了文本层', textInfo.layers > 0)
  check('文本层里有足够的文本片段', textInfo.spans > 20, `${textInfo.spans} 个 span`)
  check('span 都有实际尺寸', textInfo.sized > 0, `${textInfo.sized}/${textInfo.checked}`)
  check(
    '文本层尺寸与页槽一致（--total-scale-factor 生效）',
    !!textInfo.boxDiff && textInfo.boxDiff.dw < 2 && textInfo.boxDiff.dh < 2,
    textInfo.boxDiff ? `偏差 ${textInfo.boxDiff.dw.toFixed(1)}×${textInfo.boxDiff.dh.toFixed(1)} px` : '取不到',
  )
  check(
    'span 没有整体跑偏',
    textInfo.checked > 0 && textInfo.inside >= textInfo.checked * 0.9,
    `${textInfo.inside}/${textInfo.checked}`,
  )
  check('能选中文字', textInfo.selected.length > 0, `选中「${textInfo.selected}」`)

  // 把文本层的字染成半透明红再截图 —— 这样能**用眼睛**确认它和画布上的字对齐。
  // 只靠数字判断不出"位置对不对"（span 有尺寸、在页内，也可能是整体偏了）。
  await evaluate(`
    (() => {
      const st = document.createElement('style');
      st.id = 'epl-debug-text';
      st.textContent = '.text-layer span, .text-layer br { color: rgba(255,60,60,.55) !important; }';
      document.head.appendChild(st);
      return true;
    })()
  `)
  await sleep(400)
  const dbg = JSON.parse(
    await evaluate(`
      (() => {
        const spans = [...document.querySelectorAll('.text-layer span')];
        const vis = spans.filter(s => {
          const cs = getComputedStyle(s);
          const b = s.getBoundingClientRect();
          return cs.color !== 'rgba(0, 0, 0, 0)' && b.width > 2 && b.height > 2;
        });
        const sample = spans[0] ? {
          color: getComputedStyle(spans[0]).color,
          fontSize: getComputedStyle(spans[0]).fontSize,
          transform: getComputedStyle(spans[0]).transform,
          opacity: getComputedStyle(spans[0]).opacity,
        } : null;
        const layer = document.querySelector('.text-layer');
        const lcs = layer ? getComputedStyle(layer) : null;
        return JSON.stringify({
          total: spans.length,
          visible: vis.length,
          sample,
          layer: lcs ? { zIndex: lcs.zIndex, overflow: lcs.overflow, display: lcs.display, visibility: lcs.visibility, opacity: lcs.opacity } : null,
        });
      })()
    `),
  )
  console.log(
    `     上色后可见 span ${dbg.visible}/${dbg.total}；样本 fontSize=${dbg.sample?.fontSize} color=${dbg.sample?.color}`,
  )
  console.log(
    `     文本层容器 z-index=${dbg.layer?.zIndex} display=${dbg.layer?.display} visibility=${dbg.layer?.visibility} opacity=${dbg.layer?.opacity}`,
  )
  check('上色后文本层确实可见（能用作目视核对）', dbg.visible > 10, `${dbg.visible}/${dbg.total}`)
  await shot('08b-text-layer-visible')
  // 再截一张放大的局部图 —— 整页缩略图上 9px 的红字看不清，
  // "对齐对不对"必须放大才能用眼睛判断
  const clip = JSON.parse(
    await evaluate(`
      (() => {
        const vp = document.querySelector('.viewport').getBoundingClientRect();
        // 要挑**当前可见**的那一层，不能拿 querySelector 的第一个
        // （那可能是几百页之前的，早就在视口外了）
        let slot = null;
        for (const layer of document.querySelectorAll('.text-layer')) {
          const s = layer.closest('.page-slot');
          if (!s) continue;
          const r = s.getBoundingClientRect();
          if (r.bottom > vp.top + 40 && r.top < vp.bottom - 40) { slot = s; break; }
        }
        if (!slot) return JSON.stringify(null);
        const sr = slot.getBoundingClientRect();
        const x = Math.max(vp.left, sr.left) + 24;
        const y = Math.max(vp.top, sr.top) + 24;
        const w = Math.min(420, sr.right - x - 12, vp.right - x - 12);
        const h = Math.min(190, sr.bottom - y - 12, vp.bottom - y - 12);
        return JSON.stringify(w > 60 && h > 60 ? { x, y, width: w, height: h } : null);
      })()
    `),
  )
  if (clip) {
    const r = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { ...clip, scale: 3 },
    })
    await writeFile(join(SHOTS, '08c-text-layer-zoom.png'), Buffer.from(r.data, 'base64'))
    console.log(`     放大截图：${Math.round(clip.width)}×${Math.round(clip.height)} @3x`)
  }
  await evaluate(`document.getElementById('epl-debug-text')?.remove()`)

  await shot('08-text-layer')

  // ---------------------------------------------------------------- 9. 阅读位置记忆
  console.log('\n[9] 阅读位置记忆（重新打开要回到原位）')
  const beforeReload = JSON.parse(
    await evaluate(`
      (async () => {
        const pin = document.querySelector('.page-input');
        // 用 9 而不是 10：双页模式下"当前页"记的是**每行的左页**，
        // 记住第 10 页的话恢复回来会显示 9，round-trip 对不上（这是设计取舍，不是 bug）
        pin.value = '9';
        pin.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 800));
        document.querySelector('[data-tid="mode-dual"]')?.click();
        await new Promise(r => setTimeout(r, 1800));
        return JSON.stringify({
          page: document.querySelector('.page-input')?.value ?? '',
          zoom: document.querySelector('[data-tid="zoom"]')?.innerText ?? '',
          dualOn: document.querySelector('[data-tid="mode-dual"]')?.classList.contains('on') ?? false,
        });
      })()
    `),
  )
  console.log(`     离开前：第 ${beforeReload.page} 页 · ${beforeReload.zoom} · 双页=${beforeReload.dualOn}`)
  await sleep(1500) // 等防抖保存落盘

  await send('Page.reload')
  await sleep(2500)

  // 重新加载后 file input 是空的，得再选一次同一个文件
  const doc2 = await send('DOM.getDocument', { depth: -1 })
  const q2 = await send('DOM.querySelector', { nodeId: doc2.root.nodeId, selector: 'input[type=file]' })
  await send('DOM.setFileInputFiles', { files: [PDF], nodeId: q2.nodeId })

  let afterReload = null
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    const st = JSON.parse(
      await evaluate(`JSON.stringify({
        page: document.querySelector('.page-input')?.value ?? '',
        zoom: document.querySelector('[data-tid="zoom"]')?.innerText ?? '',
        dualOn: document.querySelector('[data-tid="mode-dual"]')?.classList.contains('on') ?? false,
      })`),
    )
    afterReload = st
    if (st.page === beforeReload.page) break
  }
  console.log(`     重新打开后：第 ${afterReload?.page} 页 · ${afterReload?.zoom} · 双页=${afterReload?.dualOn}`)
  /*
   * 🔴 这条判据以前是**假绿**：它断言 `afterReload.page === beforeReload.page`，
   *    而当时 App 里有一行 `page.value = saved.page` 会把"想去的页码"直接写成工具栏页码 ——
   *    于是**恢复根本没发生**（画面停在第 1 页）也能过。实测就是这么骗过去的。
   *
   * 现在按真实语义判：
   *   · 双页模式下"当前页"是每行的**左页**（设计取舍），所以记 9 恢复回来可能是 8
   *   · 真正的回归是"停在第 1 页" —— 那说明恢复整个没生效
   */
  const wantPage = Number(beforeReload.page)
  const gotPage = Number(afterReload?.page)
  check(
    `恢复了阅读页码（第 ${wantPage} 页或它所在行的左页，总之不能是第 1 页）`,
    (gotPage === wantPage || gotPage === wantPage - 1) && gotPage !== 1,
    `恢复后=${gotPage}（修复前这里是 1：工具栏显示 ${wantPage}、画面却在第一页）`,
  )
  check('恢复了双页模式', afterReload?.dualOn === beforeReload.dualOn)
  check(
    '恢复了缩放（这条以前也是坏的：存 96% 打开变 150%）',
    afterReload?.zoom === beforeReload.zoom,
    `${afterReload?.zoom} vs ${beforeReload.zoom}`,
  )
  await shot('09-restored')

  // ---------------------------------------------------------------- 10. 批注
  console.log('\n[10] 批注（手写 → 高亮 → 擦除 → 撤销 → 缩放对齐）')

  /** 点工具栏上某个按钮 */
  const toolbarBtn = (label) => evaluate(clickByTidExpr(label))

  /** 读批注层状态：数量、位图尺寸、各类颜色像素数 */
  const annotState = async () =>
    JSON.parse(
      await evaluate(`
        (() => {
          const badge = document.querySelector('[data-tid="annot-count"]');
          // ⚠️ 每页现在是**两层** canvas：under(multiply, 只有高亮) / over(其余)。
          // 只查第一层会漏掉另一半 —— 按层号统计后相加。
          const layers = [...document.querySelectorAll('.page-slot .annot-layer')];
          let ink = 0, yellow = 0, any = 0;
          for (const layer of layers) {
            const d = layer.getContext('2d').getImageData(0, 0, layer.width, layer.height).data;
            for (let i = 0; i < d.length; i += 4) {
              const r = d[i], g = d[i+1], b = d[i+2], a = d[i+3];
              if (a > 20) any++;
              if (a > 60 && r > 150 && g < 130 && b < 130) ink++;
              // 高亮色是 (255,235,59)：multiply 层里就是原色（alpha=1）
              if (a > 60 && r > 200 && g > 170 && b < 190) yellow++;
            }
          }
          return JSON.stringify({
            count: badge ? Number(badge.textContent.trim()) : 0,
            hasLayer: layers.length > 0,
            layerCount: layers.length,
            layerW: layers.length ? layers[0].width : 0,
            layerH: layers.length ? layers[0].height : 0,
            ink, yellow, any,
          });
        })()
      `),
    )

  /** 把批注层单独导出成图，便于人工核对（截图缩略图看不清细节） */
  const dumpLayer = async (name) => {
    // 两层合成一张再导出 —— 单独导一层看不出最终观感
    const url = await evaluate(`
      (() => {
        const ls = [...document.querySelectorAll('.page-slot .annot-layer')];
        if (!ls.length) return '';
        if (ls.length === 1) return ls[0].toDataURL('image/png');
        const c = document.createElement('canvas');
        c.width = ls[0].width; c.height = ls[0].height;
        const x = c.getContext('2d');
        for (const l of ls) x.drawImage(l, 0, 0);
        return c.toDataURL('image/png');
      })()
    `)
    if (typeof url === 'string' && url.startsWith('data:image')) {
      await writeFile(join(SHOTS, `${name}.png`), Buffer.from(url.split(',')[1], 'base64'))
      console.log(`     （已导出 ${name}.png）`)
    }
  }

  // 用 CDP 发**真实鼠标事件**（浏览器会合成 pointerdown/move/up），
  // 比在页面里构造 PointerEvent 更接近真人操作 —— 能顺带验证指针捕获等真实行为。
  const mouseAt = (type, x, y, buttons) =>
    send('Input.dispatchMouseEvent', {
      type,
      x: Math.round(x),
      y: Math.round(y),
      button: 'left',
      buttons,
      clickCount: 1,
    })

  const dragOn = async (x0, y0, x1, y1, steps = 14) => {
    await mouseAt('mousePressed', x0, y0, 1)
    await sleep(30)
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      await mouseAt('mouseMoved', x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, 1)
      await sleep(10)
    }
    await mouseAt('mouseReleased', x1, y1, 0)
    await sleep(220)
  }

  // 先把状态收敛：单页 + 回到顶部（前面几项测试改过模式和页码）
  await toolbarBtn('单页')
  await sleep(400)
  await evaluate(`document.querySelector('.viewport').scrollTop = 0; true`)
  await sleep(600)

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
  check('拿到第 1 页在屏幕上的位置', !!box && box.w > 100, box ? `${Math.round(box.w)}×${Math.round(box.h)}` : 'null')

  // ---- 手写
  check('切到「手写」工具', await toolbarBtn('手写'))
  await sleep(200)
  const cx = box.x + box.w / 2
  const cy = box.y + Math.min(box.h * 0.45, 400)
  await dragOn(cx - 90, cy, cx + 90, cy + 40)

  const st1 = await annotState()
  check('手写后批注数 = 1', st1.count === 1, `count=${st1.count}`)
  check('批注层真的画出了墨迹（红色像素）', st1.ink > 100, `ink=${st1.ink}px`)
  await shot('10-ink')

  // ---- 高亮（选中文字）
  check('切到「高亮」工具', await toolbarBtn('高亮'))
  await sleep(200)
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
    await dragOn(line.x1, line.y, line.x2, line.y, 10)
    const st2 = await annotState()
    check('高亮后批注数 = 2', st2.count === 2, `count=${st2.count}`)
    check(
      '高亮是黄色填充（不是只画了条线）',
      st2.yellow > 800,
      `yellow=${st2.yellow}px, ink=${st2.ink}px, any=${st2.any}px`,
    )
    await shot('11-highlight')
    await dumpLayer('11b-annot-layer')
  }

  // ---- 擦除
  check('切到「擦除」工具', await toolbarBtn('擦除'))
  await sleep(200)
  await mouseAt('mousePressed', cx, cy + 20, 1)
  await mouseAt('mouseReleased', cx, cy + 20, 0)
  await sleep(280)
  const st3 = await annotState()
  check('擦除后批注数 = 1', st3.count === 1, `count=${st3.count}`)
  await shot('12-erased')

  // ---- 撤销
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))`)
  await sleep(320)
  const st4 = await annotState()
  check('Ctrl+Z 把擦掉的批注找回来了（=2）', st4.count === 2, `count=${st4.count}`)

  // ---- 缩放后重绘
  await toolbarBtn('手写') // 再点一次 = 退回阅读模式
  await sleep(200)
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '=', ctrlKey: true }))`)
  await sleep(1100)
  const st5 = await annotState()
  check(
    '缩放后批注层按新 scale 重建了位图',
    st5.layerW > st4.layerW,
    `${st4.layerW} → ${st5.layerW} px`,
  )
  check('缩放后墨迹/高亮仍在', st5.any > 50, `any=${st5.any}`)
  await shot('13-annot-zoomed')

  // ---------------------------------------------------------------- 11. 无报错
  console.log('\n[11] 翻页：单页 / 双页都必须单调前进')
  /*
   * 回归背景（用户实测报的 bug）：
   *   · 单页模式：点「下一页」第一次只改页码不动，要点两次才真的翻
   *   · 双页模式：前几页正常，之后点「下一页」会**往回跳**，一路退到第 1 页
   *
   * 根因：`goToPage` 定位时把 scrollTop 减了一个 `ANCHOR_GAP`（让页上方留点空隙），
   * 而 `updateCurrentPage` 由 scrollTop 反算行号时**没有加回来** ——
   * 于是永远算成**上一行**，`page-change` 把页码 emit 回去，
   * 下一次点击又从这个错值继续，就成了"倒着退"。
   *
   * 判据只要一条就够：**连点 N 次「下一页」，页码必须严格单调前进**。
   * 它同时覆盖上面两个现象，而且不会漏。
   */
  {
    const pageNow = async () => Number(await evaluate(`document.querySelector('.page-input').value`))
    const innerPage = async () =>
      Number(await evaluate(`globalThis.__eplViewer.snapshot().page`))
    const clickNext = async () => {
      await evaluate(`
        (() => {
          const b = document.querySelector('[data-tid="next"]');
          if (!b) return false;
          b.click();
          return true;
        })()
      `)
      await sleep(420)
    }
    const jumpTo = async (n) => {
      await evaluate(`
        (() => {
          const i = document.querySelector('.page-input');
          i.value = '${n}';
          i.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()
      `)
      await sleep(700)
    }

    // ① 单页模式：每次 +1
    await toolbarBtn('单页')
    await sleep(500)
    await jumpTo(1)
    const seq1 = []
    for (let i = 0; i < 4; i++) {
      await clickNext()
      seq1.push(await pageNow())
    }
    check(
      '单页模式：连点「下一页」每次前进 1 页',
      seq1.every((v, i) => v === i + 2),
      `1 → ${seq1.join(' → ')}`,
    )

    // ② 双页模式：每次前进一整行（+2），不能停在同行
    await toolbarBtn('双页')
    await sleep(700)
    await jumpTo(1)
    const seq2 = []
    for (let i = 0; i < 4; i++) {
      await clickNext()
      seq2.push(await pageNow())
    }
    check(
      '双页模式：连点「下一页」每次前进一整行（+2，不是停在同行）',
      seq2.every((v, i) => v === 3 + i * 2),
      `1 → ${seq2.join(' → ')}`,
    )

    // ③ 关键：跳转本身也不能倒退
    //    （用户最直观的症状："我在 103 页，点下一页回退到 101" —— 其实跳转那一刻
    //     页码就已经被算错了，点下一页只是把错值往前推了一步）
    const total = Number(await evaluate(`document.querySelector('.page-input').max`))
    const target = Math.max(3, total - 3)
    await jumpTo(target)
    const landed = await pageNow()
    check(
      `跳到第 ${target} 页后页码不能倒退（双页模式允许落到本行左页）`,
      landed >= target - 1,
      `请求 ${target} → 实际 ${landed}`,
    )

    // ④ 深处的页点「下一页」仍然要前进
    const before = await pageNow()
    await clickNext()
    const after = await pageNow()
    check(
      `双页模式：在第 ${before} 页点「下一页」必须前进`,
      after > before,
      `${before} → ${after}（倒退就是这个 bug 复现了）`,
    )

    // ④ 组件内部由 scrollTop 反算的页码，必须和工具栏显示的一致
    //    不一致 = 反算偏行（漏掉 ANCHOR_GAP 补偿的直接症状）
    const inner = await innerPage()
    check(
      '组件内部反算的当前页 == 工具栏显示的页码（反算没偏行）',
      inner === after,
      `内部=${inner} / 工具栏=${after}`,
    )

    await shot('11-paging')
    await toolbarBtn('单页')
    await sleep(400)
  }

  /*
   * ---------------------------------------------------------------- 11b. 阅读位置恢复
   *
   * 用户报的："记录下来了上次读到的页数，但打开时停在第一页。"
   * 根因是这条路上有两处**静默失败**：
   *   ① `restoreTo` 找不到目标页时 `?? l.pages[0]` —— 默默退回第 1 页；
   *   ② 版面还没就绪时 `if (!vp || !l) return` —— 什么都不做。
   * 两者的共同后果：调用方照旧把"想去的页码"写成工具栏页码 →
   * 出现"页码说第 N 页、画面在第一页"，提示还跟着一起撒谎。
   *
   * 判据要比"不是第 1 页"更强：直接要求工具栏和**内部反算的页**都等于最后一页
   * （越界时退到最近的一页才算诚实），并且提示说的页码必须和实际一致。
   *
   * ⚠️ 注入越界值必须在**没有文档打开**的时候做：应用在换文档/卸载时会
   *    把当前页 flushSave 落盘，先把值塞进去会被它覆盖掉。
   */
  console.log('\n[11b] 阅读位置恢复（越界页码不许偷偷回到第 1 页）')
  {
    // 先开一次，好知道这份文档的 reading 键名（键是内容指纹，事先猜不到）
    await send('Page.reload')
    await sleep(2500)
    const d1 = await send('DOM.getDocument', { depth: -1 })
    const q1 = await send('DOM.querySelector', { nodeId: d1.root.nodeId, selector: 'input[type=file]' })
    await send('DOM.setFileInputFiles', { files: [PDF], nodeId: q1.nodeId })
    await sleep(2500)
    const key = await evaluate(`Object.keys(localStorage).find((k) => k.startsWith('epl:reading:')) ?? ''`)
    check('打开文档后写下了阅读位置记录', /^epl:reading:/.test(key), key || '(没有)')

    // 重载 → 此刻**没有文档**，可以安全地注入越界页码
    await send('Page.reload')
    await sleep(2500)
    await evaluate(`localStorage.setItem(${JSON.stringify(key)}, JSON.stringify({
      page: 9999, scale: 1.5, mode: 'single', spreadOffset: 0, updatedAt: Date.now(),
    }))`)
    const d2 = await send('DOM.getDocument', { depth: -1 })
    const q2b = await send('DOM.querySelector', { nodeId: d2.root.nodeId, selector: 'input[type=file]' })
    await send('DOM.setFileInputFiles', { files: [PDF], nodeId: q2b.nodeId })
    await sleep(3000)

    const r = JSON.parse(
      await evaluate(`JSON.stringify({
        toolbar: Number(document.querySelector('[data-tid="page-input"]')?.value ?? 0),
        inner: globalThis.__eplViewer?.snapshot().page ?? 0,
        total: Number(document.querySelector('[data-tid="page-input"]')?.max ?? 0),
        scrollTop: Math.round(globalThis.__eplViewer?.snapshot().scrollTop ?? -1),
        toast: (document.querySelector('.toast') || {}).textContent || '',
      })`),
    )
    console.log(
      `     越界页码恢复后：工具栏=${r.toolbar} 内部=${r.inner} 总页数=${r.total} scrollTop=${r.scrollTop}`,
    )
    check(
      '越界页码退到「最后一页」，而不是默默回到第 1 页',
      r.total > 1 && r.inner === r.total,
      `内部=${r.inner} 总页数=${r.total}（修复前这里会是 1）`,
    )
    check('工具栏页码 == 内部反算的页码（页码和画面对得上）', r.toolbar === r.inner, `工具栏=${r.toolbar} 内部=${r.inner}`)
    check('真的滚下去了（不是停在页顶）', r.scrollTop > 100, `scrollTop=${r.scrollTop}`)
    check(
      '提示里说的页码就是实际落到的页码（提示不许说谎）',
      r.toast === '' || r.toast.includes(`第 ${r.inner} 页`),
      r.toast || '(没有提示)',
    )
    // 收尾：清掉这件人造的记录，别影响后面的用例
    await evaluate(`localStorage.removeItem(${JSON.stringify(key)})`)
  }

  console.log('\n[12] 控制台')
  const realErrors = consoleErrors.filter((e) => !/favicon|DevTools/i.test(e))
  check('没有控制台报错', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))

  console.log(`\n${'='.repeat(50)}`)
  console.log(`结果：${passed} 通过 / ${failed} 失败`)
  console.log(`截图目录：${SHOTS}`)
  console.log('='.repeat(50))
  process.exitCode = failed > 0 ? 1 : 0
} finally {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  child?.kill()
  await sleep(600)
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
}
