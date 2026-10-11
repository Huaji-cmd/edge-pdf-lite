/**
 * pdf.js 6.x 的兼容性补丁。
 *
 * 背景：pdfjs-dist 的默认构建直接调用 ES2025 的新 API，**且不做任何降级**。
 * 浏览器缺这些 API 时，worker 会直接死在 `a.toHex is not a function`，
 * 表现是"整个 PDF 打不开"，而不是某个页面渲染失败。
 *
 * 实测确认 pdf.js 6.4.299 用到了这些：
 *   Uint8Array.prototype.toHex     —— Chrome/Edge 140+
 *   Uint8Array.prototype.toBase64  —— Chrome/Edge 140+
 *   Uint8Array.fromBase64          —— Chrome/Edge 140+
 *   Uint8Array.prototype.setFromBase64
 *   Math.sumPrecise                —— Chrome/Edge 137+
 *   Promise.try                    —— Chrome/Edge 128+
 *   Promise.withResolvers          —— Chrome/Edge 119+
 *
 * 目标机是"不常更新的低配 Windows"，命中这个坑的概率很高，所以必须补。
 *
 * 注意：这个模块要在**主线程和 worker 两个线程都加载**。
 * 只补一边 = 一边能过、另一边炸，排查起来极其痛苦。
 */

type Loose = Record<string, unknown>

const applied: string[] = []

/** 只在缺失时打补丁；已存在（新版浏览器）则原样不动。返回是否真的补了。 */
function defineIfMissing(target: Loose, name: string, value: unknown): boolean {
  if (typeof target[name] === 'function') return false
  Object.defineProperty(target, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  })
  return true
}

const HEX_TABLE: string[] = []
for (let i = 0; i < 256; i++) HEX_TABLE.push(i.toString(16).padStart(2, '0'))

const B64_STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function alphabetOf(opts: unknown): string {
  const o = opts as { alphabet?: string } | undefined
  return o?.alphabet === 'base64url' ? B64_URL : B64_STD
}

function omitPaddingOf(opts: unknown): boolean {
  return Boolean((opts as { omitPadding?: boolean } | undefined)?.omitPadding)
}

/** 手写 base64 编码：不走 btoa，避免大数组时 String.fromCharCode 爆栈 */
function encodeBase64(bytes: Uint8Array, opts?: unknown): string {
  const A = alphabetOf(opts)
  const omit = omitPaddingOf(opts)
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out += A[(n >> 18) & 63]! + A[(n >> 12) & 63]! + A[(n >> 6) & 63]! + A[n & 63]!
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i]! << 16
    out += A[(n >> 18) & 63]! + A[(n >> 12) & 63]!
    if (!omit) out += '=='
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += A[(n >> 18) & 63]! + A[(n >> 12) & 63]! + A[(n >> 6) & 63]!
    if (!omit) out += '='
  }
  return out
}

function decodeBase64To(bytes: Uint8Array, str: string, opts?: unknown) {
  const A = alphabetOf(opts)
  const lastChunkHandling =
    (opts as { lastChunkHandling?: string } | undefined)?.lastChunkHandling ?? 'loose'
  const map = new Map<string, number>()
  for (let i = 0; i < A.length; i++) map.set(A[i]!, i)

  const cleaned = str.replace(/\s+/g, '')
  const body = cleaned.replace(/=+$/, '')
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (const ch of body) {
    const v = map.get(ch)
    if (v === undefined) {
      throw new SyntaxError(`Invalid character in base64 string: ${ch}`)
    }
    buffer = (buffer << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
    }
  }
  if (bits > 0) {
    if (lastChunkHandling === 'strict' && (buffer & ((1 << bits) - 1)) !== 0) {
      throw new SyntaxError('Invalid trailing bits in base64 string')
    }
    if (lastChunkHandling !== 'stop-before-partial') {
      out.push((buffer << (8 - bits)) & 0xff)
    }
  }
  const n = Math.min(out.length, bytes.length)
  for (let i = 0; i < n; i++) bytes[i] = out[i]!
  return { read: cleaned.length, written: n }
}

// ---------------------------------------------------------------- 开始打补丁

if (
  defineIfMissing(Math as unknown as Loose, 'sumPrecise', function sumPrecise(
    values: Iterable<number>,
  ) {
    // 规范要求精确求和；这里用 Kahan 补偿求和，误差远小于栅格化能感知的量级
    let sum = 0
    let c = 0
    for (const v of values) {
      const y = v - c
      const t = sum + y
      c = t - sum - y
      sum = t
    }
    return sum
  })
) {
  applied.push('Math.sumPrecise')
}

if (
  defineIfMissing(Promise as unknown as Loose, 'withResolvers', function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  })
) {
  applied.push('Promise.withResolvers')
}

if (
  defineIfMissing(Promise as unknown as Loose, 'try', function promiseTry(
    fn: (...args: unknown[]) => unknown,
    ...args: unknown[]
  ) {
    // 语义：函数同步抛错 → 返回 rejected promise（用 executor 天然获得这个行为）
    return new Promise((resolve) => {
      resolve(fn(...args))
    })
  })
) {
  applied.push('Promise.try')
}

const U8 = Uint8Array as unknown as Loose
const U8Proto = Uint8Array.prototype as unknown as Loose

if (
  defineIfMissing(U8Proto, 'toHex', function toHex(this: Uint8Array) {
    let out = ''
    for (let i = 0; i < this.length; i++) out += HEX_TABLE[this[i]!]
    return out
  })
) {
  applied.push('Uint8Array.prototype.toHex')
}

if (
  defineIfMissing(U8, 'fromHex', function fromHex(hex: string) {
    const s = String(hex).trim()
    if (s.length % 2 !== 0) throw new SyntaxError('Invalid hex string length')
    const out = new Uint8Array(s.length / 2)
    for (let i = 0; i < out.length; i++) {
      const b = parseInt(s.slice(i * 2, i * 2 + 2), 16)
      if (Number.isNaN(b)) throw new SyntaxError('Invalid hex string')
      out[i] = b
    }
    return out
  })
) {
  applied.push('Uint8Array.fromHex')
}

if (
  defineIfMissing(U8Proto, 'toBase64', function toBase64(this: Uint8Array, opts?: unknown) {
    return encodeBase64(this, opts)
  })
) {
  applied.push('Uint8Array.prototype.toBase64')
}

if (
  defineIfMissing(U8, 'fromBase64', function fromBase64(str: string, opts?: unknown) {
    const probe = new Uint8Array(((str.replace(/\s+/g, '').length * 3) / 4) + 3)
    const { written } = decodeBase64To(probe, str, opts)
    return probe.slice(0, written)
  })
) {
  applied.push('Uint8Array.fromBase64')
}

if (
  defineIfMissing(U8Proto, 'setFromBase64', function setFromBase64(
    this: Uint8Array,
    str: string,
    opts?: unknown,
  ) {
    return decodeBase64To(this, str, opts)
  })
) {
  applied.push('Uint8Array.prototype.setFromBase64')
}

// 供诊断用：在旧浏览器上能一眼看出补丁有没有生效
;(globalThis as unknown as Loose).__pdfjsPolyfillsApplied = applied

if (applied.length > 0) {
  console.info(
    `[pdfjs-polyfill] 当前环境缺少 ${applied.length} 个 pdf.js 依赖的新 API，已补齐：`,
    applied.join(', '),
  )
}

export { applied as appliedPolyfills }
