/**
 * 专门验证 WebView2 profile 的**自愈**逻辑。
 *
 * 背景（用户实际踩到的）：装了正式版后双击 exe 出来一个 WebView2 错误页，
 * 上面一行乱码，看着像白屏。根因是 WebView2 的 profile 坏掉之后，
 * Tauri 把前端资源挂在 `http://tauri.localhost` 的那层虚拟主机映射失效了 ——
 * 请求跑到真实网络去解析这个域名，必然失败。
 *
 * 修法是"清掉 profile 重建"，但**绝不能连 `Default\Local Storage` 一起清**，
 * 用户的文件列表和设置就存在那儿（清掉等于让他把书重新添加一遍）。
 *
 * 这个脚本要证的就是两件事，缺一不可：
 *   ① 该重建时会重建 —— 应用能正常起来（不是白屏错误页）
 *   ② 重建**不会弄丢** Local Storage 里的用户数据
 *
 * ⚠️ 为什么要单独一个脚本：主脚本 `test-exe.mjs` 每次启动前都会把整个数据目录
 *    挪走，永远从零开始 —— 那种条件下"长期存在的 profile 出问题"根本测不到。
 *    这正是当初漏掉这个 bug 的原因。
 */
import { spawn } from 'node:child_process'
import { existsSync, renameSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXE = resolve(ROOT, 'src-tauri/target/release/edge-pdf-lite.exe')
const PORT = 9335
const IDENT = 'com.edge-pdf-lite.desktop'
const PROFILE = join(process.env.LOCALAPPDATA ?? '', IDENT, 'EBWebView')
const STAMP = join(PROFILE, '.epl-profile')
const SHOTS = resolve(ROOT, 'exe-shots')

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`)
  ok ? pass++ : fail++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!existsSync(EXE)) {
  console.error(`找不到 exe：${EXE}\n  先跑： npm run exe`)
  process.exit(1)
}
await mkdir(SHOTS, { recursive: true })

/** 把数据目录挪走（不删除，避开批量删除护栏） */
function stashProfile(tag) {
  if (!existsSync(PROFILE)) return
  try {
    renameSync(
      PROFILE,
      join(tmpdir(), `epl-heal-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    )
  } catch {
    /* ignore */
  }
}

/**
 * 等 Vue 真的挂上去。
 *
 * ⚠️ 不能用固定 `sleep`：清理过 profile 之后 WebView2 要重建一大堆东西，
 *    首屏比平时慢不少。固定等待会让断言**随机**变红，看起来像"自愈把页面弄坏了"。
 *    （实测固定等 1.5 秒时 `#app` 是 0 —— 元素在、但还没挂载。
 *      这两种状态必须分清：`-1` 是页面都没加载，`0` 是加载了但没渲染。）
 */
async function waitRendered(app, timeoutMs = 30000) {
  for (let i = 0; i < timeoutMs / 500; i++) {
    const n = await app.evaluate(`document.querySelector('#app')?.children.length ?? -1`)
    if (n > 0) return n
    await sleep(500)
  }
  return -1
}

/** 启动 exe 并连上 CDP，返回操作句柄 */
async function launch() {
  const proc = spawn(EXE, [], {
    stdio: 'ignore',
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  })

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
    proc.kill()
    throw new Error('连不上调试端口')
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('ws 连不上')), { once: true })
  })

  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result)
    }
  })
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const n = ++id
      pending.set(n, { res, rej })
      ws.send(JSON.stringify({ id: n, method, params }))
    })
  const evaluate = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result?.value
  }

  await send('Runtime.enable')
  await send('Page.enable')
  return { proc, ws, send, evaluate }
}

/** 关掉 exe 并等它彻底退出 —— profile 目录必须先解锁，自愈才动得了 */
async function shutdown({ proc, ws }) {
  try {
    ws.close()
  } catch {
    /* ignore */
  }
  proc.kill()
  for (let i = 0; i < 30; i++) {
    await sleep(300)
    // 能改名就说明锁已经放开（改了再改回来）
    try {
      if (!existsSync(PROFILE)) return
      const probe = PROFILE + '.probe'
      renameSync(PROFILE, probe)
      renameSync(probe, PROFILE)
      return
    } catch {
      /* 还锁着，继续等 */
    }
  }
}

console.log(`exe: ${EXE}`)
console.log(`profile: ${PROFILE}\n`)
stashProfile('before')

// ---------------------------------------------------------------- 1. 干净启动
console.log('[1] 干净状态启动')
let app = await launch()
check('应用正常渲染（不是错误页）', (await waitRendered(app)) > 0)
/*
 * ⚠️ 第一次运行**不会**有标记：那时 `EBWebView` 目录还没被 WebView2 创建，
 *    自愈逻辑直接返回了。第二次启动才写得进去 —— 这是预期行为，不是 bug，
 *    所以这里只记录状态、不断言。
 */
console.log(`     首次标记：${existsSync(STAMP) ? '已写入' : '（还没有，属正常）'}`)

/*
 * 造"用户数据"，等下要验证重建**不会**把它清掉。两路探针：
 *
 *  ① 一个应用**不认识**的 key —— 纯探针，不受任何应用逻辑干扰
 *  ② 一份**真实**的文件列表 —— 路径必须真的存在，否则应用启动时的
 *     `pruneMissing()` 会把它当失效条目删掉，看上去就像"数据丢了"。
 *     （第一版我随手写了 `D:\fake\...`，正是栽在这里。）
 */
const REAL_PDF = resolve(ROOT, 'public/testdata/real-1706.03762.pdf')
await app.evaluate(`
  localStorage.setItem('epl-heal-probe', 'kept-ok');
  localStorage.setItem('epl:file-list', JSON.stringify([
    { name: 'real-1706.03762.pdf', path: ${JSON.stringify(REAL_PDF)}, kind: 'file' },
  ]));
  localStorage.setItem('epl.settings.v1', JSON.stringify({ saveMode: 'overwrite', saveDir: '', theme: 'light' }));
  true
`)
await sleep(400)

await shutdown(app)
console.log('    （已关掉应用，profile 解锁）')

// ---------------------------------------------------------------- 2. 模拟"需要重建"
console.log('\n[2] 删掉标记（模拟老用户 / profile 需要重建），再启动')
await rm(STAMP, { force: true })
check('标记确实没了（这就是需要重建的状态）', !existsSync(STAMP))

app = await launch()
const rendered = await waitRendered(app)
check(
  '自愈之后应用能正常渲染（旧的坏 profile 不会再把页面卡成错误页）',
  rendered > 0,
  `#app 子节点=${rendered}（-1=页面都没加载 / 0=加载了但没挂载）`,
)
check(
  '标记被重建了（下次启动版本没变就会跳过清理）',
  existsSync(STAMP),
  await readFile(STAMP, 'utf8').catch(() => '（无）'),
)
check(
  '标记里记了 WebView2 版本（跨版本升级才会再次触发）',
  /^\d+\|[\d.]+$/.test(String(await readFile(STAMP, 'utf8').catch(() => '')).trim()),
  await readFile(STAMP, 'utf8').catch(() => '（无）'),
)

const probe = await app.evaluate(`localStorage.getItem('epl-heal-probe') ?? ''`)
const list = await app.evaluate(`localStorage.getItem('epl:file-list') ?? ''`)
const setts = await app.evaluate(`localStorage.getItem('epl.settings.v1') ?? ''`)
check(
  '重建**没有**动 Local Storage（探针 key 还在）',
  String(probe) === 'kept-ok',
  String(probe) || '（没了）',
)
check(
  '用户的文件列表还在（这是最要紧的一条 —— 清了等于让他重新加一遍书）',
  String(list).includes('real-1706.03762.pdf'),
  String(list).slice(0, 70) || '（空的）',
)
check(
  '设置也还在',
  String(setts).includes('overwrite'),
  String(setts).slice(0, 70) || '（空的）',
)

const shot = await app.send('Page.captureScreenshot', { format: 'png' })
await writeFile(resolve(SHOTS, '05-exe-after-heal.png'), Buffer.from(shot.data, 'base64'))

await shutdown(app)

console.log(`\n==================================================`)
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log(`==================================================\n`)
process.exit(fail ? 1 : 0)
