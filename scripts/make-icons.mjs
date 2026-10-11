/**
 * 生成 PWA 图标（public/icons/icon-192.png / icon-512.png / icon-maskable-512.png）。
 *
 * 为什么自己画而不塞一张位图进仓库：
 *   - 零依赖（只用 Node 内置 zlib），改配色改几个常量就行；
 *   - 输出带 alpha 的 PNG，可直接当任务栏 / 开始菜单图标。
 *
 * 做法：内部按 2× 超采样绘制再降采样 —— 圆角和斜边不会有硬锯齿。
 * `maskable` 版本整体缩到 80%，因为系统可能按圆形/圆角矩形裁切。
 *
 *   npm run icons
 */
import { deflateSync, crc32 } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', 'public', 'icons')
const SS = 2 // 超采样倍数

const BG = [43, 95, 217, 255] // #2b5fd9，跟主按钮同色
const PAPER = [255, 255, 255, 255]
const RULE = [195, 206, 224, 255]
const MARK = [255, 213, 79, 255] // #ffd54f，高亮黄

// ---------------------------------------------------------------- 最小 PNG 编码器

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([len, body, crc])
}

/** RGBA → PNG 字节。filter 一律 None（图小，压缩率够用） */
function encodePng(w, h, rgba) {
  const stride = w * 4
  const raw = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: truecolor + alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------- 画布

class Raster {
  constructor(w, h) {
    this.w = w
    this.h = h
    this.buf = Buffer.alloc(w * h * 4) // 全 0 = 透明
  }

  set(x, y, c) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const o = (y * this.w + x) * 4
    this.buf[o] = c[0]
    this.buf[o + 1] = c[1]
    this.buf[o + 2] = c[2]
    this.buf[o + 3] = c[3]
  }

  /** 实心矩形 */
  rect(x0, y0, x1, y1, c) {
    for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
      for (let x = Math.floor(x0); x < Math.ceil(x1); x++) this.set(x, y, c)
    }
  }

  /** 圆角矩形：用「到内缩矩形的有符号距离」判内外，边界天然是圆的 */
  roundRect(x0, y0, x1, y1, r, c) {
    const rr = Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2)
    for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
      for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
        const px = x + 0.5
        const py = y + 0.5
        const dx = Math.max(x0 + rr - px, 0, px - (x1 - rr))
        const dy = Math.max(y0 + rr - py, 0, py - (y1 - rr))
        if (Math.hypot(dx, dy) <= rr) this.set(x, y, c)
      }
    }
  }

  /** 三角形填充（重心坐标，顺时针/逆时针都行） */
  tri(ax, ay, bx, by, cx, cy, c) {
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)))
    const maxX = Math.min(this.w - 1, Math.ceil(Math.max(ax, bx, cx)))
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)))
    const maxY = Math.min(this.h - 1, Math.ceil(Math.max(ay, by, cy)))
    const den = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
    if (den === 0) return
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5 - ax
        const py = y + 0.5 - ay
        const u = (px * (cy - ay) - (cx - ax) * py) / den
        const v = ((bx - ax) * py - px * (by - ay)) / den
        if (u >= 0 && v >= 0 && u + v <= 1) this.set(x, y, c)
      }
    }
  }

  /** 盒式降采样。按 alpha 预乘后再平均，否则半透明边缘会发黑 */
  downscale(f) {
    const w = Math.round(this.w / f)
    const h = Math.round(this.h / f)
    const out = Buffer.alloc(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0
        let g = 0
        let b = 0
        let a = 0
        for (let sy = y * f; sy < (y + 1) * f; sy++) {
          for (let sx = x * f; sx < (x + 1) * f; sx++) {
            const o = (sy * this.w + sx) * 4
            const sa = this.buf[o + 3] / 255
            r += this.buf[o] * sa
            g += this.buf[o + 1] * sa
            b += this.buf[o + 2] * sa
            a += this.buf[o + 3]
          }
        }
        const o = (y * w + x) * 4
        if (a <= 0.5) {
          out[o + 3] = 0
          continue
        }
        out[o] = Math.min(255, Math.round((r * 255) / a))
        out[o + 1] = Math.min(255, Math.round((g * 255) / a))
        out[o + 2] = Math.min(255, Math.round((b * 255) / a))
        out[o + 3] = Math.min(255, Math.round(a / (f * f)))
      }
    }
    return { w, h, buf: out }
  }
}

// ---------------------------------------------------------------- 绘制

/**
 * 「文档 + 高亮条」图标：蓝底、白纸、几条文字线，中间压一道黄色高亮。
 * 纯几何填充，不依赖字体 —— 换机器换系统看到的都一样。
 */
function drawIcon(size, { maskable = false } = {}) {
  const W = size * SS
  const cv = new Raster(W, W)

  // maskable 要留安全区：系统在圆形裁切下不会切到内容
  const pad = maskable ? W * 0.1 : 0
  const S = W - pad * 2
  const T = (v) => pad + v * S // 图标内部 0..1 → 画布坐标

  // 背景（maskable 用整圆，普通版用圆角方形）
  cv.roundRect(0, 0, W, W, maskable ? W * 0.5 : W * 0.22, BG)

  // 纸
  const px0 = T(0.22)
  const py0 = T(0.14)
  const px1 = T(0.78)
  const py1 = T(0.86)
  cv.roundRect(px0, py0, px1, py1, S * 0.02, PAPER)

  // 右上角折角：先挖掉一块，再补一个更深的三角当折痕
  const fold = S * 0.17
  cv.tri(px1 - fold, py0, px1, py0, px1, py0 + fold, BG)
  cv.tri(px1 - fold, py0, px1, py0 + fold, px1 - fold, py0 + fold, [26, 68, 168, 255])

  // 文字线：三条，第二条交给高亮条来画
  const lw = S * 0.42
  const lh = S * 0.05
  const lx = T(0.29)
  const rows = [0.28, 0.44, 0.6]
  for (const ry of rows) {
    if (ry === rows[1]) continue
    cv.roundRect(lx, T(ry), lx + lw, T(ry) + lh, lh / 2, RULE)
  }

  // 高亮条：比文字线宽一点高一点，像划过一行
  cv.roundRect(
    lx - S * 0.028,
    T(rows[1]) - S * 0.02,
    lx + lw + S * 0.028,
    T(rows[1]) + lh + S * 0.02,
    lh / 2,
    MARK,
  )

  return cv
}

// ---------------------------------------------------------------- 主流程

const TARGETS = [
  { size: 192, name: 'icon-192.png' },
  { size: 512, name: 'icon-512.png' },
  { size: 512, name: 'icon-maskable-512.png', maskable: true },
]

await mkdir(OUT_DIR, { recursive: true })

for (const t of TARGETS) {
  const cv = drawIcon(t.size, { maskable: !!t.maskable })
  const { w, h, buf } = cv.downscale(SS)
  const png = encodePng(w, h, buf)
  await writeFile(join(OUT_DIR, t.name), png)
  console.log(`已生成 public/icons/${t.name}  (${(png.length / 1024).toFixed(1)} KB)`)
}
