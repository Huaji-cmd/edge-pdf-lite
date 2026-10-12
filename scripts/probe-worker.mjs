/**
 * 专项探针：在**当前浏览器 + 当前访问原**下，逐一验证 pdf.js 的三种 worker 加载路径。
 *
 * 背景：pdf.js 内部会根据 workerSrc 的形态选路径 ——
 *   1. 绝对同源 URL  → 直接 new Worker(url, {type:'module'})
 *   2. 根路径/相对路径 → 它认为跨域，绕道 blob 包装器（await import(...)）
 *   3. 以上都失败 → 回退 "fake worker"（在主线程里跑，但同样要 import 那个文件）
 *
 * 用途：判断"worker 加载失败"到底是服务不可达，还是某条路径在当前环境下不可用。
 *
 * 用法：node scripts/probe-worker.mjs [页面地址]
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/*
 * ⚠️ 默认值只能是 localhost —— 仓库要开源，**内网 IP 属于隐私**，
 *    之前这里写死过一台机器的真实地址，后来从历史里也抹掉了。
 *    要测另一台机器就从命令行传：
 *      node scripts/probe-worker.mjs http://<那台机器的IP>:4173/spike.html
 */
const TARGET_URL = process.argv[2] ?? 'http://127.0.0.1:4173/spike.html'
const PORT = Number(process.env.EPL_PORT ?? 9399)
const WORKER_PATH = '/assets/pdfWorker-BP-Dpq4t.js'

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p))

if (!EDGE) {
  console.error('找不到浏览器')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userDataDir = await mkdtemp(join(tmpdir(), 'epl-probe-'))
let child
let ws

try {
  child = spawn(
    EDGE,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  // 等 DevTools
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
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id !== undefined && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id
      pending.set(n, { resolve, reject })
      ws.send(JSON.stringify({ id: n, method, params }))
    })

  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.navigate', { url: TARGET_URL })
  await sleep(2500)

  const evaluate = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    })
    if (r.exceptionDetails) {
      return { __threw: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text }
    }
    return r.result?.value
  }

  console.log(`页面: ${TARGET_URL}`)
  console.log(`安全上下文: ${await evaluate('String(window.isSecureContext)', false)}`)
  const env = await evaluate('JSON.stringify(globalThis.__spikeEnv ?? null)', false)
  if (env && env !== 'null') {
    const parsed = JSON.parse(env)
    console.log(`浏览器: ${parsed['浏览器']}  |  WebGL: ${parsed['WebGL_渲染器']}`)
  }
  console.log('')

  const probe = async (label, expr) => {
    const t0 = Date.now()
    const res = await evaluate(expr)
    const dt = Date.now() - t0
    const ok = res === 'ok'
    console.log(`${ok ? '✅' : '❌'} ${label.padEnd(34)} ${dt}ms  ${ok ? '' : String(res).slice(0, 200)}`)
    return ok
  }

  // 直接探：不经过 pdf.js，直接试加载 worker 脚本本身
  await probe(
    'A. fetch(worker脚本)',
    `fetch(${JSON.stringify(WORKER_PATH)}).then(r => r.ok ? 'ok' : 'HTTP '+r.status).catch(e => 'ERR: '+e.message)`,
  )

  await probe(
    'B. 直接 new Worker(绝对URL,module)',
    `new Promise(res => {
       try {
         const w = new Worker(new URL(${JSON.stringify(WORKER_PATH)}, location.href).href, {type:'module'});
         w.onerror = e => { w.terminate(); res('ERR: ' + (e.message || 'unknown')) };
         setTimeout(() => { w.terminate(); res('ok') }, 1500);
       } catch (e) { res('THROW: ' + e.message) }
     })`,
  )

  await probe(
    'C. blob 包装后 new Worker(module)',
    `new Promise(res => {
       try {
         const t = new URL(${JSON.stringify(WORKER_PATH)}, location.href).href;
         const blobUrl = URL.createObjectURL(new Blob(['await import("'+t+'");'], {type:'text/javascript'}));
         const w = new Worker(blobUrl, {type:'module'});
         w.onerror = e => { w.terminate(); res('ERR: ' + (e.message || 'unknown')) };
         setTimeout(() => { w.terminate(); res('ok') }, 2000);
       } catch (e) { res('THROW: ' + e.message) }
     })`,
  )

  await probe(
    'D. 经典 worker（非 module）',
    `new Promise(res => {
       try {
         const w = new Worker(new URL(${JSON.stringify(WORKER_PATH)}, location.href).href);
         w.onerror = e => { w.terminate(); res('ERR: ' + (e.message || 'unknown')) };
         setTimeout(() => { w.terminate(); res('ok') }, 1500);
       } catch (e) { res('THROW: ' + e.message) }
     })`,
  )

  console.log('\n结论：A 不过 = 服务不可达；A 过而 B 不过 = module worker 在当前原下不可用；')
  console.log('      B 过而 C 不过 = pdf.js 的 blob 包装路径在当前原下不可用（就是我们修掉的那个）。')
} finally {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  child?.kill()
  await sleep(500)
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
}
