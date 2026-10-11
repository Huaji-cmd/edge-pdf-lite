/**
 * 「能装成应用」的机器验证。
 *
 * 这一层不能靠肉眼 —— 清单里写错一个字（少一张 192 图标、display 拼错、
 * MIME 类型不对），页面照常能开，只是**地址栏里那个安装图标永远不出现**，
 * 而且不给任何提示。所以直接问浏览器：
 *
 *   Page.getAppManifest        → 清单有没有被解析出来、有没有报错
 *   Page.getInstallabilityErrors → 还有哪些条件不满足（空数组 = 可安装）
 *   serviceWorker.getRegistration → SW 有没有真的装上、有没有接管页面
 *   caches.keys() / caches.open → app shell 有没有进缓存；**PDF 必须没进**
 *
 * 只跑一次加载是测不准的：SW 首次注册时还是 installing，
 * `navigator.serviceWorker.controller` 为 null。所以这里会**再导航一次**，
 * 验证第二次访问时 SW 已经接管 + 资源来自缓存。
 *
 * 用法：node scripts/test-pwa.mjs [url]
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const URL_TARGET = process.argv[2] ?? 'http://localhost:4173/'
const PORT = Number(process.env.EPL_PORT ?? 9514)

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
const userDataDir = await mkdtemp(join(tmpdir(), 'epl-pwa-'))
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
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id !== undefined && pending.has(m.id)) {
      const { resolve: res, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(JSON.stringify(m.error))) : res(m.result)
    }
  })
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const n = ++id
      pending.set(n, { resolve: res, reject: rej })
      ws.send(JSON.stringify({ id: n, method, params }))
    })

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    }
    return r.result?.value
  }

  await send('Page.enable')
  await send('Runtime.enable')

  console.log(`\n→ 第一次打开 ${URL_TARGET}`)
  await send('Page.navigate', { url: URL_TARGET })
  await sleep(3000)

  // ---------------------------------------------------------------- 1. 清单

  console.log('\n[1] Web App Manifest')
  const mf = await send('Page.getAppManifest')
  if (process.env.EPL_DEBUG_MF) {
    console.log('   [debug] 返回字段:', Object.keys(mf).join(','))
    console.log('   [debug] parsed =', JSON.stringify(mf.parsed)?.slice(0, 300))
    console.log('   [debug] data   =', String(mf.data).slice(0, 300))
  }
  /*
   * ⚠️ 别用 `mf.parsed` —— 它是浏览器解析出的**元数据**（实测只有 `{scope}`），
   * 不是清单内容。清单本体在 `mf.data` 里（原始 JSON 文本）。
   * 用错字段的症状是"name/display/icons 全是 undefined"，看着像清单写错了。
   */
  const parsed = (() => {
    try {
      return JSON.parse(mf.data ?? '{}')
    } catch {
      return {}
    }
  })()
  const mfErrors = (mf.errors ?? []).filter((e) => e.critical)
  check('清单被浏览器解析出来了', !!mf.url, mf.url || '（没有找到 <link rel="manifest">）')
  check(
    '清单没有致命错误',
    mfErrors.length === 0,
    mfErrors.map((e) => `${e.message}${e.critical ? '(critical)' : ''}`).join(' | ') || '无',
  )
  check('name 正确', parsed.name === 'edge-pdf-lite', `name=${parsed.name}`)
  check(
    '以独立窗口运行（display: standalone）',
    parsed.display === 'standalone',
    `display=${parsed.display}`,
  )
  const icons = Array.isArray(parsed.icons) ? parsed.icons : []
  const has192 = icons.some((i) => String(i.sizes).includes('192'))
  const has512 = icons.some((i) => String(i.sizes).includes('512'))
  const hasMaskable = icons.some((i) => String(i.purpose ?? '').includes('maskable'))
  check('带 192×192 图标（可安装的硬门槛）', has192, `icons=${icons.length} 张`)
  check('带 512×512 图标', has512)
  check('带 maskable 图标（桌面/开始菜单不糊）', hasMaskable)

  // ---------------------------------------------------------------- 2. 安装性

  console.log('\n[2] 安装条件')
  const inst = await send('Page.getInstallabilityErrors')
  const ierr = inst.installabilityErrors ?? []
  /*
   * headless 环境本来就不提供安装入口，Chromium 会报一个 "not in main frame /
   * headless" 之类的环境性理由。那不是我们的问题，过滤掉只看跟清单/图标/SW 相关的。
   */
  const realErrors = ierr.filter(
    (e) => !/headless|not.*main frame|platform/i.test(String(e.errorId) + String(e.errorArguments)),
  )
  check(
    '没有跟清单 / 图标 / SW 相关的安装阻塞项',
    realErrors.length === 0,
    realErrors.map((e) => e.errorId).join(' | ') ||
      `无（环境性提示 ${ierr.length} 条已忽略：${ierr.map((e) => e.errorId).join(',') || '无'}）`,
  )

  // ---------------------------------------------------------------- 3. Service Worker

  console.log('\n[3] Service Worker')
  let reg = null
  for (let i = 0; i < 30; i++) {
    reg = JSON.parse(
      await evaluate(`
        (async () => {
          const r = await navigator.serviceWorker.getRegistration();
          if (!r) return JSON.stringify({ ok: false });
          const sw = r.active || r.waiting || r.installing;
          return JSON.stringify({
            ok: true,
            scope: r.scope,
            state: sw ? sw.state : null,
            controlled: !!navigator.serviceWorker.controller,
          });
        })()
      `),
    )
    if (reg.ok && reg.state === 'activated') break
    await sleep(400)
  }
  check('Service Worker 注册成功', !!reg?.ok, reg?.scope ?? '没注册上')
  check('已激活', reg?.state === 'activated', `state=${reg?.state}`)

  // ---------------------------------------------------------------- 4. 缓存内容

  console.log('\n[4] 缓存内容')
  const cache = JSON.parse(
    await evaluate(`
      (async () => {
        const keys = await caches.keys();
        const urls = [];
        for (const k of keys) {
          const c = await caches.open(k);
          for (const req of await c.keys()) urls.push(new URL(req.url).pathname);
        }
        return JSON.stringify({ keys, urls });
      })()
    `),
  )
  check('建了缓存仓', cache.keys.length > 0, cache.keys.join(', '))
  check(
    'app shell 进了缓存（HTML / 清单 / 图标）',
    cache.urls.includes('/index.html') || cache.urls.includes('/'),
    `${cache.urls.length} 条：${cache.urls.slice(0, 6).join(' ')}…`,
  )
  // ⚠️ 这条是策略红线：教材几十 MB，缓存它们会撑爆配额
  check(
    'PDF 没有被缓存（教材动辄几十 MB，必须是红线）',
    !cache.urls.some((u) => /\.pdf$/i.test(u)),
    cache.urls.filter((u) => /\.pdf$/i.test(u)).join(' ') || '干净',
  )

  // ---------------------------------------------------------------- 5. 二次访问接管

  console.log('\n[5] 再打开一次：SW 应该已经接管')
  await send('Page.navigate', { url: URL_TARGET })
  await sleep(2500)
  const take = JSON.parse(
    await evaluate(`
      (async () => {
        const r = await navigator.serviceWorker.getRegistration();
        return JSON.stringify({
          controlled: !!navigator.serviceWorker.controller,
          state: r && (r.active ? r.active.state : null),
        });
      })()
    `),
  )
  check('第二次打开时页面已被 SW 接管', take.controlled, `controller=${take.controlled}`)
  check('SW 处于 activated', take.state === 'activated', `state=${take.state}`)

  console.log(
    `\n${failed === 0 ? '✅' : '❌'} 安装能力验证：${passed}/${passed + failed} 通过\n`,
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
