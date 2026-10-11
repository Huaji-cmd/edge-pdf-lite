/**
 * 零依赖静态服务器，用来把构建产物（dist/）在局域网里跑起来，
 * 好让你在**另一台机器**上用它的浏览器打开测试。
 *
 * 为什么不用 `vite preview`：这个脚本会把所有网卡地址都列出来，
 * 方便直接复制到另一台机器上打开；而且它只依赖 Node 内置模块。
 *
 * 用法：
 *   npm run build
 *   npm run serve:dist            # 默认端口 4173
 *   npm run serve:dist -- 8080    # 指定端口
 */
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSocket } from 'node:dgram'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 4173)
const HOST = '0.0.0.0'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // ⚠️ PWA 清单和 Service Worker 都对 MIME 敏感：
  //    manifest 不是 application/manifest+json → 浏览器直接忽略（装不了应用）
  //    sw.js 不是 JS 类型 → 注册被拒（严格 MIME 检查）
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
  console.error(`找不到构建产物：${DIST}`)
  console.error('先跑一次：npm run build')
  process.exit(1)
}

/** 防目录穿越：解析后的路径必须仍在 DIST 之内 */
function safeJoin(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0])
  const target = normalize(join(DIST, decoded))
  if (target !== DIST && !target.startsWith(DIST + sep)) return null
  return target
}

const server = createServer(async (req, res) => {
  let filePath = safeJoin(req.url ?? '/')
  if (!filePath) {
    res.writeHead(403).end('Forbidden')
    return
  }

  try {
    let s = await stat(filePath)
    if (s.isDirectory()) {
      filePath = join(filePath, 'index.html')
      s = await stat(filePath)
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': s.size,
      // worker / wasm 需要；顺手也保证不会拿到旧缓存
      'Cache-Control': 'no-cache',
    })
    createReadStream(filePath).pipe(res)
  } catch {
    // 只有"页面导航"才回落到 index.html。
    //
    // 资源请求（.js/.css/.wasm/.bcmap…）缺失时必须老实返回 404。
    // 否则会把 index.html 的 HTML 内容当作 .js 返回，浏览器报的是
    // "Expected a JavaScript module script but the server responded with a MIME type of text/html"，
    // 把真正的 404 掩盖成看似是 MIME 配置问题 —— 排查时会被彻底带偏。
    const wantsHtml = String(req.headers.accept ?? '').includes('text/html')
    const looksLikeAsset = /\.[a-z0-9]+$/i.test(filePath)

    if (!looksLikeAsset && wantsHtml) {
      const fallback = join(DIST, 'index.html')
      try {
        const s = await stat(fallback)
        res.writeHead(200, {
          'Content-Type': MIME['.html'],
          'Content-Length': s.size,
        })
        createReadStream(fallback).pipe(res)
        return
      } catch {
        /* 落到下面的 404 */
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(`404 Not Found: ${req.url}\n`)
  }
})

/**
 * 找出"默认出口网卡"的 IP。
 * 做法：朝一个外部地址开一个 UDP socket（不会真的发包），
 * 读回本地地址 —— 这就是本机出网时实际会用的那块网卡。
 * 比"把网卡列表全列出来让用户自己猜"可靠得多。
 */
function primaryIPv4() {
  return new Promise((resolve) => {
    const sock = createSocket('udp4')
    const done = (v) => {
      try {
        sock.close()
      } catch {
        /* ignore */
      }
      resolve(v)
    }
    const timer = setTimeout(() => done(null), 800)
    sock.connect(53, '223.5.5.5', () => {
      clearTimeout(timer)
      done(sock.address().address)
    })
    sock.on('error', () => {
      clearTimeout(timer)
      done(null)
    })
  })
}

server.listen(PORT, HOST, async () => {
  const primary = await primaryIPv4()
  const others = []
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal && ni.address !== primary) {
        others.push(ni.address)
      }
    }
  }

  const line = '─'.repeat(58)
  console.log(`\n┌${line}┐`)
  console.log('│ 服务已经跑起来了。注意：这个命令只在这台【开发机】上跑。')
  console.log(`└${line}┘`)
  console.log('\n  ▼ 在【另一台机器】上，只用浏览器打开下面这个地址：\n')
  if (primary) console.log(`      http://${primary}:${PORT}/      ← 用这个`)
  else console.log(`      http://<本机IP>:${PORT}/`)
  console.log(`\n      本机自测：http://localhost:${PORT}/`)
  console.log(`      M0 实验页：http://localhost:${PORT}/spike.html`)
  if (others.length) {
    console.log('\n    （下面这些是虚拟网卡，多半不通，别用）')
    for (const a of others) console.log(`      http://${a}:${PORT}/`)
  }
  console.log('\n  打不开的话按顺序排查：')
  console.log('    1. 两台机器在同一个局域网里吗？（手机热点也算）')
  console.log('    2. Windows 防火墙拦了 —— 换个 PowerShell 跑：')
  console.log(`         New-NetFirewallRule -DisplayName "edge-pdf-lite" -Direction Inbound \``)
  console.log(`           -Protocol TCP -LocalPort ${PORT} -Action Allow`)
  console.log('    3. 在这台机器上先自测 localhost 那个地址通不通，区分是"服务没起"还是"网络不通"')
  console.log('\n  按 Ctrl+C 停止服务\n')
})
