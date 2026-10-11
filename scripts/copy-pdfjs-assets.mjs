// 把 pdfjs-dist 自带的 cmaps / standard_fonts 拷进 public/。
// 中文 PDF 的渲染与文本层依赖它们，缺了会显示异常或文本层错位。
import { cp, mkdir, rm, access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcRoot = resolve(root, 'node_modules/pdfjs-dist')
const dstRoot = resolve(root, 'public')

const JOBS = [
  ['cmaps', 'cmaps'],
  ['standard_fonts', 'standard_fonts'],
]

const exists = async (p) => {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

let copied = 0
for (const [from, to] of JOBS) {
  const src = resolve(srcRoot, from)
  const dst = resolve(dstRoot, to)
  if (!(await exists(src))) {
    console.warn(`[pdfjs-assets] 跳过（源不存在）: ${src}`)
    continue
  }
  await rm(dst, { recursive: true, force: true })
  await mkdir(dirname(dst), { recursive: true })
  await cp(src, dst, { recursive: true })
  console.log(`[pdfjs-assets] ${from} -> public/${to}`)
  copied++
}

if (copied === 0) {
  console.warn('[pdfjs-assets] 什么都没拷到，检查 node_modules/pdfjs-dist 是否已安装')
}
