/**
 * 跑 tauri 命令的包装器。
 *
 * 为什么需要它：Tauri CLI 会 shell out 去调 `cargo`，而 cargo **不一定在 PATH 里**
 * （Rust 装到自定义目录、或者 rustup 装了但 PATH 没配好，都会这样）。
 * 直接 `npx tauri build` 会报 "cargo not found"，看起来像工具链没装。
 * 这个包装器负责把工具链环境补齐，所以对外只需要记住 `npm run exe` 一条命令。
 *
 * 用法：
 *   npm run exe              # 只出 exe（不打包安装包，快）
 *   npm run tauri -- dev     # 桌面端调试
 *   npm run tauri -- build   # 出安装包
 *
 * 查找顺序：
 *   1. **PATH 里已有的 cargo** —— 正常 `rustup` 安装都走这条，什么都不用配
 *   2. `EPL_RUST_HOME` —— 装在别处时指定，例如 EPL_RUST_HOME=D:\path\to\rust
 *   3. 几个常见的自定义安装位置
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

/*
 * ⚠️ Windows 上 PATH 这个变量名的**大小写是不固定的**（可能是 `Path`），
 * 而 Node 的环境变量对象是**大小写敏感**的。
 * 直接读 `process.env.PATH` 可能拿到 undefined，写 `env.PATH = ...` 则会
 * 造出第二个键 —— 结果是"我明明改了 PATH，子进程却看不到"。
 */
const PATH_KEY = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
const envPath = process.env[PATH_KEY] ?? ''

/** ① PATH 里有 cargo 吗？有就什么都不用做 —— 这是绝大多数人的情况 */
function cargoInPath() {
  for (const dir of envPath.split(delimiter)) {
    if (dir && existsSync(join(dir, 'cargo.exe'))) return dir
  }
  return null
}

/**
 * 在某个 RUST_HOME 下找出工具链的 bin（目录名带版本号，不能写死）。
 *
 * ⚠️ **必须优先 MSVC**，不能"取第一个"：rustup 的 `toolchains/` 里
 *    gnu 和 msvc 常常**并存**，而 `stable-x86_64-pc-windows-gnu` 按字母序排在
 *    前面。取第一个就会选中 gnu —— Tauri 在 Windows 上只能链 WebView2，
 *    用 gnu 会一直编到链接阶段才炸，错误还很难懂。
 */
function toolchainBin(rustHome) {
  const dir = join(rustHome, 'rustup', 'toolchains')
  if (!existsSync(dir)) return null
  const names = readdirSync(dir)
  const ordered = [
    ...names.filter((n) => /msvc/i.test(n)),
    ...names.filter((n) => !/msvc/i.test(n)),
  ]
  for (const name of ordered) {
    const bin = join(dir, name, 'bin')
    if (existsSync(join(bin, 'cargo.exe'))) return bin
  }
  return null
}

const args = process.argv.slice(2)

// ---------------------------------------------------------------- 决定用哪套环境
let env = { ...process.env }

/** ② PATH 里没有 → 按"独立目录安装"的布局找一套 */
function standaloneInstall() {
  const candidates = [
    process.env.EPL_RUST_HOME,
    join(process.env.USERPROFILE ?? '', '.cargo'), // rustup 的默认家目录
    'C:\\tools\\rust',
    'D:\\tools\\rust',
  ].filter(Boolean)

  for (const home of candidates) {
    const bin = toolchainBin(home)
    if (bin) return { home, bin }
  }
  return null
}

/** cargo.exe 的绝对路径 —— 后面所有探测都直接调它，不经过 shell */
let cargoExe = ''

const inPath = cargoInPath()
if (inPath) {
  cargoExe = join(inPath, 'cargo.exe')
  console.log(`[tauri.mjs] 用 PATH 里的 cargo：${cargoExe}`)
} else {
  const found = standaloneInstall()
  if (!found) {
    console.error('[tauri.mjs] 找不到 cargo。三选一：')
    console.error('  1) 装一个：https://rustup.rs  （Windows 上要 MSVC 工具链，gnu 的不能打包 Tauri）')
    console.error('  2) 如果 Rust 装在别处，把它的家目录告诉这个脚本：set EPL_RUST_HOME=<目录>')
    console.error('     期望的结构：<目录>\\rustup\\toolchains\\<工具链名>\\bin\\cargo.exe')
    console.error('  3) 或者把 cargo 加进 PATH')
    process.exit(1)
  }

  cargoExe = join(found.bin, 'cargo.exe')
  console.log(`[tauri.mjs] PATH 里没有 cargo，改用独立安装的这套：${found.home}`)
  env = {
    ...env,
    CARGO_HOME: join(found.home, 'cargo'),
    RUSTUP_HOME: join(found.home, 'rustup'),
    // 注意用探测到的键名，别再造一个 PATH 出来
    [PATH_KEY]: `${found.bin}${delimiter}${join(found.home, 'cargo', 'bin')}${delimiter}${envPath}`,
  }
}

/*
 * 提前把「cargo 能不能跑」暴露出来，而不是等 tauri 跑到一半才报错。
 *
 * ⚠️ 用**绝对路径 + 不开 shell**：靠 shell 去解析 PATH 在这里翻过车 ——
 *    `spawnSync('cargo', ..., {shell:true})` 明明把 PATH 注入了却拿不到结果，
 *    而且失败时连 stderr 都是空的，完全看不出为什么。
 *    既然我们已经知道 cargo.exe 在哪，直接调它就行，不需要中间那层 shell。
 */
const probe = spawnSync(cargoExe, ['--version'], { env, encoding: 'utf8' })
if (probe.error || probe.status !== 0) {
  /*
   * 探测失败**不等于** cargo 不能用：某些受限环境（沙箱、CI 的权限策略）
   * 不允许从 Node 里再起子进程，会直接给 EBUSY 之类。
   * 所以这里只提示，不退出 —— 让 tauri 自己去调，真正的错误由它给出更权威。
   * （早期版本在这里直接 process.exit(1)，结果在受限环境里"明明能打包却报找不到工具链"。）
   */
  console.warn(`[tauri.mjs] 提示：cargo --version 没跑通（${probe.error?.message ?? `退出码 ${probe.status}`}）`)
  console.warn('            不阻断，继续交给 tauri —— 真正的错误会由它给出。')
} else {
  console.log(`[tauri.mjs] ${probe.stdout.trim()}`)
}

// Tauri 在 Windows 上只能链 WebView2，gnu 工具链会失败 —— 提前挡住，
// 否则要等到链接阶段才报一个很难懂的错
const rustcExe = join(dirname(cargoExe), 'rustc.exe')
const host = spawnSync(rustcExe, ['-vV'], { env, encoding: 'utf8' })
if (host.status === 0 && !/msvc/i.test(host.stdout)) {
  console.error('[tauri.mjs] 当前工具链不是 MSVC，Tauri 打包需要：')
  console.error('  rustup default stable-x86_64-pc-windows-msvc')
  process.exit(1)
}

console.log(`[tauri.mjs] 执行: npx tauri ${args.join(' ')}\n`)

const child = spawn('npx', ['tauri', ...args], {
  stdio: 'inherit',
  // npx 在 Windows 上是 .cmd，必须走 shell
  shell: true,
  env,
})

child.on('exit', (code) => process.exit(code ?? 0))
