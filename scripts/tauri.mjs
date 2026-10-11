/**
 * 跑 tauri 命令的包装器。
 *
 * 为什么需要它：Rust 装在 `<Rust 安装目录>` 且**不在 PATH**，
 * 而 Tauri CLI 会 shell out 去调 `cargo` —— 直接 `npx tauri build`
 * 必然报 "cargo not found"。
 *
 * 用法：
 *   npm run exe              # 只出 exe（不打包安装包，快）
 *   npm run tauri -- dev     # 桌面端调试
 *   npm run tauri -- build   # 出安装包
 *
 * 不想用这个目录可以用 EPL_RUST_HOME 覆盖。
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const RUST_HOME = process.env.EPL_RUST_HOME || 'D:\\tools\\rust'
const CARGO_HOME = join(RUST_HOME, 'cargo')
const RUSTUP_HOME = join(RUST_HOME, 'rustup')

/** 工具链的 bin 目录（里面得有 cargo.exe）—— 名字可能带版本号，不能写死 */
function findToolchainBin() {
  const dir = join(RUSTUP_HOME, 'toolchains')
  if (!existsSync(dir)) return null
  for (const name of readdirSync(dir)) {
    const bin = join(dir, name, 'bin')
    if (existsSync(join(bin, 'cargo.exe'))) return bin
  }
  return null
}

const tcBin = findToolchainBin()
if (!tcBin) {
  console.error(`[tauri.mjs] 在 ${RUSTUP_HOME}\\toolchains 下没找到带 cargo.exe 的工具链`)
  console.error('  先装一个（Tauri 在 Windows 上要 MSVC 版，gnu 的不行）：')
  console.error('  rustup toolchain install stable-x86_64-pc-windows-msvc')
  process.exit(1)
}

const args = process.argv.slice(2)

console.log(`[tauri.mjs] CARGO_HOME=${CARGO_HOME}`)
console.log(`[tauri.mjs] 工具链=${tcBin}`)
console.log(`[tauri.mjs] 执行: npx tauri ${args.join(' ')}\n`)

const child = spawn('npx', ['tauri', ...args], {
  stdio: 'inherit',
  // npx 在 Windows 上是 .cmd，必须走 shell
  shell: true,
  env: {
    ...process.env,
    CARGO_HOME,
    RUSTUP_HOME,
    PATH: `${tcBin};${join(CARGO_HOME, 'bin')};${process.env.PATH}`,
  },
})

child.on('exit', (code) => process.exit(code ?? 0))
