/**
 * Markdown 文档模型 —— 从字节到"可以安全塞进 DOM 的 HTML"。
 *
 * ## 为什么要把渲染和阅读器分开
 * `MarkdownViewer.vue` 只管滚动、缩放、图片加载这些**界面**的事；
 * "这段 Markdown 变成什么 HTML、里面有没有危险的东西"全部收在这里。
 * 这样安全策略只有一处、测试也只测一处 —— 分散到组件里迟早会漏。
 *
 * ## 安全基线（三条，缺一不可）
 * 1. `markdown-it` 用 `html: false`：原文里的 HTML 被**转义**，不是执行。
 * 2. 产物再过一遍 DOMPurify：白名单标签/属性，禁掉 `style`/`form`/`iframe`/`svg` 等。
 * 3. 链接与图片**由我们自己重写**：`javascript:` / `data:` / `file:` / 远程图片
 *    一律不放进 `href` / `src`，只留一个占位标记 + 原因。
 *    第 3 条是真正的闸门 —— 前两条挡的是"标签注入"，挡不住"点一下就跳走"。
 */
import MarkdownIt from 'markdown-it'
import taskLists from 'markdown-it-task-lists'
import DOMPurify from 'dompurify'

export interface MdHeading {
  /** 稳定 id（GitHub 风格 slug + 重名序号），同时写进 DOM 的 `id` */
  id: string
  level: number
  text: string
}

/** 图片占位的原因 —— 文案在组件里拼，这里只给机器可读的代号 */
export type MdImgReason = 'remote' | 'absolute' | 'scheme' | 'empty'

const md = new MarkdownIt({
  /*
   * 🔴 `html: false` 是安全基线的一部分，不是"少一个功能"。
   *    打开它，笔记里随便一段 `<script>` 就会被塞进 DOM —— DOMPurify 虽然也会
   *    再挡一次，但"能不能执行"不该依赖第二道防线的版本行为。
   */
  html: false,
  // 裸 URL 自动变链接（GFM 的 autolink）。只影响渲染，链接仍会被下面的规则重写。
  linkify: true,
  // 换行保持 CommonMark 语义（单换行不分段）—— 跟 Typora/GitHub 一致
  breaks: false,
  typographer: false,
})
  /*
   * 任务列表：`- [x] 做完的`。插件只负责生成 `li.task-list-item` + 一个
   * disabled checkbox，那个 checkbox 在下面会被换成**纯 span**（见 `upgradeDom`）。
   */
  .use(taskLists, { enabled: false, label: false })

/** DOMPurify 的配置：只做"标签/属性"这一层，URL 由下面的规则单独管 */
const SANITIZE = {
  FORBID_TAGS: ['style', 'form', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'svg', 'math'],
  // `style` 属性可以拿来盖住整个界面（position:fixed + opacity:0），必须去掉；
  // `srcset` 是浏览器自己挑 URL 的入口，也要去掉
  FORBID_ATTR: ['style', 'srcset', 'formaction', 'action'],
  ALLOW_DATA_ATTR: true,
  /*
   * 🔴 默认的 URI 白名单只认 http/https/mailto/ftp 等协议 —— **盘符绝对路径
   *    会被整条剥掉**，src 变空 → 分类成"图片地址是空的"，
   *    用户看到的提示完全误导（真实用户就这么踩的）。
   *
   * 追加两条放行（危险协议仍然进不来）：
   *   · `[a-z]:(?:[/\\]|%5c)` —— 单字母 + 冒号的盘符形态。⚠️ 冒号后除了斜杠
   *     还要接受 **%5c**：markdown-it 会把目的地里的 `\` 编码成 %5C
   *     （`D:\图\x.png` → `D:%5C图%5Cx.png`，冒号后跟的是 `%` 不是斜杠），
   *     不认 %5c 的话反斜杠路径全被剥掉（真实用户踩的就是这个）。
   *     `javascript:`/`data:` 冒号前有多个字母，撞不上这条；`file:` 的
   *     协议判断仍在 classifyImg。
   *   · `data:` —— 只为 `<img>` 的内联图；`<a href="data:...">` 会在
   *     upgradeDom 的链接重写里被移除（只留 http/https/mailto），不构成执行面。
   *
   * 最终的放行 / 拒绝决策仍然全部在 classifyImg + 链接重写里，这里只是
   * "别让净化器把我们要分类的原料扔掉"。
   */
  ALLOWED_URI_REGEXP:
    /^(?:(?:https?|mailto|ftp|tel|callto|sms|cid|xmpp|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$)|[a-z]:(?:[/\\]|%5c))/i,
}

/** GitHub 风格的标题 slug：小写、去标点、空格转连字符；中文原样保留 */
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s]+/g, '-')
    // 去掉 ASCII 标点（保留 - 和 _）。中文标点不在这个集合里，但也无害
    .replace(/[!-/:-@[-`{-~]/g, '')
    .replace(/^-+|-+$/g, '')
}

/** 文档层拦下的图片（远程 / 绝对路径 / 协议不允许 / 空地址）给**看得见**的原因。
 *  🔴 不能只写在 data 属性里：alt 为空时用户看到的就只有一个"图片"，
 *     完全无从判断为什么 —— 这正是用户报"怎么还是占位符"时查不到原因的原因。 */
export function mdImgBlockedText(reason: MdImgReason): string {
  switch (reason) {
    case 'remote':
      return '远程图片不自动加载'
    case 'absolute':
      return '笔记文件夹之外的图片（桌面端会弹出授权确认，允许后显示）'
    case 'scheme':
      return '不支持这种链接形式的图片'
    case 'empty':
      return '图片地址是空的'
  }
}

/** 图片 `src` 分类。决策结果直接决定"加载 / 占位 / 拒绝" */
function classifyImg(src: string):
  | { kind: 'data'; value: string }
  | { kind: 'relative'; value: string }
  | { kind: 'blocked'; reason: MdImgReason; absolutePath?: string } {
  const s = src.trim()
  if (!s) return { kind: 'blocked', reason: 'empty' }
  // 内联 data:image 不联网、也不经过文件系统 —— 直接放行（CSP 已允许 data:）
  if (/^data:image\//i.test(s)) return { kind: 'data', value: s }
  /*
   * 🔴 分类前必须先解一份**百分号解码**的探测串：
   *    markdown-it 会把目的地里的 `\`、空格等编码成 %5C / %20
   *    （`C:\Windows\win.ini` → `C:%5CWindows%5Cwin.ini`）——
   *    不解码的话所有盘符/UNC 路径都会被误判成"协议不允许"或"空地址"
   *    （真实用户就是这么看到满屏占位的）。原始 `src` 只在 data 分支里用。
   */
  let probe = s
  try {
    probe = decodeURIComponent(s)
  } catch {
    /* 畸形的 % 序列：按原文探测 */
  }
  // 远程（含协议相对的 //host/x.png）：v1 不自动联网
  if (/^https?:/i.test(probe) || probe.startsWith('//')) {
    return { kind: 'blocked', reason: 'remote' }
  }
  /*
   * file:///C:/dir/img.png —— Typora / 从网页复制时常见。
   * 剥掉协议、还原成绝对路径，按 absolute 处理（桌面端走授权弹窗）；
   * 还原不出本地路径的（非 Windows 盘符等）仍按"协议不允许"拦。
   */
  if (/^file:\/\//i.test(probe)) {
    try {
      const p = decodeURIComponent(probe.replace(/^file:\/\/\/?/i, ''))
      if (/^[a-z]:[\\/]/i.test(p) || p.startsWith('/')) {
        return { kind: 'blocked', reason: 'absolute', absolutePath: p }
      }
    } catch {
      /* 畸形转义 → 按协议不允许 */
    }
    return { kind: 'blocked', reason: 'scheme' }
  }
  /*
   * 盘符绝对路径 / UNC / 根路径：**必须排在协议判断之前** ——
   * `D:` 单字母+冒号会被下面的通用协议正则当成自定义协议吃掉。
   * ⚠️ 盘符后除了斜杠还要认 **%5c**：probe 的解码失败时会保留原始编码形态
   *    （`D:%5C图.png`），不能因为解码不了就把它判成"协议不允许"。
   */
  if (
    /^[a-z]:(?:[/\\]|%5c)/i.test(probe) ||
    probe.startsWith('\\\\') ||
    /^%5c/i.test(probe) ||
    probe.startsWith('/')
  ) {
    return { kind: 'blocked', reason: 'absolute', absolutePath: probe }
  }
  // 其他协议（javascript: / 自定义）
  if (/^[a-z][a-z0-9+.-]*:/i.test(probe)) return { kind: 'blocked', reason: 'scheme' }
  // 相对路径：probe 已经解码过（`my%20pic.png` → `my pic.png`）
  const rel = probe.replace(/^\.\//, '')
  return { kind: 'relative', value: rel }
}

/**
 * 把渲染产物改造成"界面可以直接用"的形状：
 * - 标题补 `id`（给大纲跳转 / `#anchor` 链接用）
 * - 图片换成占位 span（真正的 `<img>` 由阅读器在拿到字节后创建）
 * - 链接按协议分流：能开的留 `data-md-href`，不能开的变成死链样式
 * - 表格套一层可横向滚动的容器（表格自己滚会破坏列宽算法）
 */
function upgradeDom(box: HTMLElement): MdHeading[] {
  const headings: MdHeading[] = []
  const used = new Map<string, number>()

  for (const el of box.querySelectorAll<HTMLHeadingElement>('h1,h2,h3,h4,h5,h6')) {
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    const base = slugify(text) || 'section'
    const n = used.get(base) ?? 0
    used.set(base, n + 1)
    const id = n === 0 ? base : `${base}-${n}`
    el.id = id
    headings.push({ id, level: Number(el.tagName.slice(1)), text })
  }

  // 任务列表：把 disabled checkbox 换成纯 span（保留勾选状态）
  for (const li of box.querySelectorAll('li.task-list-item')) {
    const input = li.querySelector('input[type="checkbox"]')
    if (!input) continue
    const mark = document.createElement('span')
    mark.className = input.hasAttribute('checked') ? 'md-task on' : 'md-task'
    mark.setAttribute('aria-hidden', 'true')
    input.replaceWith(mark)
  }

  // 图片：一律先换成占位，相对路径的由阅读器异步换成 Blob URL
  for (const img of [...box.querySelectorAll<HTMLImageElement>('img')]) {
    const alt = (img.getAttribute('alt') ?? '').trim()
    const title = (img.getAttribute('title') ?? '').trim()
    const src = img.getAttribute('src') ?? ''
    const cls = classifyImg(src)
    const ph = document.createElement('span')
    ph.className = 'md-img-ph'
    ph.setAttribute('data-md-alt', alt)
    if (title) ph.setAttribute('data-md-title', title)
    if (cls.kind === 'data') {
      // 内联图片：直接渲染（不产生网络请求、不读磁盘）
      const keep = document.createElement('img')
      keep.src = cls.value
      keep.alt = alt
      if (title) keep.title = title
      img.replaceWith(keep)
      continue
    }
    if (cls.kind === 'relative') {
      ph.setAttribute('data-md-img', cls.value)
      ph.textContent = alt || '图片'
    } else {
      /*
       * 被安全规则拦下（远程 / 绝对路径 / 协议 / 空地址）。
       * 🔴 原因必须**写在字面上**，不能只留在 data 属性里 —— alt 为空时
       *    用户看到的就只有一个"图片"，完全无从判断为什么；
       *    原始地址挂 title，悬停可查（照着改笔记就能修）。
       */
      ph.setAttribute('data-md-blocked', cls.reason)
      // absolute 类带上**可读的本地路径**（file:// 已剥协议）——授权弹窗和读取都按它来
      if (cls.absolutePath) ph.setAttribute('data-md-src', cls.absolutePath)
      const t = mdImgBlockedText(cls.reason)
      ph.textContent = alt ? `${alt}（${t}）` : t
      ph.title = src
    }
    img.replaceWith(ph)
  }

  // 链接：只留"应用自己知道怎么处理"的形式
  for (const a of box.querySelectorAll<HTMLAnchorElement>('a')) {
    const href = (a.getAttribute('href') ?? '').trim()
    if (href.startsWith('#')) {
      a.classList.add('md-anchor')
      continue
    }
    if (/^(https?|mailto):/i.test(href)) {
      a.setAttribute('rel', 'noopener noreferrer')
      // 真正的 href 仍保留（右键"复制链接地址"还有用），点击由阅读器拦截
      a.setAttribute('data-md-href', href)
      continue
    }
    a.removeAttribute('href')
    a.classList.add('md-link-dead')
    a.title = '暂不支持打开这类链接（只允许 http / https / mailto）'
  }

  // 表格：套一层滚动容器
  for (const table of [...box.querySelectorAll('table')]) {
    const wrap = document.createElement('div')
    wrap.className = 'md-table-wrap'
    table.replaceWith(wrap)
    wrap.appendChild(table)
  }

  /*
   * 兜底：DOMPurify 之后仍然**不允许**任何表单/脚本类元素存在。
   * 这一步不是重复劳动 —— 它让"最终产物里没有 input"成为一条可以断言的事实，
   * 而不是"相信净化器的默认白名单里恰好没有"。
   */
  for (const junk of box.querySelectorAll('script,form,input,button,textarea,select')) {
    junk.remove()
  }

  return headings
}

/** 32 位 FNV-1a（指纹的兜底方案：没有 `crypto.subtle` 的环境用） */
function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5
  // 抽样到最多 64 KB：指纹只用来区分文档，不需要密码学强度，也不该为它多扫一遍 16 MB
  const step = Math.max(1, Math.floor(bytes.length / 65536))
  for (let i = 0; i < bytes.length; i += step) {
    h ^= bytes[i]!
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${h.toString(16)}-${bytes.length.toString(16)}`
}

/**
 * 内容指纹。用 SHA-256 的前 16 字节（与 PDF 用 pdf.js 的指纹同一个用途：
 * 改文件名、换目录，阅读位置照样认得出来）。
 */
async function fingerprintOf(bytes: Uint8Array): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle
    if (subtle) {
      // 只切一份 ArrayBuffer 视图，不复制整份字节
      const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      const digest = await subtle.digest('SHA-256', view as ArrayBuffer)
      return [...new Uint8Array(digest)]
        .slice(0, 16)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    }
  } catch {
    /* 非安全上下文 / 老 WebView：走下面的兜底 */
  }
  return fnv1a(bytes)
}

export class MarkdownDocument {
  private constructor(
    readonly name: string,
    /** 真实路径（桌面端）；浏览器端是空串 —— 本地图片就靠它判断能不能读 */
    readonly path: string,
    readonly text: string,
    readonly fingerprint: string,
    readonly html: string,
    readonly headings: readonly MdHeading[],
    readonly byteLength: number,
  ) {}

  static async open(bytes: Uint8Array, name: string, path = ''): Promise<MarkdownDocument> {
    // UTF-8 优先；非法字节**替换**不抛错（笔记里混进 GBK 片段很常见，
    // 为此整篇打不开是最糟的结果）
    let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    // 去 BOM：Windows 记事本存出来的 .md 常带，留在正文里会显示成一个奇怪的方块
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

    const raw = md.render(text)
    const clean = DOMPurify.sanitize(raw, SANITIZE)

    const box = document.createElement('div')
    box.innerHTML = clean
    const headings = upgradeDom(box)

    const fingerprint = await fingerprintOf(bytes)
    return new MarkdownDocument(
      name,
      path,
      text,
      fingerprint,
      box.innerHTML,
      headings,
      bytes.length,
    )
  }

  /** 有没有标题（没有标题时大纲显示空状态，而不是一个空白面板） */
  get hasHeadings(): boolean {
    return this.headings.length > 0
  }

  /**
   * 释放。
   *
   * ⚠️ 这里现在没有需要释放的原生资源（图片 Blob URL 归 `MarkdownViewer` 管），
   *    保留这个方法是为了让"换文档时必须调一次"的调用点先存在 ——
   *    等哪天加了缓存/Worker，调用方不用再改一遍。
   */
  close(): void {
    /* 见方法注释 */
  }
}
