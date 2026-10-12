#!/usr/bin/env node
/**
 * 取回「真实论文语料」测试样本 public/testdata/real-1706.03762.pdf。
 *
 * 为什么需要它：
 *   合成样本（`make-testdata.mjs` 产的文字页/矢量页）验证不了真实文档的**页面构成** ——
 *   真实论文里同时有内嵌字体、整页图片、上百条既有注释。项目里好几个决定性结论都是
 *   在这份语料上测出来的（"中文书慢是因为整页图片、不是字形"、"增量写回在大文件上的价值"），
 *   **7 个测试脚本**也都直接依赖它（viewer / interact / touch / preview / exe / exe-heal / csp）。
 *
 * 为什么不入库：
 *   ① 2.2 MB，且仓库里其它样本都是几 KB ~ 几十 KB 级；
 *   ② 它是 arXiv 的电子预印本，**没有允许再分发的授权** —— 放进仓库等于替别人分发。
 *   所以 `public/testdata/` 整体在 `.gitignore` 里，这份文件按需下载到本地。
 *
 * 用法：
 *   npm run testdata:real          # 已存在就跳过（幂等）
 *   EPL_REAL_PDF_URL=<镜像地址> npm run testdata:real    # 拿不到 arxiv.org 时换镜像
 *
 * 手动方式（脚本失败时）：把任意一份真实 PDF 存成
 *   public/testdata/real-1706.03762.pdf
 * 也可以跑 —— 测试并不检查它的具体内容，只要"是份有字有图的真 PDF"。
 *
 * ⚠️ 这个文件**只落在本地**，永远不会被 `git add` 进来（`.gitignore` 已挡）。
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public', 'testdata', 'real-1706.03762.pdf')
const DEFAULT_URL = 'https://arxiv.org/pdf/1706.03762'
const URL_SRC = process.env.EPL_REAL_PDF_URL ?? DEFAULT_URL
const USING_DEFAULT = URL_SRC === DEFAULT_URL

/** 读前几个字节判 PDF 魔数 */
async function isPdf(path) {
  try {
    const buf = await readFile(path)
    return buf.subarray(0, 5).toString('latin1') === '%PDF-'
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- 幂等：已存在就跳过
if (await isPdf(OUT)) {
  const s = await stat(OUT)
  console.log(`✓ 样本已存在，跳过下载：${OUT}（${(s.size / 1024 / 1024).toFixed(2)} MB）`)
  process.exit(0)
}

await mkdir(dirname(OUT), { recursive: true })

console.log(`→ 下载真实论文语料\n  来源：${URL_SRC}\n  存到：${OUT}`)

/** 方式一：Node 内置 fetch（不装依赖） */
async function viaFetch() {
  const res = await fetch(URL_SRC, {
    redirect: 'follow',
    headers: { 'User-Agent': 'edge-pdf-lite-testdata/1.0' },
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('拿到的不是 PDF（多半是被网关/登录页拦了）')
  }
  return buf
}

/**
 * 方式二：curl。
 * ⚠️ 保留这一条是因为 Node 的 fetch **不读 `http_proxy` / `https_proxy`** ——
 *    在必须走代理的网络里它会直接失败，而 curl 会自己认环境变量。
 *    不给 curl 加 `--ssl-no-revoke`：那是跳过证书吊销检查，属于降低安全性，
 *    需要的人自己加（失败提示里写了）。
 */
function viaCurl() {
  const r = spawnSync('curl', ['-fsSL', '--max-time', '180', '-o', OUT, URL_SRC], {
    encoding: 'utf8',
  })
  if (r.error) throw new Error(`curl 不可用：${r.error.message}`)
  if (r.status !== 0) throw new Error(`curl 退出码 ${r.status}${r.stderr ? '：' + r.stderr.trim() : ''}`)
}

let bytes = null
const failures = []
for (const [name, fn] of [
  ['fetch', viaFetch],
  ['curl', viaCurl],
]) {
  try {
    // 两种方式都统一从 OUT 读结果：fetch 的返回值只是"下载成功"的信号，
    // 落到同一个文件再读，能顺带验证"真的写进去了"。
    const fetched = await fn()
    bytes = name === 'fetch' ? fetched : await readFile(OUT)
    console.log(`  ✓ ${name} 下载成功`)
    break
  } catch (e) {
    failures.push(`${name}: ${e.message}`)
    console.log(`  ✗ ${name} 失败：${e.message}`)
  }
}

if (!bytes) {
  console.error(`
✗ 没能取到 ${URL_SRC}

失败原因：
${failures.map((f) => '  · ' + f).join('\n')}

不影响什么：npm run dev / npm run build 都用不到这份样本，
（合成样本已由 npm run testdata:local 生成，应用本身照常能跑。）

要跑完整测试，三种办法任选：
  1. 换镜像重试（公司/校园网常见）：
       EPL_REAL_PDF_URL=<镜像地址> npm run testdata:real
  2. 手动下载后放到这个位置（文件名必须一致）：
       ${OUT}
  3. 手边有别的真实 PDF 就直接改名放过去 —— 测试不检查内容，
     只要"有文字层、有图片、最好带既有批注"就够。

  网络需要跳过证书吊销检查的话（本机访问 GitHub 就是这个毛病）：
       curl -L --ssl-no-revoke -o "${OUT}" "${URL_SRC}"
`)
  process.exit(1)
}

await writeFile(OUT, bytes)

const kb = bytes.length / 1024
console.log(`✓ 已保存 ${OUT}（${kb.toFixed(1)} KB）`)
if (USING_DEFAULT && kb < 500) {
  console.warn(
    `⚠️ 文件偏小（${kb.toFixed(1)} KB），默认来源应该约 2.2 MB。\n` +
      '   可能是被网关截断或换成了别的东西 —— 依赖它的测试可能表现异常。',
  )
}
