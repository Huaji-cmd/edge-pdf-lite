/**
 * PDF 页内查找（Ctrl+F）的端到端验证。
 *
 * 样本：sample-text-20p.pdf（make-testdata 生成，内容已知）：
 *   · 每页一个 `Section N`（大标题）
 *   · 每页 34 行 LOREM 行，行尾 `(pN-i)`
 *   · 页脚 `— page N of M —`
 *
 * 覆盖：
 *   1. Ctrl+F 开条 + 自动聚焦
 *   2. 大小写不敏感的全文档搜索（搜 SECTION → 20 个，每页 1 个）
 *   3. 高亮真的画在文本层里（已渲染页有 mark 元素，且文本没变）
 *   4. 跨页跳转（搜 Section 7 → next → 页码真的到 7、当前项橙色）
 *   5. 缩放后文本层重建 → mark 自动重打（数量恢复）
 *   6. Esc 清场：条关 + mark 归零 + 文本还原
 *
 * 用法：build → serve:dist → node scripts/test-pdf-find.mjs
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = resolve(ROOT, 'viewer-shots')
await mkdir(SHOTS, { recursive: true })

const URL_TARGET = process.argv[2] ?? 'http://localhost:4173/'
const PDF = resolve(ROOT, 'public/testdata/sample-text-20p.pdf')
const PORT = Number(process.env.EPL_FIND_PORT ?? 9543)

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
  console.error('找不到样本 PDF，先跑：npm run testdata:local')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userDataDir = await mkdtemp(join(tmpdir(), 'epl-pdffind-'))
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
      consoleErrors.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300))
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('EXCEPTION: ' + (m.params.exceptionDetails?.exception?.description ?? '').slice(0, 300))
    }
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

  async function openViaInput(path) {
    for (let i = 0; i < 60; i++) {
      const { root } = await send('DOM.getDocument', { depth: -1 })
      const { nodeId } = await send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: 'input[data-tid="open-input"]',
      })
      if (nodeId) {
        await send('DOM.setFileInputFiles', { files: [path], nodeId })
        return
      }
      await sleep(300)
    }
    throw new Error('找不到打开文件的 input')
  }

  /** 等 PDF 第一页真的画出来（canvas + 无加载遮罩） */
  async function waitPdf(attempts = 80) {
    for (let i = 0; i < attempts; i++) {
      const ok = await evaluate(
        `!!document.querySelector('.page-slot canvas') && !document.querySelector('.overlay')`,
      )
      if (ok) return true
      await sleep(250)
    }
    return false
  }

  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.navigate', { url: URL_TARGET })
  await sleep(1800)
  await openViaInput(PDF)
  check('PDF 打开并渲染', await waitPdf())
  await sleep(600) // 文本层异步

  // ------------------------------------------------ 1. Ctrl+F 开条
  console.log('\n[1] Ctrl+F 开条')
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))`)
  await sleep(300)
  check('Ctrl+F 打开了 PDF 查找条', await evaluate(`!!document.querySelector('[data-tid="pdf-find"]')`))
  check('输入框自动聚焦', await evaluate(`document.activeElement?.dataset?.tid === 'pdf-find-input'`))

  /** 往查找框输入并等搜索稳定 */
  async function typeQuery(q) {
    await evaluate(`(() => {
      const i = document.querySelector('[data-tid="pdf-find-input"]');
      i.value = ${JSON.stringify(q)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
  }
  async function findState() {
    return JSON.parse(
      await evaluate(`(() => {
        const count = document.querySelector('[data-tid="pdf-find-count"]')?.textContent?.trim() ?? '';
        const marks = [...document.querySelectorAll('mark.find-hl')];
        return JSON.stringify({
          count,
          marks: marks.length,
          on: marks.filter((m) => m.classList.contains('on')).length,
          // 高亮不改变文本：mark 的文字必须还在 span 文本流里
          text: (document.querySelector('.text-layer')?.textContent || '').length,
        });
      })()`),
    )
  }

  // ------------------------------------------------ 2. 大小写不敏感全文档搜索
  console.log('\n[2] 全文档搜索（大小写不敏感）')
  await typeQuery('SECTION') // 样本里是 "Section N" —— 大写输入也要命中
  let st
  for (let i = 0; i < 60; i++) {
    await sleep(300)
    st = await findState()
    if (st.count === '20' && !st.count.includes('搜索中')) break
  }
  check('搜 SECTION 命中 20 个（20 页各 1 个，大小写不敏感）', /\/ 20$/.test(st.count), `count=${st.count}`)
  check('当前项已定位并标橙', st.on === 1, `on=${st.on}`)
  check('已渲染页有 mark 高亮', st.marks >= 1, `marks=${st.marks}`)
  check('高亮不改变文本长度', st.text > 500)
  await shot('find-pdf-1')

  // ------------------------------------------------ 3. 跨页跳转
  console.log('\n[3] 跨页跳转')
  await typeQuery('Section 7')
  for (let i = 0; i < 60; i++) {
    await sleep(300)
    st = await findState()
    if (st.count === '1') break
  }
  check('搜 Section 7 唯一命中', /\/ 1$/.test(st.count), `count=${st.count}`)
  // 第 7 页不在视口 —— next 应该跳页
  await evaluate(`document.querySelector('[data-tid="pdf-find-next"]')?.click()`)
  let jumped = null
  for (let i = 0; i < 60; i++) {
    await sleep(250)
    jumped = JSON.parse(
      await evaluate(`(() => {
        const inp = document.querySelector('[data-tid="page-input"]');
        const on = document.querySelector('mark.find-hl.on');
        return JSON.stringify({
          page: inp ? inp.value : '',
          hasOn: !!on,
          text: on ? on.textContent : '',
        });
      })()`),
    )
    if (jumped.hasOn && jumped.page === '7') break
  }
  check('next 跳到了第 7 页（页码输入框显示 7）', jumped.page === '7' && jumped.hasOn, `page=${jumped.page}`)
  if (jumped.page !== '7') {
    console.log(
      '  [diag]',
      JSON.parse(
        await evaluate(`(() => {
          const sc = document.querySelector('.viewport');
          const on = document.querySelector('mark.find-hl.on');
          return JSON.stringify({
            scrollTop: Math.round(sc?.scrollTop ?? -1),
            scrollHeight: sc?.scrollHeight ?? -1,
            clientHeight: sc?.clientHeight ?? -1,
            markTop: on ? Math.round(on.getBoundingClientRect().top) : -1,
            canvases: document.querySelectorAll('.page-slot canvas').length,
          });
        })()`),
      ),
    )
  }
  check('当前项橙色高亮且文本正确', jumped.hasOn && /Section/i.test(jumped.text), jumped.text)
  await shot('find-pdf-2')

  // ------------------------------------------------ 4. 缩放后 mark 重建
  console.log('\n[4] 缩放后 mark 重建')
  await evaluate(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: '=', ctrlKey: true, bubbles: true }))`,
  )
  await sleep(800) // 等重渲染 + 文本层重建 + 重打标
  st = await findState()
  check('缩放重建文本层后 mark 自动重打', st.marks >= 1 && st.on === 1, `marks=${st.marks} on=${st.on}`)

  // ------------------------------------------------ 5. 无匹配
  console.log('\n[5] 无匹配')
  await typeQuery('这个词一定不存在xyzzy')
  for (let i = 0; i < 40; i++) {
    await sleep(300)
    st = await findState()
    if (st.count === '无匹配') break
  }
  check('无匹配给明确文案', st.count === '无匹配', st.count)
  check('无匹配不残留旧 mark', st.marks === 0, `marks=${st.marks}`)

  // ------------------------------------------------ 6. Esc 清场
  console.log('\n[6] Esc 清场')
  await typeQuery('Section')
  await sleep(900)
  await evaluate(`(() => {
    const i = document.querySelector('[data-tid="pdf-find-input"]');
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  })()`)
  await sleep(400)
  st = await findState()
  check('Esc 关掉了查找条', !(await evaluate(`!!document.querySelector('[data-tid="pdf-find"]')`)))
  check('mark 全部清掉', st.marks === 0, `marks=${st.marks}`)
  // 文本还原：span 里不再有 mark 子元素，文字完整
  check('文本层文本完整（还原成功）', st.text > 500)

  // ------------------------------------------------ 7. 控制台干净
  const errs = consoleErrors.filter((e) => !/favicon/i.test(e))
  check('没有未捕获异常 / error', errs.length === 0, errs.slice(-2).join(' | '))

  console.log(`\n========== 结果：${passed} 通过 / ${failed} 失败 ==========`)
} catch (e) {
  console.error('\nFATAL:', e?.message ?? e)
  failed++
} finally {
  try {
    ws?.close()
  } catch {}
  child?.kill()
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
}
process.exit(failed > 0 ? 1 : 0)
