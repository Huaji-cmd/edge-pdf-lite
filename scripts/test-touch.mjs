/**
 * 触屏（Surface / 平板）端到端验证 —— 手势到底归谁。
 *
 * 要回答的问题（用户的原始抱怨）：
 *   「点了高亮/手写之后，在浏览器上拖动会拖动页面返回上一页，而不是编辑」
 *
 * 拆成两层，分别验证：
 *
 * ① **浏览器有没有把手势抢走。** 这一层光看 CSS 值不够 —— 得看真实事件序列。
 *    探针挂在 `.viewport` 上统计 pointer 事件：**浏览器一旦决定自己滚，
 *    就会给页面发 `pointercancel`**。所以：
 *      没工具时 → 手指滑动应该看到 cancel（浏览器接管滚动，这是正常的）
 *      有工具时 → **cancel 必须是 0**（手势归我们，一张都不能被抢）
 *
 * ② **抢回来之后有没有真的在画。** 数据通道读 `__eplViewer.annots()`，
 *    断言真出了一条 ink；同时断言 `scrollTop` 没动（没被当成滚动）。
 *
 * ③ **双指有出路。** 单指被绘图占用后，翻页/缩放只剩双指这条路 ——
 *    双指拖动要能平移、捏合要能缩放，否则用户在触屏上根本翻不了页。
 *
 * 顺带验一条容易被忽略的计算样式：`overscroll-behavior` 必须是 contain/none。
 * 它是「滑到头 → 浏览器返回上一页」的开关，少了它前面全白搭。
 *
 * 用法：node scripts/test-touch.mjs [url]
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = resolve(ROOT, 'touch-shots')
await mkdir(SHOTS, { recursive: true })

const URL_TARGET = process.argv[2] ?? 'http://localhost:4173/'
const PDF = resolve(ROOT, 'public/testdata/real-1706.03762.pdf')
const PORT = Number(process.env.EPL_PORT ?? 9513)

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
  console.error(`找不到测试 PDF：${PDF}\n先跑 node scripts/make-testdata.mjs`)
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userDataDir = await mkdtemp(join(tmpdir(), 'epl-touch-'))
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

  // ---------------------------------------------------------------- 触摸事件

  /** 发一帧触摸。`type` 为 touchEnd 时 points 传空数组 */
  const touch = (type, points) =>
    send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map((p) => ({
        x: Math.round(p.x),
        y: Math.round(p.y),
        id: p.id ?? 1,
        radiusX: 8,
        radiusY: 8,
        force: 1,
      })),
    })

  /**
   * 播一整段手势。
   *
   * ⚠️ 每帧之间必须真的等一下 —— 浏览器是靠"一段时间内看到位移"来判定手势的，
   * 一口气把 12 帧全发出去，很多情况下一个 pointermove 都不会派发。
   */
  async function touchSeq(frames, { stepMs = 18 } = {}) {
    if (!frames.length) return
    await touch('touchStart', frames[0])
    await sleep(24)
    for (let i = 1; i < frames.length; i++) {
      await touch('touchMove', frames[i])
      await sleep(stepMs)
    }
    await sleep(30)
    await touch('touchEnd', [])
    await sleep(160)
  }

  /** 单指直线：返回逐帧坐标（每帧一个触摸点） */
  function singlePath(x0, y0, x1, y1, steps = 12) {
    const out = []
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      out.push([{ id: 1, x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t }])
    }
    return out
  }

  /**
   * 双指：两指始终关于 (cx,cy) 对称，半间距从 p0 变到 p1。
   * 半间距不变 = 纯平移；半间距变化 = 捏合缩放。
   */
  function twoFingerPath(cx, cy, p0, p1, dx, dy, steps = 12) {
    const out = []
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const p = p0 + (p1 - p0) * t
      out.push([
        { id: 1, x: cx - p + dx * t, y: cy + dy * t },
        { id: 2, x: cx + p + dx * t, y: cy + dy * t },
      ])
    }
    return out
  }

  // ---------------------------------------------------------------- 探针

  const probe = () =>
    evaluate(`JSON.stringify(window.__eplTouchProbe ?? null)`).then((s) => (s ? JSON.parse(s) : null))

  const resetProbe = () =>
    evaluate(`
      (() => {
        window.__eplTouchProbe = { down: 0, move: 0, up: 0, cancel: 0 };
        return true;
      })()
    `)

  const snap = () => evaluate(`JSON.stringify(window.__eplViewer.snapshot())`).then(JSON.parse)
  const annots = () => evaluate(`JSON.stringify(window.__eplViewer.annots())`).then(JSON.parse)

  const toolbarBtn = (label) =>
    evaluate(`
      (() => {
        const b = [...document.querySelectorAll('.toolbar .btn')]
          .find(x => x.textContent.trim() === ${JSON.stringify(label)});
        if (!b) return false;
        b.click();
        return true;
      })()
    `)

  const scrollTop = () => evaluate(`document.querySelector('.viewport').scrollTop`)
  const setScrollTop = (v) =>
    evaluate(`(() => { document.querySelector('.viewport').scrollTop = ${v}; return true; })()`)

  /** 计算样式：触屏行为由这两个属性决定 */
  const styles = () =>
    evaluate(`
      (() => {
        const vp = document.querySelector('.viewport');
        return JSON.stringify({
          touchAction: getComputedStyle(vp).touchAction,
          overscrollX: getComputedStyle(vp).overscrollBehaviorX,
          overscrollY: getComputedStyle(vp).overscrollBehaviorY,
          bodyOverscroll: getComputedStyle(document.body).overscrollBehaviorY,
          maxTouchPoints: navigator.maxTouchPoints,
        });
      })()
    `).then(JSON.parse)

  // ---------------------------------------------------------------- 开跑

  // 让页面认得"这是触屏"：maxTouchPoints > 0，且触摸事件走完整输入管线
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await send('Page.enable')
  await send('Runtime.enable')
  await send('DOM.enable')

  console.log(`\n→ 打开 ${URL_TARGET}`)
  await send('Page.navigate', { url: URL_TARGET })
  await sleep(1500)

  // 注入测试 PDF
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
  if (!ready) {
    await shot('00-load-failed')
    throw new Error('文档没加载起来')
  }

  // 指针事件探针（捕获阶段，先于业务监听器执行）
  await evaluate(`
    (() => {
      window.__eplTouchProbe = { down: 0, move: 0, up: 0, cancel: 0 };
      const vp = document.querySelector('.viewport');
      vp.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'touch') window.__eplTouchProbe.down++;
      }, true);
      vp.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'touch') window.__eplTouchProbe.move++;
      }, true);
      vp.addEventListener('pointerup', (e) => {
        if (e.pointerType === 'touch') window.__eplTouchProbe.up++;
      }, true);
      vp.addEventListener('pointercancel', () => {
        window.__eplTouchProbe.cancel++;
      }, true);
      return true;
    })()
  `)

  // ---------------------------------------------------------------- 1. 基座

  console.log('\n[1] 触屏基线')
  const st = await styles()
  check('页面认得这是触屏设备', st.maxTouchPoints > 0, `maxTouchPoints=${st.maxTouchPoints}`)
  check(
    'body 关闭了 overscroll（滑动导航的总开关）',
    st.bodyOverscroll === 'none',
    `overscroll-behavior-y=${st.bodyOverscroll}`,
  )
  check(
    '滚动容器 overscroll 是 contain',
    st.overscrollX === 'contain' && st.overscrollY === 'contain',
    `${st.overscrollX} / ${st.overscrollY}`,
  )
  check(
    '无工具时：手指归浏览器（touch-action 允许滚动）',
    /pan-x/.test(st.touchAction) && /pan-y/.test(st.touchAction) && !/^none/.test(st.touchAction),
    `touch-action=${st.touchAction}`,
  )

  const vpBox = JSON.parse(
    await evaluate(`
      (() => {
        const r = document.querySelector('.viewport').getBoundingClientRect();
        return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height });
      })()
    `),
  )
  const pageBox = JSON.parse(
    await evaluate(`
      (() => {
        const s = document.querySelector('.page-slot');
        const r = s.getBoundingClientRect();
        return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height });
      })()
    `),
  )

  // 在页面内部取三点，保证落点确实在 .page-slot 上（locatePage 靠 elementFromPoint）
  const midY = Math.round(pageBox.y + Math.min(pageBox.h * 0.45, vpBox.h * 0.55))
  const leftX = Math.round(pageBox.x + pageBox.w * 0.25)
  const rightX = Math.round(pageBox.x + pageBox.w * 0.75)

  // ---------------------------------------------------------------- 2. 对照组：没工具时该滚动

  console.log('\n[2] 对照：没工具时单指滑动 = 滚动（这是正常行为）')
  await setScrollTop(0)
  await sleep(200)
  await resetProbe()
  {
    const before = await scrollTop()
    await touchSeq(singlePath(leftX, midY + 180, leftX, midY - 180))
    const after = await scrollTop()
    const p = await probe()
    check(
      '单指上滑滚动了页面',
      after > before + 40,
      `scrollTop ${Math.round(before)} → ${Math.round(after)}`,
    )
    // 浏览器一旦决定自己接管滚动，就会给页面发 pointercancel。
    // 这里看到 cancel 恰恰说明"这一层确实是浏览器说了算" —— 是有效的对照。
    check(
      '滚动时浏览器按约定发 pointercancel 收走手势',
      p.cancel > 0,
      `down=${p.down} move=${p.move} cancel=${p.cancel}`,
    )
    check('对照阶段没有生成批注', (await annots()).length === 0, `count=${(await annots()).length}`)
  }

  // ---------------------------------------------------------------- 3. 核心：激活工具后单指 = 画

  console.log('\n[3] 核心：激活手写后单指拖动 = 画（不能被抢）')
  check('切到「手写」', await toolbarBtn('手写'))
  await sleep(300)

  const st2 = await styles()
  check(
    '手写工具激活 → touch-action 变成 none',
    st2.touchAction === 'none',
    `touch-action=${st2.touchAction}`,
  )

  const beforeCount = (await annots()).length
  await resetProbe()
  {
    const scrollBefore = await scrollTop()
    await touchSeq(singlePath(leftX, midY - 60, rightX, midY - 60))

    /*
     * ⚠️ 这条断言是整个修复的**原点**。
     *
     * 旧行为下横向拖动会让滚动容器 overscroll，浏览器把这理解成"用户想后退"，
     * 直接把页面导航走 —— 用户描述的就是这个。此时 `.viewport` 连同页面一起
     * 消失，后面所有断言都会变成 `null.scrollTop` 之类的假错误，反而掩盖真因。
     *
     * 所以这里**先**单独确认页面还在，不在就立刻中止并留下证据截图。
     */
    const alive = await evaluate(`!!document.querySelector('.viewport')`)
    if (
      !check(
        '拖完页面还在（没被「滑动返回上一页」带走）',
        alive,
        alive ? '' : '⚠️ 页面已被导航走 —— 这正是用户报的那个 bug 复现了',
      )
    ) {
      await shot('99-navigated-away')
      throw new Error('手势把页面导航走了，后续断言失去意义')
    }

    const scrollAfter = await scrollTop()
    const p = await probe()
    const list = await annots()
    const ink = list.filter((a) => a.kind === 'ink')

    check(
      '笔画真的画出来了（生成了 ink 批注）',
      ink.length > beforeCount,
      `ink ${beforeCount} → ${ink.length}`,
    )
    check(
      '⚠️ 浏览器一次都没抢走手势（pointercancel = 0）',
      p.cancel === 0,
      `down=${p.down} move=${p.move} up=${p.up} cancel=${p.cancel}`,
    )
    check(
      '拖动期间页面没有被滚动（没被当成滑动翻页）',
      Math.abs(scrollAfter - scrollBefore) < 8,
      `scrollTop ${Math.round(scrollBefore)} → ${Math.round(scrollAfter)}`,
    )
    check('收到了连续的 pointermove（不是只来一发）', p.move >= 5, `move=${p.move}`)
    await shot('01-ink-by-touch')
  }

  // ---------------------------------------------------------------- 4. 双指平移

  console.log('\n[4] 双指拖动 = 平移（单指被绘图占用后的翻页出口）')
  await setScrollTop(0)
  await sleep(200)
  {
    const countBefore = (await annots()).length
    const before = await scrollTop()
    // 半间距恒定 60 → 纯平移；整段向上挪 240
    await touchSeq(twoFingerPath(vpBox.x + vpBox.w / 2, midY + 60, 60, 60, 0, -240))
    const after = await scrollTop()
    check(
      '双指拖动平移了页面',
      after > before + 60,
      `scrollTop ${Math.round(before)} → ${Math.round(after)}`,
    )
    check(
      '双指手势没有留下乱线（第一指的画被取消）',
      (await annots()).length === countBefore,
      `count ${countBefore} → ${(await annots()).length}`,
    )
    await shot('02-two-finger-pan')
  }

  // ---------------------------------------------------------------- 5. 双指捏合

  console.log('\n[5] 双指捏合 = 缩放')
  {
    const s0 = await snap()
    const before = (await annots()).length
    // 半间距 40 → 100，即手指间距 80 → 200，约 2.5×
    await touchSeq(twoFingerPath(vpBox.x + vpBox.w / 2, midY, 40, 100, 0, 0))
    await sleep(600) // 等 COMMIT_DELAY 落定
    const s1 = await snap()
    check(
      '捏合把缩放放大了',
      s1.scale > s0.scale * 1.3,
      `scale ${s0.scale.toFixed(2)} → ${s1.scale.toFixed(2)}`,
    )
    check('缩放后预览缩放已落定（previewScale 归 1）', s1.previewScale === 1, `previewScale=${s1.previewScale}`)
    check('捏合没有生成批注', (await annots()).length === before, `count=${(await annots()).length}`)
    await shot('03-pinch-zoom')
  }

  // ---------------------------------------------------------------- 6. markup 工具不能关掉滚动

  console.log('\n[6] 高亮这类「标记工具」要保持可滚动（它靠浏览器原生选区）')
  await toolbarBtn('高亮')
  await sleep(300)
  {
    const s = await styles()
    check(
      '高亮工具下 touch-action 不是 none',
      s.touchAction !== 'none',
      `touch-action=${s.touchAction}`,
    )
  }
  await toolbarBtn('高亮') // 再点一次关掉工具
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'})); true`)
  await sleep(200)

  // ---------------------------------------------------------------- 7. 控制台

  console.log('\n[7] 控制台')
  check(
    '没有未捕获异常 / error',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | ') || '干净',
  )

  console.log(
    `\n${failed === 0 ? '✅' : '❌'} 触屏验证：${passed}/${passed + failed} 通过  （截图在 touch-shots/）`,
  )
  console.log(`   合计 ${passed} 项通过，${failed} 项失败\n`)
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
