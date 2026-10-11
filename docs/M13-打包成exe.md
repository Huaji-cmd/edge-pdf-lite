# M13 · 打包成 exe（Tauri v2）

> 结论先说：**打出来了，能跑，worker 在 exe 里正常工作。**
> 产物：裸 exe 13 MB / NSIS 安装包 5.8 MB / MSI 6.7 MB。

---

## 一、怎么打包

```bash
npm run exe                # 只出裸 exe（免安装，双击即用）
npm run tauri -- build     # 完整：exe + msi + nsis 安装包
npm run tauri -- dev       # 桌面端调试（热重载）
```

产物位置：

| 产物 | 路径 | 大小 |
|---|---|---|
| 裸 exe | `src-tauri/target/release/edge-pdf-lite.exe` | 13 MB |
| NSIS 安装包 | `src-tauri/target/release/bundle/nsis/*-setup.exe` | 5.8 MB |
| MSI | `src-tauri/target/release/bundle/msi/*.msi` | 6.7 MB |

**cargo 不在 PATH**，所以多了 `scripts/tauri.mjs` 这层包装：
它自己找出工具链的 `bin` 并注入 `CARGO_HOME` / `RUSTUP_HOME` / `PATH`。

---

## 二、🔴 卡我最久的那个坑：Cargo 依赖 bug

编译直接失败：

```
error[E0107]: struct takes 3 generic arguments but 2 generic arguments were supplied
  schemars-0.8.22: pub type Map<K, V> = indexmap::IndexMap<K, V>;
  indexmap-1.9.2:  pub struct IndexMap<K, V, S>
```

### 根因

indexmap 1.x 的定义分两条 `cfg`：

```rust
#[cfg(has_std)]      pub struct IndexMap<K, V, S = RandomState>  // S 有默认，能用
#[cfg(not(has_std))] pub struct IndexMap<K, V, S>                // 没有默认，少一个泛型就报错
```

它的构建脚本逻辑是：显式开了 `std` feature 就 emit `has_std`，否则探测 sysroot。
而构建脚本的输出文件里**只有 `rustc-check-cfg`、没有 `rustc-cfg=has_std`** → 走了 no_std 那条。

### 修法（关键是第二点）

`src-tauri/Cargo.toml` 里显式依赖 indexmap 并开 std，
**`[dependencies]` 和 `[build-dependencies]` 两处都要加**：

```toml
indexmap = { version = "1.9", features = ["std"] }
```

⚠️ **只加 `[dependencies]` 完全无效** —— `schemars` 是 **`tauri-build` 的 build-dependency**，
Cargo 对 build-dependencies 和 dependencies 是**分开做 feature 解析**的。
我在这上面白折腾了两轮（还试过把 indexmap 从 1.9.3 降级到 1.9.2，无效）。

### 可复用的诊断手法

别只盯着编译错误 —— **直接读构建脚本的输出**：

```bash
cat src-tauri/target/release/build/indexmap-*/output
```

缺哪条 `cargo:rustc-cfg`，一眼就能看出来。这比从错误信息往回推快得多。

---

## 三、另外三个坑（都不是"Tauri 不行"）

1. **Git Bash 里 PATH 要用 `/d/your-tools/...`，不能用 `D:/your-tools/...`**
   之前一直报 `cargo: command not found`，真因是这个，不是工具链装错。

2. **`vite.config.ts` 里不能写 `minify: 'esbuild'`**
   本项目用的是 **rolldown 版 vite**，压根没装 esbuild 包。写了会报
   `Cannot find package 'esbuild'`，而且报错指向 worker 打包 —— 非常误导。

3. **被中断的 vite build 会留下"看起来正常"的坏 dist**
   清空操作被拦下后，`assets/` 已被删、`index.html` 还在 → 像构建成功，
   实际缺 JS，打出来的 exe 加载不到脚本。
   **判据：`ls dist/assets/*.js`**，不能只看 `index.html` 在不在。

---

## 四、验证：worker 在 exe 里能工作吗

这是本项目最需要验证的一点，因为我们的 worker 不是标准写法
（自定义入口 + ES2025 polyfill + `workerSrc` 必须是绝对 URL + 一层 blob 包装器）。

### 方法

给 WebView2 开远程调试端口，然后用 CDP 连上去（`scripts/test-exe.mjs`）：

```js
spawn(EXE, [], { env: { ...process.env,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9333' } })
// 然后 /json/list 拿 target → Runtime.evaluate → DOM.setFileInputFiles → 数画布
```

### 判据（两条都要）

| # | 判据 | 实测 |
|---|---|---|
| ① | **页面真的渲染出画布** | 画布 2 个，numPages 15 ✅ |
| ② | **渲染期间主线程最大卡顿** | **43–44 ms** ✅ |

第 ② 条才是关键：**worker 失败时 pdf.js 会静默退回主线程渲染** ——
页面照样能显示、控制台也不一定报错，但会卡几百毫秒。
所以"能显示"和"没报错"都**不足以**证明 worker 正常。

### 一个自己踩的判断错误

⚠️ **Tauri v2 在 Windows 上用的是 `http://tauri.localhost/`，不是 `tauri://`**
（`tauri://` 是 macOS/Linux 那套）。我第一版断言写成"协议不是 http"，白红一次。

---

## 五、无边框窗口

- `tauri.conf.json` → `decorations: false`，标题栏由 `TitleBar.vue` 自己画
- **窗口控制要显式授权**（`src-tauri/capabilities/default.json`）：
  `core:window:allow-minimize` / `maximize` / `unmaximize` / `close` / `is-maximized` /
  `start-dragging` —— 这些**不在 `core:default` 里**，
  少任何一条的表现都是"点了没反应"，且不报错
- `[package] name` 决定 exe 文件名（模板默认 `app` → `app.exe`）；
  改成 `edge-pdf-lite` 要同步改 `[lib] name` 和 `main.rs` 的引用
- 前端侧：`@tauri-apps/api` 用**动态 import**，避免浏览器版为桌面端 API 付体积
- **代价**：失去系统"拖到屏幕边缘自动分屏"（用户已确认接受）

---

## 六、更正一个早先的判断

体检阶段我用 `curl https://github.com` 得到 000，据此写了
"GitHub 不通、NSIS/WiX 可能下不来、大概率只能拿到裸 exe"。

**这是错的。** 实际打包日志里：

```
Downloading https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip
Info validating hash
Info extracting WIX
```

下载成功了，两个安装包都产出了。

**教训：curl 的失败不能推断"某站点不通"** —— 不同程序用的 TLS/代理栈不一样。
要用**目标程序自己**去试。这与项目一贯的"结论必须来自实测"是同一条道理。

---

## 七、还没做的

- **文件列表的桌面版能力**：真实路径、跨会话记住列表、目录懒加载（`fs.readDir`）
  —— 目前只有浏览器版（会话内列表 + 界面上的降级提示），
  这部分要加 Tauri 的 `dialog` / `fs` 权限与命令。
- 代码签名（未签名时 Windows 会弹"未知发布者"）
- 自动更新
- 文件关联（双击 pdf 用本应用打开）
