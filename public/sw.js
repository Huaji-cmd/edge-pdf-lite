/* eslint-disable no-undef */
/**
 * Service Worker —— 让这个页面能被「安装为应用」并且离线可用。
 *
 * 只做两件事，不碰业务数据：
 *   1. 预缓存 app shell（HTML / manifest / 图标）
 *   2. 运行时缓存其它同源静态资源（JS / CSS / cmaps / 字体）
 *
 * ⚠️ **绝不缓存 PDF**。教材动辄几十 MB，缓存它们既撑爆配额（Chrome 默认
 *    每源约 60% 可用磁盘），又会拖慢首次打开。PDF 一律让网络直连。
 *
 * ⚠️ 导航请求走 **network-first**：这样发布新版后用户刷新就能拿到，
 *    不会被旧缓存困住（离线时才回退到缓存）。带 hash 的静态资源 URL 变了，
 *    本身就不会命中旧条目，所以它们用 stale-while-revalidate 更划算。
 */

const VERSION = 'v1'
const CACHE = `epl-${VERSION}`

/** app shell。逐条 add 并各自吞掉失败 —— addAll 是原子的，一个 404 会让整个安装失败 */
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      await Promise.all(SHELL.map((u) => cache.add(u).catch(() => {})))
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  let url
  try {
    url = new URL(req.url)
  } catch {
    return
  }
  // 只接管同源；第三方（如果有）交回给浏览器
  if (url.origin !== self.location.origin) return
  // PDF 不缓存（见文件头说明）
  if (/\.pdf$/i.test(url.pathname)) return
  // Range 请求（PDF 分片加载）不碰，缓存会破坏 206 语义
  if (req.headers.has('range')) return

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req)
          const cache = await caches.open(CACHE)
          cache.put('/index.html', res.clone()).catch(() => {})
          return res
        } catch {
          const hit = await caches.match('/index.html')
          return hit || Response.error()
        }
      })(),
    )
    return
  }

  event.respondWith(
    (async () => {
      const hit = await caches.match(req)
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            caches
              .open(CACHE)
              .then((c) => c.put(req, res.clone()))
              .catch(() => {})
          }
          return res
        })
        .catch(() => hit)
      return hit || network
    })(),
  )
})
