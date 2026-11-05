/**
 * 生成 Markdown 的测试语料（供 `scripts/test-md.mjs` 和手工验收用）。
 *
 * 用法：node scripts/make-md-testdata.mjs
 *
 * 为什么用脚本生成而不是把 .md 提交进仓库：
 *   `public/testdata/` 整个目录都是 .gitignore 的（几 MB 的样本随时可重建）。
 *   而且 `md-large.md` 有 2 MB，提交它等于给每次 clone 加 2 MB 噪音。
 *
 * 产出：
 *   md-basic.md            各种语法点各一处（含本地图片、远程图片、中文标题）
 *   md-unsafe.md           注入 / 越界 / 恶意链接（安全用例的输入）
 *   md-large.md            ~2 MB，用来量首屏与缩放
 *   md-assets/diagram.png  一张 240×120 的纯色 PNG（本地图片的阳性对照）
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(root, 'public/testdata')

// ---------------------------------------------------------------- 一张最小的 PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** 生成一张带横向渐变的 RGB PNG —— 一眼能看出"图真的画上去了" */
function makePng(width, height) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  // 10..12 = compression / filter / interlace = 0

  const raw = Buffer.alloc((width * 3 + 1) * height)
  let o = 0
  for (let y = 0; y < height; y++) {
    raw[o++] = 0 // 每行的 filter type
    for (let x = 0; x < width; x++) {
      raw[o++] = Math.round((x / width) * 255)
      raw[o++] = 90
      raw[o++] = Math.round((y / height) * 200)
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------- md-basic.md

const basic = `# 多格式阅读器验收样本

这份文件覆盖本期约定的 **GFM 基础语法**：表格、任务列表、删除线、自动链接、
代码块、引用、本地图片。中文标题用来验证 slug（锚点）不会把字吃掉。

## 二级标题：文本样式

普通段落，含 **加粗**、*斜体*、~~删除线~~、\`行内代码\`，以及一个
[外部链接](https://example.com/docs) 和一个 [跳到表格](#表格)。

裸链接也要能自动识别：https://example.com/auto

## 列表

- 第一项
- 第二项
  - 嵌套一项
  - 嵌套二项
- 第三项

1. 有序一
2. 有序二
3. 有序三

### 任务列表

- [x] 已经做完的
- [ ] 还没做的
- [x] 也做完了

## 表格

| 能力 | PDF | Markdown |
|---|---|---|
| 缩放 | 页面缩放 | 字号缩放 |
| 批注 | 支持 | 不支持 |
| 目录 | 书签 | 标题 |

## 代码块

\`\`\`ts
// 长行不换行，代码块自己横向滚动 —— 不该把整篇撑出横向滚动条
const veryLongLine = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
function demo(n: number): number {
  return n * 2
}
\`\`\`

## 引用

> 引用里的文字应该是暗一档的，但对比度要够。
>
> 第二段。

## 图片

本地图片（同目录的 md-assets/diagram.png，只有桌面版能显示）：

![本地示意图](md-assets/diagram.png)

远程图片（本期不自动联网，应显示占位）：

![远程图](https://example.com/remote.png)

## 结尾

最后一段，用来确认"滚到底"时不会多出一片空白。
`

// ---------------------------------------------------------------- md-unsafe.md

const unsafe = `# 安全用例：这些都不该生效

如果下面任何一条真的执行了，说明 Markdown 的净化被绕过了。

## 原始 HTML

<script>window.__mdXss = 1</script>

<img src="x" onerror="window.__mdXss = 2">

<iframe src="https://example.com" title="xss"></iframe>

<style>body { display: none }</style>

<div style="position:fixed;inset:0;background:red">盖住整页</div>

## 恶意链接

[点我执行脚本](javascript:window.__mdXss = 3)

[data 链接](data:text/html,<script>window.__mdXss = 4</script>)

[file 协议](file:///C:/Windows/win.ini)

<a href="javascript:window.__mdXss = 5">HTML 里的链接</a>

下面两条 markdown-it 会正常渲染成链接（它只拦 javascript/vbscript/file/data），
但本应用的协议白名单只放行 http/https/mailto —— 所以它们必须变成"死链"样式：

[ftp 链接](ftp://example.com/file)

[相对路径链接](./other.md)

## 越界与远程图片

![跳出文档目录](../outside.png)

![绝对路径](C:\\\\Windows\\\\win.ini)

![UNC 路径](\\\\\\\\server\\\\share\\\\x.png)

![远程图片](https://example.com/track.png)

## 代码块里的内容也只是文本

\`\`\`html
<script>window.__mdXss = 6</script>
<img src=x onerror="window.__mdXss = 7">
\`\`\`

上面代码块里的内容会被语法高亮**当作文字**渲染 —— 任何元素都不该被创建出来。

## 正常内容（对照）

这一段应该**正常显示**，证明净化不是把整篇都吃掉了。
`

// ---------------------------------------------------------------- md-large.md

function makeLarge(targetBytes) {
  const head = '# 大文件性能样本\n\n这段用来量首屏可交互时间和缩放帧率。\n\n'
  const section = (i) => `## 第 ${i} 节

这是第 ${i} 节的一段普通文字，用来撑大文件体积。低配机上渲染 Markdown 的成本
主要来自一次性建 DOM，而不是解析本身 —— 所以样本要**又长又有多级标题**，
才能同时压到标题提取、锚点计算和滚动高亮。

- 列表项 ${i}-1
- 列表项 ${i}-2
  - 嵌套 ${i}-a
- [ ] 待办 ${i}

| 列 A | 列 B |
|---|---|
| ${i} | ${i * 2} |

\`\`\`
code block ${i}
\`\`\`

`
  let out = head
  let i = 1
  while (Buffer.byteLength(out, 'utf8') < targetBytes) {
    out += section(i++)
  }
  return out
}

// ---------------------------------------------------------------- 落盘

await mkdir(resolve(outDir, 'md-assets'), { recursive: true })
await writeFile(resolve(outDir, 'md-basic.md'), basic, 'utf8')
await writeFile(resolve(outDir, 'md-unsafe.md'), unsafe, 'utf8')
await writeFile(resolve(outDir, 'md-large.md'), makeLarge(2 * 1024 * 1024), 'utf8')
await writeFile(resolve(outDir, 'md-assets/diagram.png'), makePng(240, 120))

const sizes = await Promise.all(
  ['md-basic.md', 'md-unsafe.md', 'md-large.md', 'md-assets/diagram.png'].map(async (f) => {
    const { stat } = await import('node:fs/promises')
    const s = await stat(resolve(outDir, f))
    return `${f}: ${(s.size / 1024).toFixed(1)} KB`
  }),
)
console.log('Markdown 测试语料已生成：')
for (const s of sizes) console.log('  ·', s)
