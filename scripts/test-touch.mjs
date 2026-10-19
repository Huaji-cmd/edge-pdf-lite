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
import { clickByTidExpr } from './testids.mjs'

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
  console.error(
    `找不到测试 PDF：${PDF}\n` +
      '先跑一次：npm run testdata:real\n' +
      '（这份「真实论文语料」不入库 —— 脚本会告诉你手动放一份也行）',
  )
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

  const toolbarBtn = (label) => evaluate(clickByTidExpr(label))

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

  /*
   * 6. 标记类工具（高亮 / 下划线 / 删除线）在触屏上单指要能**划出选区**。
   *
   * ⚠️ 这一段的前提被推翻过一次，改测试时务必看清楚：
   *    旧版本断言的是"标记工具下 touch-action 不能是 none"，理由是它要靠
   *    浏览器原生选区选词。但用户实测反馈"Surface 上高亮用不了，单指还是拖动"
   *    —— 因为 viewport 是可滚动容器，浏览器会把这一下判成 pan 并抢走手势，
   *    原生选区压根建立不起来。现在改成自己算选区（caretRangeFromPoint），
   *    所以 touch-action 必须 none，前提反过来了。
   *
   * 判据有三条，缺一不可：
   *   ① touch-action 是 none（手势归我们）
   *   ② 单指划过之后**真的生成了一条 highlight**
   *   ③ 划的过程中页面**没有滚动**（证明浏览器没把手势抢走）
   */
  console.log('\n[6] 标记工具在触屏上单指划选（Surface 上的老问题）')

  const before6 = (await annots()).length
  await toolbarBtn('高亮')
  await sleep(300)
  {
    const s = await styles()
    check(
      '高亮工具下 touch-action 是 none（手势归我们）',
      s.touchAction === 'none',
      `touch-action=${s.touchAction}`,
    )
  }

  /*
   * 找一行真实文字的位置。
   *
   * ⚠️ 必须挑**当前视口内**的 span：文本层里可能有一百多个 span，其中大部分
   *    滚在屏幕外，对它们的坐标调 elementFromPoint / caretRangeFromPoint
   *    一律返回 null（不是"没命中文字"，是"这个坐标在视口之外"）。
   *    第一版就是踩了这个 —— 症状是 caret 恒为 null，看着像功能没实现。
   */
  const pickLine = () =>
    evaluate(`
      (() => {
        const spans = [...document.querySelectorAll('.text-layer span')]
          .filter(s => (s.textContent || '').trim().length > 3);
        const H = window.innerHeight, W = window.innerWidth;
        for (const s of spans) {
          const r = s.getBoundingClientRect();
          if (r.width < 24 || r.height < 4) continue;
          if (r.top < 120 || r.bottom > H - 40) continue;   // 留出工具栏/边缘
          if (r.left < 8 || r.right > W - 8) continue;
          return JSON.stringify({
            x0: r.left + r.width * 0.15,
            x1: r.right - r.width * 0.15,
            y: r.top + r.height / 2,
            text: (s.textContent || '').trim().slice(0, 24),
          });
        }
        return 'null';
      })()
    `).then(JSON.parse)
  const line = await pickLine()

  if (!line) {
    check('找得到一行文字用来划选', false, '文本层里没找到可用的 span')
  } else {
    const top0 = await scrollTop()
    // 单指从这行的左边划到右边
    const frames = []
    for (let i = 0; i <= 8; i++) {
      frames.push([{ id: 1, x: line.x0 + ((line.x1 - line.x0) * i) / 8, y: line.y }])
    }
    await touchSeq(frames)
    await sleep(400)

    const list = await annots()
    check(
      '单指划过生成了一条高亮',
      list.length === before6 + 1 && list[list.length - 1]?.kind === 'highlight',
      `count ${before6} → ${list.length}，kind=${list[list.length - 1]?.kind ?? '无'}`,
    )
    const top1 = await scrollTop()
    check(
      '划选过程中页面没有跟着滚（浏览器没抢手势）',
      Math.abs(top1 - top0) < 4,
      `scrollTop ${top0} → ${top1}`,
    )
    /*
     * 判"有没有真的选中那行" —— 用**尺寸**而不是文字：
     * 快照里不带文字，而尺寸能抓住真正的失败模式：如果选区落到了画布上
     * （caretRangeFromPoint 命中了文本层之外的元素），矩形会横跨整页，
     * 宽高都是几百 pt。一行文字的高只会有十几 pt。
     */
    const a = list[list.length - 1]
    const w = a.rect[2] - a.rect[0]
    const h = a.rect[3] - a.rect[1]
    check(
      '高亮是"一行文字"的大小（不是横跨整页的一大块）',
      w > 8 && h > 4 && h < 40,
      `rect ${w.toFixed(1)}×${h.toFixed(1)} pt`,
    )
  }

  await toolbarBtn('高亮') // 再点一次关掉工具
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'})); true`)
  await sleep(200)

  // ---------------------------------------------------------------- 6b. 文本框手柄（触屏）

  console.log('\n[6b] 文本框在触屏上的移动 / 拉伸')
  /*
   * 用户报的现象："触屏下移动和拉伸都用不了，都是在移动页面。"
   *
   * 根因：`.viewport` 是 `touch-action: pan-x pan-y`。手指按在把手上时，浏览器
   * 先把这一下判成 pan → 开始滚页面，并给页面发 pointercancel，拖动当场断掉。
   * `preventDefault()` 在 pointerdown 里挡不住这个（touch-action 是**手势开始前**
   * 的声明，不是拦截），唯一解是给把手自己声明 `touch-action: none`。
   *
   * 所以这里量两件事，都能抓住那个 bug：
   *   ① 把手自己的 computed `touch-action` 是 none（声明对了）；
   *   ② 用**真实触摸序列**拖它：rect 真的变了。
   *
   * ⚠️ 另外还有一条"scrollTop 一点没动"，但**它在 CDP 下是弱判据**：
   *    `Input.dispatchTouchEvent` 注入的是合成事件，不驱动渲染进程的合成器滚动，
   *    所以就算把 `touch-action` 拿掉，scrollTop 照样不动（实测变异过）。
   *    它只在真机上有意义，留在这里是当**回归哨**（真出现了滚动就一定有鬼），
   *    不能当成"浏览器不会抢手势"的证据 —— 那个证据是 ① 和 ②。
   */
  {
    check('切到「文本框」工具', await toolbarBtn('文本框'))
    await sleep(200)

    // 取"当前页 ∩ 视口"的中心点 —— 不写死坐标，滚到哪儿都点得中
    const spot = await evaluate(`
      (() => {
        const vp = document.querySelector('.viewport').getBoundingClientRect();
        for (const el of document.querySelectorAll('.page-slot')) {
          const r = el.getBoundingClientRect();
          const left = Math.max(r.left, vp.left), right = Math.min(r.right, vp.right);
          const top = Math.max(r.top, vp.top), bottom = Math.min(r.bottom, vp.bottom);
          if (right - left > 120 && bottom - top > 120) {
            return JSON.stringify({ x: (left + right) / 2, y: (top + bottom) / 2 });
          }
        }
        return JSON.stringify(null);
      })()
    `).then((s) => JSON.parse(s))
    check('找到了一个在视口里的页面区域', !!spot, spot ? `(${Math.round(spot.x)}, ${Math.round(spot.y)})` : 'null')

    if (!spot) throw new Error('没有可点的页面区域，后面的触摸坐标无从谈起')

    // 单指轻点 → 就地建一个空文本框（编辑态自己会出来）
    /*
     * ⚠️ 建框点要**往左偏** 170px：框宽 150pt×scale 之后不算窄，再加上右边那个
     *    圆圈伸出框外 24px —— 建在视口正中时圆点会落到 x≈1273（窗口只有 1280），
     *    直接出屏，`elementFromPoint` 返回 null。这不是实现 bug，是测试站位不对。
     */
    await touchSeq([[{ id: 1, x: spot.x - 170, y: spot.y }]])
    await sleep(650)
    check(
      '触屏点一下就地建出文本框（编辑态打开）',
      await evaluate(`!!document.querySelector('.text-edit')`),
    )

    const gripPos = await evaluate(`
      (() => {
        const el = document.querySelector('[data-tid="te-grip"]');
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      })()
    `).then((s) => JSON.parse(s))
    check('编辑态里出现了「左边移动条」', !!gripPos)

    const taGrip = await evaluate(
      `(() => { const el = document.querySelector('[data-tid="te-grip"]'); return el ? getComputedStyle(el).touchAction : 'missing'; })()`,
    )
    check(
      '移动条自己声明 touch-action: none（声明缺失浏览器就会抢去滚页面）',
      taGrip === 'none',
      `touch-action=${taGrip}`,
    )

    const before = (await annots()).find((a) => a.kind === 'freetext')
    if (gripPos && before) {
      const st0 = await scrollTop()
      await touchSeq(singlePath(gripPos.x, gripPos.y, gripPos.x + 72, gripPos.y + 52))
      const st1 = await scrollTop()
      const after = (await annots()).find((a) => a.id === before.id)

      check(
        '触屏拖左边那条**能移动文本框**',
        !!after && Math.abs(after.rect[0] - before.rect[0]) > 8,
        after ? `x0 ${before.rect[0].toFixed(1)} → ${after.rect[0].toFixed(1)}pt` : '找不到',
      )
      check(
        '拖把手时页面**没有**跟着滚（用户报的就是这个）',
        Math.abs(st1 - st0) < 2,
        `scrollTop ${Math.round(st0)} → ${Math.round(st1)}`,
      )
    }

    // 右圆圈：调宽度
    /*
     * ⚠️ 必须等一下再读坐标：拖完左边那条之后，编辑框的新位置是**异步**算出来的
     *    （`refreshTextEditBox` 里要 await `doc.getPage()`）。立刻读会拿到旧位置，
     *    手指于是落在页面上 —— 编辑结束 → 空框被回收 → 后面就"找不到"这条批注了。
     */
    await sleep(350)
    const wPos = await evaluate(`
      (() => {
        const el = document.querySelector('[data-tid="te-widen"]');
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, box: r.width });
      })()
    `).then((s) => JSON.parse(s))
    check(
      '右圆圈的热区够手指按（≥20px，原来只有 12px 点不中）',
      !!wPos && wPos.box >= 20,
      wPos ? `${Math.round(wPos.box)}px` : 'null',
    )

    const taWiden = await evaluate(
      `(() => { const el = document.querySelector('[data-tid="te-widen"]'); return el ? getComputedStyle(el).touchAction : 'missing'; })()`,
    )
    check('右圆圈也声明了 touch-action: none', taWiden === 'none', `touch-action=${taWiden}`)

    if (wPos) {
      const b = (await annots()).find((a) => a.kind === 'freetext')
      if (b) {
        const hit = await evaluate(`
          (() => {
            const el = document.elementFromPoint(${Math.round(wPos.x)}, ${Math.round(wPos.y)});
            if (!el) return 'null';
            const t = el.closest('[data-tid]');
            return (t ? 'tid=' + t.dataset.tid : 'cls=' + String(el.className)) + ' <' + el.tagName + '>';
          })()
        `)
        // 只在没命中手柄时出声 —— 这行是排查"点了没反应"的抓手
        if (!hit.includes('te-widen')) {
          console.log(
            `     ⚠️ 右圆圈中心 (${Math.round(wPos.x)}, ${Math.round(wPos.y)}) 上命中的是 ${hit}`,
          )
        }
        const w0 = b.rect[2] - b.rect[0]
        await touchSeq(singlePath(wPos.x, wPos.y, wPos.x + 80, wPos.y))
        const a2 = (await annots()).find((a) => a.id === b.id)
        check(
          '触屏拖右圆圈**能改宽度**',
          !!a2 && a2.rect[2] - a2.rect[0] > w0 + 15,
          a2 ? `宽 ${w0.toFixed(0)} → ${(a2.rect[2] - a2.rect[0]).toFixed(0)}pt` : '找不到',
        )
      }
    }

    // 收尾：点页面另一处结束编辑，别把编辑态带进后面的控制台检查
    await touchSeq([[{ id: 1, x: spot.x + 160, y: spot.y + 200 }]])
    await sleep(350)
    check('点空白结束了编辑态', !(await evaluate(`!!document.querySelector('.text-edit')`)))
    await shot('06b-freetext-handles-touch')
  }

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
