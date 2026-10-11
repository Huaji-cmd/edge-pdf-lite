/**
 * 以「应用」的方式把 edge-pdf-lite 跑起来。
 *
 *   npm run app            # 默认 http://localhost:4173/
 *   npm run app -- 8080    # 换端口
 *
 * 为什么要单独一个入口，而不是继续用 serve-dist.mjs：
 *
 * 1. **必须绑 127.0.0.1（localhost）**。Service Worker 与「安装为应用」都要求
 *    **安全上下文**，而 `http://<局域网IP>` 不算 —— 在 Surface 上用开发机的
 *    192.168.x.x 打开时，SW 会直接注册失败，地址栏里那个安装图标也永远不出现，
 *    而且不给任何提示。所以要在**本机**跑这个脚本。
 *
 * 2. **自动打开浏览器**。省掉"记住端口号再去地址栏敲"这一步。
 *
 * 起服务 → 打开页面 → 提示安装；按 Ctrl+C 或关掉这个窗口就停。
 * 页面里也有一个「安装为应用」按钮（welcome 页），点它就能装成独立窗口的应用。
 */
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 4173)
/** ⚠️ 只监听回环地址，理由见文件头 */
const HOST = '127.0.0.1'
const PAGE_URL = `http://localhost:${PORT}/`

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // 这两个对 MIME 敏感：清单错了装不上，sw.js 错了直接注册失败
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.pdf': 'application/pdf',
}

try {
  const s = await stat(DIST)
  if (!s.isDirectory()) throw new Error('not a directory')
} catch {
  console.error(`\n找不到构建产物：${DIST}`)
  console.error('先跑一次：npm run build\n')
  process.exit(1)
}

/** 防目录穿越 */
function safeJoin(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0])
  const target = normalize(join(DIST, decoded))
  if (target !== DIST && !target.startsWith(DIST + sep)) return null
  return target
}

const server = createServer(async (req, res) => {
  const filePath = safeJoin(req.url ?? '/')
  if (!filePath) {
    res.writeHead(403).end('Forbidden')
    return
  }
  try {
    let s = await stat(filePath)
    let target = filePath
    if (s.isDirectory()) {
      target = join(filePath, 'index.html')
      s = await stat(target)
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': s.size,
      // SW 自己在管缓存，这里别叠加一层，否则改完重新构建看不到效果
      'Cache-Control': 'no-cache',
      // 以后要上 SharedArrayBuffer / 多线程 pdf.js 时需要这两个头，先留着说明位置
      'Service-Worker-Allowed': '/',
    })
    createReadStream(target).pipe(res)
  } catch {
    // 页面导航回落到 index.html；资源请求老实 404（否则 404 会被伪装成 MIME 报错）
    const wantsHtml = String(req.headers.accept ?? '').includes('text/html')
    const looksLikeAsset = /\.[a-z0-9]+$/i.test(filePath)
    if (!looksLikeAsset && wantsHtml) {
      const fallback = join(DIST, 'index.html')
      try {
        const s = await stat(fallback)
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': s.size })
        createReadStream(fallback).pipe(res)
        return
      } catch {
        /* 落到 404 */
      }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('404\n')
  }
})

/** 打开浏览器。优先用 Edge（跟本项目的主力测试环境一致），退回 Chrome、再退回系统默认 */
function openBrowser(url) {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ]
  const exe = candidates.find((p) => existsSync(p))
  if (exe) {
    spawn(exe, [url], { detached: true, stdio: 'ignore' }).unref()
    return exe.includes('msedge') ? 'Edge' : 'Chrome'
  }
  // 兜底：交给系统关联程序
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
  return '系统默认浏览器'
}

server.listen(PORT, HOST, () => {
  const line = '─'.repeat(56)
  console.log(`\n┌${line}┐`)
  console.log('│  edge-pdf-lite 已经跑起来了')
  console.log(`└${line}┘`)
  console.log(`\n  地址：${PAGE_URL}`)
  console.log(`  （只监听本机回环，别的设备打不开 —— 这是为了「能装成应用」）`)

  // EPL_NO_OPEN=1 只起服务不开窗口（自测 / 想让别的设备连时用）
  if (process.env.EPL_NO_OPEN === '1') {
    console.log('  （EPL_NO_OPEN=1，没有自动打开浏览器）\n')
  } else {
    const which = openBrowser(PAGE_URL)
    console.log(`  已用 ${which} 打开\n`)
  }
  console.log('  想让它变成桌面应用：')
  console.log('    · 页面上点「安装为应用」（只在看到这个按钮时才有）')
  console.log('    · 或点地址栏右侧那个「安装 / 应用可用」图标')
  console.log('  装完就能从开始菜单 / 任务栏直接启动，不再需要这个窗口')
  console.log('\n  按 Ctrl+C 停止\n')
})

// Ctrl+C 时干净退出
process.on('SIGINT', () => {
  console.log('\n已停止。')
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 500)
})
