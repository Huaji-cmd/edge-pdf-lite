// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::Mutex;

// `get_webview_window` / `config()` 这些是 trait 方法，不 import 就调不到
// （编译器会提示 "trait Manager which provides ... is implemented but not in scope"）
use tauri::{Manager, State};

// `app.dialog()` 由这个扩展 trait 提供，不 import 连 `.file()` 都写不出来
use tauri_plugin_dialog::{DialogExt, FilePath};

/*
 * 关于下面这段"自愈"代码的来龙去脉 —— 这是用户实际踩到、且很难自己查的问题。
 *
 * **现象**：双击 exe 出来一个 WebView2 的错误页，上面一行乱码，看起来像白屏。
 *
 * **那行乱码是什么**：它是 WebView2 自己画的错误页文案，UTF-8 的中文被按 GBK
 * 显示就成了乱码。还原过来是「域名 tauri.localhost 可能已经被 DNS 污染…」——
 * 也就是说，**不是我们界面白屏，是 `http://tauri.localhost` 请求压根没被拦下来**。
 *
 * **为什么会这样**：Tauri 在 Windows 上把前端资源挂在 `http://tauri.localhost`
 * 这个虚拟主机上（靠 WebView2 的虚拟主机映射）。这个映射依赖 WebView2 的 profile
 * 状态正常。profile 一旦损坏/跨版本不兼容，映射就失效，请求会走到**真实网络**去解析
 * `tauri.localhost` → 必然失败 → 错误页。
 *
 * **修复**：把 profile 清掉重建。但 ⚠️ **不能连 `Default\Local Storage` 一起清** ——
 * 用户的文件列表和设置就存在那里（清掉等于让他重新添加一遍所有书）。
 *
 * **为什么以前没发现**：测试脚本每次都把整个数据目录挪走，永远从干净状态开始，
 * 所以这类"长期存在的 profile 出问题"根本测不到。是用户装了正式版才暴露的。
 */
/*
 * ⚠️ 改动**清理逻辑本身**时要把这个值 +1 —— 老用户（包括用过有 bug 的那一版的人）
 * 会被重新清一次，否则他们会停在"标记已写、但没真正清干净"的状态里出不来。
 */
const PROFILE_STAMP: &str = "2";

/**
 * 应用的数据根目录。
 *
 * 默认 `%LOCALAPPDATA%\<identifier>`；但如果 `WEBVIEW2_USER_DATA_FOLDER` 有值就用它。
 *
 * 为什么要认这个变量：它是 **WebView2 自己的**环境变量（实测有效：设了之后 profile
 * 真的搬到那个目录，真实那份一个字节都没动）。它指向的是"根"，profile 是它下面的
 * `EBWebView` —— 跟我们默认的布局完全一致。
 *
 * 🔴 关键点是**两边必须用同一个变量**。端到端测试要一份完全隔离的数据目录，
 *    否则"测自愈"这件事本身就会去清用户的真实 profile（这条真的踩过：测试脚本
 *    把整个 `%LOCALAPPDATA%\<identifier>` 搬来搬去，还原经常失败，用户的文件列表
 *    就这么没了）。让 WebView2 和我们的自愈/标记/白名单都从这一个变量取，
 *    就不可能出现"WebView2 用了沙箱、自愈却去动真实目录"这种错位。
 *
 * ⚠️ `dirs::data_local_dir()` 走的是 `SHGetKnownFolderPath`，**不读 LOCALAPPDATA
 *    环境变量** —— 所以想隔离只能靠这个变量，改 LOCALAPPDATA 是没用的（实测过）。
 */
fn data_root(identifier: &str) -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("WEBVIEW2_USER_DATA_FOLDER") {
        if !dir.trim().is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    std::env::var("LOCALAPPDATA")
        .ok()
        .map(|local| PathBuf::from(local).join(identifier))
}

/**
 * 「上次跑挂之后，隔多久才允许再自愈一次」。
 *
 * 目的是**防连环清**：如果清了也修不好（或者根因根本不是 profile），
 * 没有冷却就会变成"每次启动都把 profile 清一遍" —— 用户每次都得重新攒缓存。
 * 两分钟足够区分"又一次启动"和"刚清完立刻又失败"。
 */
const HEAL_COOLDOWN_SECS: u64 = 120;

/**
 * 前端挂载完成时报一声。
 *
 * 为什么需要它：**"这次启动成功了吗"只有界面自己知道**。
 * 白屏 = 我们的 JS 一次都没跑起来，所以只要这个命令被调到，就说明
 * 「虚拟主机映射、资源加载、CSP、IPC」这一整条链是通的。
 * `heal_webview_profile` 拿它当"上次启动是否正常"的判据（`.epl-ok` 比 `.epl-bad` 新）。
 *
 * ⚠️ 顺带把版本标记补齐：全新安装时 profile 目录还不存在，开机那次自愈会提前返回
 *    什么都不写 —— 由这里补上，第二次启动就不会再白清一遍。
 */
#[tauri::command]
fn app_ready(app: tauri::AppHandle) {
    let Some(root) = data_root(&app.config().identifier).map(|r| r.join("EBWebView")) else {
        return;
    };
    mark(&root.join(".epl-profile"), &format!(
        "{}|{}",
        PROFILE_STAMP,
        tauri::webview_version().unwrap_or_default()
    ));
    mark(&root.join(".epl-ok"), "ok");
}

/** 写（或刷新）一个小标记文件，顺带把父目录建出来 */
fn mark(path: &Path, text: &str) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, text);
}

/// 删掉一个路径（文件或目录都行）
fn rm_any(p: &Path) -> std::io::Result<()> {
    if p.is_dir() {
        std::fs::remove_dir_all(p)
    } else {
        std::fs::remove_file(p)
    }
}

/*
 * 检查并（必要时）重建 WebView2 的 profile。
 *
 * 什么时候重建：
 *   - 标记里的 **WebView2 运行时版本**变了（WebView2 自动升级后跨版本不兼容）
 *   - **PROFILE_STAMP** 变了（我们自己改了 profile 结构）
 *   - 以后要加"检测到加载失败"之类，也走这里
 *
 * ⚠️ 必须在 **setup 里**调用（窗口创建之前）—— 那时 WebView2 还没起来、目录没被锁；
 *    等窗口出来再删就会失败。
 *
 * ⚠️ **原地删，不动 `Default\Local Storage`** —— 用户的文件列表和设置就存在那儿。
 *    这里刻意**不做"先备份再整体重建"**：试过 rename 整个目录那套，
 *    但 profile 目录随时可能被别的进程（索引器 / 杀软）持有句柄，
 *    rename 一失败就得回滚，逻辑复杂还容易留下半成品。
 *    原地逐个删的好处是：**用户数据从头到尾没被移动过**，
 *    而且就算某些文件删不掉，也只是"这次没清干净"，下次启动接着清 —— 没有中间态。
 */
/**
 * 除了自己以外，还有别的 edge-pdf-lite 在跑吗？
 *
 * 🔴 **必须在真动手清 profile 之前问这一句。**
 *    自愈跑在 `Builder` 之前 —— 也就是**比单实例判断还早**：
 *    用户第二次双击时，这个进程已经先把自愈跑完了，然后才轮到单实例插件把它挡掉。
 *    要是那一轮正好命中"该自愈"，就会把**另一个正在运行的实例**的 profile 删掉一半
 *    （开着句柄的文件删不掉，于是清得七零八落）—— 把好的弄成坏的，
 *    正是我们要修的那个症状。
 *
 * ⚠️ 用 tasklist 是刻意的：这段只在**真要清之前**执行（很少见），
 *    为它引一套 Windows API 依赖不值得，那点进程启动开销无所谓。
 */
fn another_instance_running() -> bool {
    let me = std::process::id();
    let Ok(out) = std::process::Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq edge-pdf-lite.exe", "/NH", "/FO", "CSV"])
        .output()
    else {
        return false; // 查不了就当没有，别把自愈卡死
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| l.to_lowercase().contains("edge-pdf-lite.exe"))
        .filter_map(|l| l.split(',').nth(1))
        .filter_map(|s| s.trim().trim_matches('"').parse::<u32>().ok())
        .any(|pid| pid != me)
}

fn heal_webview_profile(identifier: &str) {
    let Some(root) = data_root(identifier).map(|r| r.join("EBWebView")) else {
        return;
    };
    if !root.is_dir() {
        // 全新安装：WebView2 还没建这个目录，没什么可修的
        // （标记由前端跑起来之后的 `app_ready` 补写，所以第二次启动不会再白清一遍）
        return;
    }

    let want = format!(
        "{}|{}",
        PROFILE_STAMP,
        tauri::webview_version().unwrap_or_default()
    );
    let stamp = root.join(".epl-profile");
    let stamp_ok = std::fs::read_to_string(&stamp)
        .map(|s| s.trim() == want)
        .unwrap_or(false);

    /*
     * 「上次那次启动，界面真的跑起来了吗？」
     *
     * 🔴 这是**唯一能覆盖未知原因**的判据。原来的写法只看"版本/结构有没有变"：
     *    profile 一旦因为别的原因坏掉（不是版本变化），标记照样匹配 →
     *    自愈**永远不再触发** → 用户就卡在"每次启动都白屏"里出不来
     *    （用户报的正是这个："第二次以后启动就变成了这样"）。
     *
     * 两个文件比时间戳，**不靠"这次启动去删上次的标记"**：
     *   · `.epl-bad`  `setup` 里先记一笔（"这次启动还没证明自己是好的"）
     *   · `.epl-ok`   前端跑起来后 `app_ready` 写（更新的 mtime 把它盖过去）
     * `bad` 更新 ⇒ 上次那次没跑到 ready ⇒ 该自愈。（两个标记都只有活下来的实例会写，
     * 详见 `setup` 与 `app_ready` 里的说明。）
     *
     * ⚠️ **这两个文件只有"活下来的那个实例"会写**：`app_ready` 在窗口出来之后，
     *    看门狗也在 `setup` 里 —— 那时候单实例插件早就把多余的实例干掉了。
     *    之前我写的是"启动时先乐观删掉标记"，结果第二个实例（马上要被杀掉的）
     *    也会把它删掉，害得**下一次启动误判成上次失败**。这个坑别踩回去。
     */
    let ok_marker = root.join(".epl-ok");
    let bad_marker = root.join(".epl-bad");
    let mtime = |p: &Path| -> Option<std::time::SystemTime> {
        std::fs::metadata(p).ok().and_then(|m| m.modified().ok())
    };
    let last_run_failed = match (mtime(&ok_marker), mtime(&bad_marker)) {
        (Some(ok), Some(bad)) => bad > ok, // 上次的结果以上述两个事件里更晚的那个为准
        (Some(_), None) => false,          // 只有 ok：上次是好的
        (None, Some(_)) => true,           // 只有 bad：上次是坏的
        (None, None) => false,             // 谁都没有：全新，或从没跑到过 ready（交给 stamp 那条判断）
    };

    if stamp_ok && !last_run_failed {
        return; // 常态：版本没变、上次也正常
    }
    if stamp_ok && last_run_failed {
        /*
         * 「上次跑挂了」这条**要带冷却**，否则会变成"每次启动都重建 profile"：
         * 清完还是坏（比如根因根本不是 profile）→ 下次又清 ……
         * 用标记文件的年龄当"上次清理是什么时候"—— 刚清过就先正常启动，别连环清。
         */
        let recent = std::fs::metadata(&stamp)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .map(|age| age.as_secs() < HEAL_COOLDOWN_SECS)
            .unwrap_or(false);
        if recent {
            return;
        }
    }

    // 真要动手了 —— 先确认没有别的实例正在用这个 profile（见 another_instance_running）
    if another_instance_running() {
        let _ = std::fs::write(
            std::env::temp_dir().join("epl-profile-heal.log"),
            "跳过：还有另一个实例在跑，不能删它正在用的 profile\n",
        );
        return;
    }

    let keep = root.join("Default").join("Local Storage");
    // 删不掉的东西记下来 —— 这一步失败会**直接导致白屏依旧**，
    // 而它发生在窗口出现之前，界面上完全看不出来，不记日志就没法查。
    let mut failed: Vec<String> = Vec::new();

    // ① 清 Default 下除 Local Storage 之外的一切
    match std::fs::read_dir(root.join("Default")) {
        Ok(rd) => {
            for e in rd.flatten() {
                let p = e.path();
                if p == keep {
                    continue;
                }
                if let Err(err) = rm_any(&p) {
                    failed.push(format!("{} ({})", p.display(), err));
                }
            }
        }
        Err(err) => failed.push(format!("读不了 Default/（{}）", err)),
    }

    // ② 清 root 下除 Default 之外的一切（顺带把旧的标记也清掉）
    match std::fs::read_dir(&root) {
        Ok(rd) => {
            for e in rd.flatten() {
                if e.file_name() == "Default" {
                    continue;
                }
                let p = e.path();
                if let Err(err) = rm_any(&p) {
                    failed.push(format!("{} ({})", p.display(), err));
                }
            }
        }
        Err(err) => failed.push(format!("读不了 profile 根目录（{}）", err)),
    }

    // ③ 写下标记：下次启动版本没变就直接跳过
    let _ = std::fs::create_dir_all(root.join("Default"));
    let _ = std::fs::write(&stamp, &want);

    let _ = std::fs::write(
        std::env::temp_dir().join("epl-profile-heal.log"),
        format!(
            "webview={}\nstamp={}\nfailed={}\n{}",
            tauri::webview_version().unwrap_or_default(),
            want,
            failed.len(),
            failed.join("\n")
        ),
    );
}

// ============================================================================
// 路径闸门
// ============================================================================
/*
 * ## 这层是干什么的
 *
 * 这个 App 会把 PDF 文件交给 pdf.js 解析，而**文件是别人给的**。也就是说
 * 它天生在"处理不可信输入"这条路上。
 *
 * 而下面的命令（`read_pdf_bytes` / `write_pdf_b64` / `list_dir` …）都能**直接
 * 读写磁盘**。它们本身没有错 —— 错的是"**只靠前端自觉**"：命令收什么路径就照做。
 * 于是「能在前端跑起一段 JS」就等价于「能读写这个用户能碰到的任意文件」。
 *
 * 现在并没有已知的 JS 注入路径（CSP 是严的、pdf.js 没开 enableScripting、
 * 前端没有 innerHTML/eval）。但"没有已知的送进来"和"送进来也走不远"是两回事：
 * 前者依赖"pdf.js 永远不出 XSS"这种不该依赖的东西，后者才是可验证的。
 *
 * ## 判据
 *
 * 只放行**用户亲手选过的位置**：
 *   · 用户点「添加文件」选的那几个文件   → 每条只放行它自己去（文件粒度）
 *   · 用户点「添加文件夹」选的目录       → 放行它以及它下面的一切（目录粒度）
 *   · 用户点「选择保存目录」选的目录     → 同上
 *   · 默认另存目录（文档库/edge-pdf-lite/save）→ 由 default_save_dir 自己登记
 *
 * ⚠️ **登记只发生在 Rust 侧**（见 `register_picked`）。这一条是整层设计的关键：
 *    如果反过来让前端调一个 `allow_path(任意路径)`，那这道闸门就形同虚设 ——
 *    拿到 JS 执行的人自己登记 `C:\Users\你\.ssh` 就绕过去了。
 *    所以文件选择必须由 Rust 弹窗、Rust 登记，前端只拿结果。
 *
 * ⚠️ 放行列表会**落盘**（`%LOCALAPPDATA%\<identifier>\allowed-paths.txt`），
 *    否则重启之后"上次打开的文件"和整个文件列表全都读不了 —— 那是功能退化，
 *    不是安全。落盘位置刻意放在 `EBWebView` **外面**：自愈会清 profile，
 *    但不该顺手把用户选过的路径一起清掉。
 */
const MAX_PDF_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/*
 * Markdown 的软上限：16 MiB。
 *
 * ⚠️ 与 PDF 的 2 GiB 是**不同性质的成本**：PDF 按页渲染，一次只碰一页；
 *    Markdown 要一次解析完、一次建完整个 DOM，16 MiB 纯文本在 8 GB 机器上
 *    已经是"十几万行"的规模了。这道闸门防的是"一个 500 MB 的日志被改名成 .md"，
 *    不是防合法长文 —— 前端还有一次同样的兜底（两处都要有：
 *    Rust 挡住真实路径，前端挡住拖进来的 File 对象）。
 */
const MAX_MD_BYTES: u64 = 16 * 1024 * 1024;

/// 单张本地图片的上限。图片是"引用"不是"文档"，但同样不能没边。
const MAX_ASSET_BYTES: u64 = 20 * 1024 * 1024;

/// 允许被访问的路径。判定规则统一是 `路径 == 条目 || 路径.starts_with(条目)`：
/// `starts_with` 是**按路径分量**比对的，所以"文件条目"天然只命中它自己
/// （`D:\a\b.pdf` 不可能是 `D:\a\b.pdf\…` 的前缀，那种路径不存在）。
struct Allowed {
    /// 会被落盘的那部分：只由对话框登记 + default_save_dir
    persisted: Mutex<Vec<PathBuf>>,
    /// `EPL_ALLOW_ROOTS` 给的（分号分隔）。**只对本次运行有效、不落盘** ——
    /// 留给端到端测试和"临时给某个目录开个口"用。JS 改不了环境变量，所以它不是后门。
    env: Vec<PathBuf>,
    /// 落盘位置；拿不到（没有 LOCALAPPDATA）就只在内存里活着
    store: Option<PathBuf>,
}

impl Allowed {
    fn load(store: Option<PathBuf>) -> Self {
        let mut persisted: Vec<PathBuf> = Vec::new();
        if let Some(f) = &store {
            if let Ok(text) = std::fs::read_to_string(f) {
                for line in text.lines() {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    let p = PathBuf::from(line);
                    // ⚠️ 只收绝对路径。相对路径没有意义，而且 `..` 这种
                    //    一旦进了列表就是"放行本级以上的任意东西"。
                    if !p.is_absolute() {
                        continue;
                    }
                    /*
                     * 统一成**规范化形式**再存。
                     *
                     * 老版本落盘的条目可能没带 `\\?\` 前缀，也可能写的是正斜杠；
                     * 而 `check()` 拿进来的一律是 `\\?\D:\…`。两边形式不一致时
                     * `starts_with` 永远不成立 —— 症状是"我明明选过这个目录，
                     * 它却说不在允许范围内"。这里解析不了（比如文件被删了）
                     * 就保留原样，至少不丢信息。
                     */
                    persisted.push(resolveish(&p).unwrap_or(p));
                }
            }
        }
        let env = std::env::var("EPL_ALLOW_ROOTS")
            .map(|raw| {
                raw.split(';')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .filter_map(|s| resolveish(Path::new(s)))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Self {
            persisted: Mutex::new(persisted),
            env,
            store,
        }
    }

    /// 登记一个路径（**只由对话框命令和 default_save_dir 调用**），并立刻落盘
    fn add(&self, path: PathBuf) {
        {
            let mut list = self.persisted.lock().unwrap_or_else(|e| e.into_inner());
            if list.iter().any(|e| *e == path) {
                return;
            }
            list.push(path);
        }
        self.save();
    }

    fn save(&self) {
        let Some(f) = &self.store else { return };
        let text = {
            let list = self.persisted.lock().unwrap_or_else(|e| e.into_inner());
            let mut t = String::new();
            for e in list.iter() {
                t.push_str(&e.to_string_lossy());
                t.push('\n');
            }
            t
        };
        if let Some(dir) = f.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // 写坏了也只是"少几条"，下次 add 会补回来 —— 失败方向是保守的，不用原子写
        let _ = std::fs::write(f, text);
    }

    fn hit(&self, want: &Path) -> bool {
        let list = self.persisted.lock().unwrap_or_else(|e| e.into_inner());
        list.iter()
            .chain(self.env.iter())
            .any(|e| want == e.as_path() || want.starts_with(e))
    }

    /// 把前端给的路径解析成真实路径，并确认它在放行范围内。
    /// **任何一步不成立都返回错误** —— 失败一律拒绝，不放行。
    fn check(&self, path: &str) -> Result<PathBuf, String> {
        let want = resolveish(Path::new(path))
            .ok_or_else(|| format!("路径不可用（要么不存在，要么不是绝对路径）：{}", path))?;
        if self.hit(&want) {
            return Ok(want);
        }
        Err(format!(
            "拒绝访问：{} 不在允许范围内。\n\
             只允许用户通过「添加文件 / 添加文件夹 / 选择保存目录」亲手选过的位置。",
            display_path(&want)
        ))
    }
}

/// 解析成"真实路径"（软链接展开、`..` 归一、大小写统一成实际磁盘上的写法）。
///
/// ⚠️ 目标**还不存在**时（另存一份新文件）`canonicalize()` 会整个失败 ——
///    所以退一步：规范化**父目录**再拼回文件名。
///    这顺带堵住了"用一串不存在的目录名把路径挪到别处"：
///    父目录必须真实存在，`check` 才有意义。
fn resolveish(p: &Path) -> Option<PathBuf> {
    if let Ok(c) = p.canonicalize() {
        return Some(c);
    }
    let name = p.file_name()?;
    let parent = p.parent()?;
    if parent.as_os_str().is_empty() {
        // 相对路径（没有父目录可规范化）—— 一律不收
        return None;
    }
    Some(parent.canonicalize().ok()?.join(name))
}

/// 给人看的路径：把 Windows 的**扩展长度前缀** `\\?\` 去掉。
///
/// 为什么要有它：`resolveish()` 走 `canonicalize()`，Windows 上返回的一律是
/// `\\?\D:\…`。这个前缀对 `std::fs` 无害（写/读都正常），但它会**漏到界面上** ——
/// 设置里显示成 `\\?\D:\some\dir`，用户第一反应是"路径坏了"。
/// 而且 `explorer /select,` **不认**这个前缀。
///
/// ⚠️ 只用于"显示 / 存设置 / 交给 explorer"。**白名单比对仍用规范化形式**
///    （`check()` 会再 resolveish 一次，所以拿干净路径回来也能过闸门）。
///
/// ⚠️ UNC 是 `\\?\UNC\server\share\…`，去掉前缀要还原成 `\\server\share\…`；
///    `\\?\Volume{…}` 这种卷 GUID 路径保持原样（去掉前缀就不是同一个东西了）。
fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy().into_owned();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{}", rest);
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        let b = rest.as_bytes();
        // 只认盘符形式：`C:\…`
        if b.len() >= 3 && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/') {
            return rest.to_string();
        }
    }
    s
}

/// 只收 `.pdf`。这是 PDF 阅读器，别的文件没有理由走到这几个命令上。
fn ensure_pdf_ext(p: &Path) -> Result<(), String> {    let ok = p
        .extension()
        .map(|e| e.to_string_lossy().eq_ignore_ascii_case("pdf"))
        .unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err(format!("只处理 .pdf 文件：{}", p.display()))
    }
}

/// 单个文件的大小上限。
///
/// ⚠️ 这道闸门的**唯一目的是"别被一个离谱的输入拖死"**，不是"防合法大文件"：
///    它挡住的是"一个 30 GB 的东西被改名成 .pdf"这种 —— 没有它，命令会一头
///    扎进去读，界面看起来就是卡死，还不报错。
///    2 GiB 是刻意放很宽的（用户确实有几百 MB 的书）。
fn ensure_size(len: u64) -> Result<(), String> {
    if len <= MAX_PDF_BYTES {
        Ok(())
    } else {
        Err(format!(
            "文件太大（{} GB），上限是 {} GB",
            len / (1 << 30),
            MAX_PDF_BYTES / (1 << 30)
        ))
    }
}

/// 是不是 Markdown（`.md` / `.markdown`，大小写不敏感）。
fn is_markdown_path(p: &Path) -> bool {
    p.extension()
        .map(|e| {
            let e = e.to_string_lossy();
            e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown")
        })
        .unwrap_or(false)
}

/// 只收本应用能读的文档：`.pdf` / `.md` / `.markdown`。
///
/// ⚠️ 这条闸门的目的是**别让读取命令变成"通用读文件"**：光有路径放行还不够 ——
///    用户随手把一个目录加进列表，不应该意味着那个目录里的 `.env` / `.ssh` 也能读。
///    写入仍然只走 `ensure_pdf_ext`（批注只写回 PDF，Markdown 是只读的）。
fn ensure_doc_ext(p: &Path) -> Result<(), String> {
    let is_pdf = p
        .extension()
        .map(|e| e.to_string_lossy().eq_ignore_ascii_case("pdf"))
        .unwrap_or(false);
    if is_pdf || is_markdown_path(p) {
        Ok(())
    } else {
        Err(format!(
            "只处理 .pdf / .md / .markdown 文件：{}",
            p.display()
        ))
    }
}

/// 按类型取大小上限：PDF 2 GiB，Markdown 16 MiB。
fn ensure_doc_size(p: &Path, len: u64) -> Result<(), String> {
    let max = if is_markdown_path(p) {
        MAX_MD_BYTES
    } else {
        MAX_PDF_BYTES
    };
    if len <= max {
        return Ok(());
    }
    let (shown, unit) = if max >= 1 << 30 {
        (max / (1 << 30), "GB")
    } else {
        (max / (1 << 20), "MB")
    };
    Err(format!(
        "文件太大（{} MB），{} 的上限是 {} {}{}",
        len / (1 << 20),
        if is_markdown_path(p) { "Markdown" } else { "PDF" },
        shown,
        unit,
        if is_markdown_path(p) {
            "。这类文件要一次性解析完，太大在低配机上会卡住界面"
        } else {
            ""
        }
    ))
}

/// 本地图片只允许常见位图。**SVG 不支持** —— 它是可执行文档（能带脚本），
/// 而这条命令的定位是"读一张图"，不该顺手把脚本能力引进来。
fn ensure_image_ext(p: &Path) -> Result<(), String> {
    let ok = p
        .extension()
        .map(|e| {
            let e = e.to_string_lossy().to_ascii_lowercase();
            matches!(e.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp")
        })
        .unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err(format!(
            "只支持 png / jpg / jpeg / gif / webp / bmp 图片：{}",
            p.display()
        ))
    }
}


/// 把对话框返回的路径**在 Rust 侧**登记进白名单，再把字符串回给前端。
/// 🔴 登记必须发生在这里，理由见本节开头的说明（前端不能有登记能力）。
fn register_picked(picked: Vec<FilePath>, allowed: &Allowed) -> Vec<String> {
    let mut out = Vec::new();
    for f in picked {
        let Ok(p) = f.into_path() else { continue };
        let Some(real) = resolveish(&p) else { continue };
        // 白名单里存**规范化形式**（`\\?\…`），但返回给前端的必须是**干净路径** ——
        // 这个值会进 localStorage、显示在设置面板、拼成保存路径。
        // 把 `\\?\` 漏出去过一次，用户直接问"为什么前面有这个"。
        let shown = display_path(&real);
        allowed.add(real);
        out.push(shown);
    }
    out
}

/// 弹系统对话框选文档（PDF / Markdown，可多选）。返回**已经登记过的**真实路径。
#[tauri::command]
async fn pick_documents(
    app: tauri::AppHandle,
    allowed: State<'_, Allowed>,
) -> Result<Vec<String>, String> {
    let mut dlg = app
        .dialog()
        .file()
        .set_title("选择 PDF / Markdown")
        .add_filter("文档（PDF / Markdown）", &["pdf", "md", "markdown"])
        .add_filter("PDF", &["pdf"])
        .add_filter("Markdown", &["md", "markdown"]);
    // 带上父窗口才是"模态于主窗口"的对话框（不加会跑到窗口后面去，像没反应）
    #[cfg(desktop)]
    if let Some(win) = app.get_webview_window("main") {
        dlg = dlg.set_parent(&win);
    }
    Ok(register_picked(
        dlg.blocking_pick_files().unwrap_or_default(),
        &allowed,
    ))
}

/// 弹系统对话框选文件夹（单选）。返回一个元素的数组（没选就是空数组）。
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle, allowed: State<'_, Allowed>) -> Result<Vec<String>, String> {
    let mut dlg = app.dialog().file().set_title("选择文件夹");
    #[cfg(desktop)]
    if let Some(win) = app.get_webview_window("main") {
        dlg = dlg.set_parent(&win);
    }
    let picked: Vec<FilePath> = dlg.blocking_pick_folder().into_iter().collect();
    Ok(register_picked(picked, &allowed))
}

/// 目录里的一项（前端文件树用）
#[derive(serde::Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

/*
 * 读**一层**目录。
 *
 * ⚠️ 刻意不递归：前端是"点开箭头才调一次"，这样即使用户误加了一个
 *    几万文件的目录，也只会扫它点开的那一级 —— 这个项目是给低配机做的，
 *    "一次性干大批活"是这类机器最痛的地方（M0 实验已经证明过）。
 *
 * 只返回子目录和本应用能读的文档（.pdf / .md / .markdown），其他文件一律过滤掉 ——
 * 混进一堆 docx / 图片只会让列表变噪音。类型判断必须与前端 `documentKind.ts`
 * **完全一致**，否则会出现"能打开但列表里看不见"。
 */
#[tauri::command]
fn list_dir(allowed: State<Allowed>, path: String) -> Result<Vec<DirEntry>, String> {
    // 闸门：只允许扫用户选过的目录（或其子目录）
    allowed.check(&path)?;

    let mut out: Vec<DirEntry> = Vec::new();

    let entries = std::fs::read_dir(&path).map_err(|e| format!("读不了目录 {}: {}", path, e))?;
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            // 单个条目读失败（权限/损坏）不该让整个目录失败 —— 跳过即可
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        // 隐藏文件（.git / .DS_Store 之类）直接跳过
        if name.starts_with('.') {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let lower = name.to_lowercase();
        let is_doc = lower.ends_with(".pdf")
            || lower.ends_with(".md")
            || lower.ends_with(".markdown");
        if !is_dir && !is_doc {
            continue;
        }
        // ⚠️ 这里也要去掉 `\\?\`：`path` 会进文件列表的 localStorage、
        //    显示在右键菜单和标题上。带前缀的话用户看到的是一堆 `\\?\D:\…`。
        //    （闸门那边不受影响：`check()` 会再规范化一次。）
        let full = display_path(&entry.path());
        out.push(DirEntry {
            name,
            path: full,
            is_dir,
        });
    }

    // 文件夹排前面，同类型按名字排（跟文件管理器一致，用户有预期）
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// 整个 PDF 的字节 —— 前端拿到交给 pdf.js。
///
/// 🔴 返回 `tauri::ipc::Response`（**原始字节**），不要改回 `Vec<u8>`：
///    `Vec<u8>` 会被 Tauri 按 JSON 序列化成**数字数组**（`[37,80,68,70,…]`），
///    前端再 `JSON.parse` 回一个 JS 数组。一份 98 MB 的 PDF 实测：
///    **webview 的 JS 堆从 10 MB 涨到 1638 MB**（约 17 倍文件大小）——
///    在 8 GB 的机器上打开就明显卡、开始换页。走 Response 是二进制直传，
///    堆上只多一份和文件等大的 ArrayBuffer。
///    （前端 `readBytesByPath` 拿到的是 `ArrayBuffer`，两种形态都兼容。）
#[tauri::command]
fn read_pdf_bytes(allowed: State<Allowed>, path: String) -> Result<tauri::ipc::Response, String> {
    // 闸门 ①：路径必须在这一层放行范围内
    allowed.check(&path)?;
    let p = Path::new(&path);
    // 闸门 ②：只收 .pdf —— 光有路径放行还不够，别让它变成"通用读文件"
    ensure_pdf_ext(p)?;
    // 闸门 ③：大小。先 stat 再 read，别为了拒绝一个 30 GB 的东西先把它读进内存
    let len = std::fs::metadata(p)
        .map_err(|e| format!("读不了 {}: {}", path, e))?
        .len();
    ensure_size(len)?;
    let bytes = std::fs::read(p).map_err(|e| format!("读不了 {}: {}", path, e))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 读一份文档的字节（PDF / Markdown 都走这条）。
///
/// 为什么不干脆让 `read_pdf_bytes` 也收 md：那条命令的存在意义就是"只读 PDF"，
/// 端到端测试还在用它做**阴性对照**（"放行目录里的非 .pdf 读不出来"）。
/// 把它放宽，等于把那条判据偷偷删掉。所以两条命令各守一段：
/// · `read_pdf_bytes` —— 只 pdf（旧链路、旧判据、批注保存前的原文件读取）
/// · `read_doc_bytes` —— pdf / md / markdown（新的统一入口）
///
/// 三道闸门与 `read_pdf_bytes` 完全一致：白名单 → 扩展名 → 大小（先 stat 再 read）。
#[tauri::command]
fn read_doc_bytes(allowed: State<Allowed>, path: String) -> Result<tauri::ipc::Response, String> {
    allowed.check(&path)?;
    let p = Path::new(&path);
    ensure_doc_ext(p)?;
    let len = std::fs::metadata(p)
        .map_err(|e| format!("读不了 {}: {}", path, e))?
        .len();
    ensure_doc_size(p, len)?;
    let bytes = std::fs::read(p).map_err(|e| format!("读不了 {}: {}", path, e))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/*
 * 把「文档目录 + 相对路径」解析成真实路径，并确认它**没有跳出文档目录**。
 *
 * 抽成独立函数有两个理由：
 *   ① `read_doc_asset` 里那一段是本期**最高风险**的代码（它决定前端能读哪些文件），
 *      单独出来才能写单元测试；
 *   ② 这里是"只接受相对路径"的**结构保证**：逐分量解析，`..` / 盘符 / 根
 *      在类型层面就进不来，不靠字符串里有没有 `..` 这种易漏的判断。
 *
 * 注意 canonicalize 之后再比一次 `starts_with`：软链接、`sub/../..`、
 * 大小写差异都会被这一步吃掉，是防越界的最后一道。
 */
fn resolve_asset(doc_dir: &Path, rel_path: &str) -> Result<PathBuf, String> {
    let raw = rel_path.replace('\\', "/");
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("图片路径是空的".to_string());
    }
    if raw.starts_with('/') || raw.starts_with('~') {
        return Err("只支持文档目录内的相对图片路径".to_string());
    }
    let mut rel = PathBuf::new();
    for comp in Path::new(raw).components() {
        match comp {
            std::path::Component::Normal(c) => rel.push(c),
            std::path::Component::CurDir => {}
            // `..`、盘符（Prefix）、根（RootDir）—— 一律拒绝
            _ => return Err("图片路径不能跳出文档所在目录".to_string()),
        }
    }
    if rel.as_os_str().is_empty() {
        return Err("图片路径是空的".to_string());
    }

    let candidate = doc_dir.join(&rel);
    let real = candidate
        .canonicalize()
        .map_err(|_| format!("找不到这张图片：{}", rel.display()))?;
    let root = doc_dir
        .canonicalize()
        .map_err(|e| format!("取不到文档目录：{}", e))?;
    if !real.starts_with(&root) {
        return Err("图片路径不能跳出文档所在目录".to_string());
    }
    Ok(real)
}

/*
 * 读一份 Markdown 引用的**本地图片**。
 *
 * 🔴 这是本期新增的**最高风险**命令：它让前端能按"相对路径"读磁盘上的文件。
 *    必须同时满足下面全部条件才放行 —— 缺任何一条，它就变成"按文档路径
 *    构造任意文件读取"的洞：
 *      ① `doc_path` 在白名单里，且确实是 .md / .markdown；
 *      ② `rel_path` **只能是相对路径**（逻辑在 `resolve_asset` 里，有单元测试）；
 *      ③ 解析出来的真实路径（canonicalize 展开软链接、吃掉 `..`）必须
 *         **仍在文档所在目录之内**；
 *      ④ 只允许常见位图扩展名（SVG 不支持，它能带脚本）；
 *      ⑤ 单图 20 MiB 上限，先 stat 再 read。
 *
 * ⚠️ 返回 `tauri::ipc::Response` 的理由同 `read_pdf_bytes`（二进制直传）。
 */
#[tauri::command]
fn read_doc_asset(
    allowed: State<Allowed>,
    doc_path: String,
    rel_path: String,
) -> Result<tauri::ipc::Response, String> {
    // ① 文档本身必须在白名单里
    let doc = allowed.check(&doc_path)?;
    if !is_markdown_path(&doc) {
        return Err("只有 Markdown 文档可以引用本地图片".to_string());
    }
    let doc_dir = doc
        .parent()
        .ok_or_else(|| "取不到文档所在目录".to_string())?;

    // ②③ 相对路径 + 目录包含校验
    let real = resolve_asset(doc_dir, &rel_path)?;

    // ④ 扩展名白名单
    ensure_image_ext(&real)?;

    // ⑤ 大小
    let len = std::fs::metadata(&real)
        .map_err(|e| format!("读不了图片 {}: {}", rel_path, e))?
        .len();
    if len > MAX_ASSET_BYTES {
        return Err(format!(
            "图片太大（{} MB），上限是 {} MB：{}",
            len / (1 << 20),
            MAX_ASSET_BYTES / (1 << 20),
            rel_path
        ));
    }
    let bytes = std::fs::read(&real).map_err(|e| format!("读不了图片 {}: {}", rel_path, e))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/*
 * 会话级"图片白名单"：允许显示**笔记文件夹之外**的图片（Typora 绝对路径场景）。
 *
 * ## 它怎么同时解决可用性和安全性
 * 可用性：Typora 等编辑器默认往笔记里写绝对路径，一概拒绝等于这类笔记永远看不到图。
 * 安全性：路径来自笔记内容（不可信），所以放行必须过三道关：
 *   ① **弹窗列出完整路径清单**，用户亲眼看过、亲手点"允许" ——
 *      沿用本文件开头"登记只能在 Rust 侧、前端不能有登记能力"的哲学；
 *   ② 每个路径过**扩展名 + 大小 + 存在性**校验，清单里存的是**文件本身**（精确匹配），
 *      不是它们的文件夹 —— 授权一张图不会顺带放开整个目录；
 *   ③ **仅本次运行有效**：不落盘、重启即清空。想长期用？把图片挪进笔记文件夹用相对路径。
 *
 * ⚠️ 前端没有直接登记能力 —— `allow_image_paths` 只做"校验 + 登记"，
 *    弹窗是不是真弹过它管不着，但弹窗组件在我们的前端里，绕过它的唯一方式
 *    是先攻破前端 —— 和路径闸门同一威胁模型，可接受。
 */
#[derive(Default)]
struct ImageAllowed {
    list: Mutex<Vec<PathBuf>>,
}

impl ImageAllowed {
    /// 精确匹配（清单里存的是文件，不是目录 —— starts_with 对文件条目天然只命中自己）
    fn check(&self, path: &Path) -> Result<PathBuf, String> {
        let real = resolveish(path)
            .ok_or_else(|| format!("找不到这张图片：{}", path.display()))?;
        let list = self.list.lock().unwrap_or_else(|p| p.into_inner());
        if list.iter().any(|p| p == &real) {
            Ok(real)
        } else {
            Err(format!(
                "这张图片不在本次允许显示的清单里：{}（清单只在弹窗授权后建立）",
                path.display()
            ))
        }
    }
}

/// 弹窗"允许"后登记图片。只做校验 + 登记，读文件走 `read_absolute_image`。
/// 授权结果：**部分成功**语义。真实笔记里死图很常见（截图被删/挪走了），
/// 一张失败就否决整批 = 全部不显示（真实用户就是这么踩的）。
/// 所以：能过的授权，过不了的进 `failed`（占位上会写明原因）。
#[derive(serde::Serialize)]
struct FailedImage {
    path: String,
    reason: String,
}

#[derive(serde::Serialize)]
struct ImageAllowResult {
    authorized: Vec<String>,
    failed: Vec<FailedImage>,
}

#[tauri::command]
fn allow_image_paths(
    image_allowed: State<ImageAllowed>,
    paths: Vec<String>,
) -> Result<ImageAllowResult, String> {
    if paths.is_empty() {
        return Err("没有要授权的图片".to_string());
    }
    if paths.len() > 500 {
        return Err("一次最多授权 500 张图片".to_string());
    }
    let mut authorized: Vec<String> = Vec::new();
    let mut failed: Vec<FailedImage> = Vec::new();
    for t in &paths {
        let t = t.trim();
        if t.is_empty() {
            continue;
        }
        // 单条失败只记原因，不否决整批 —— "清单上限"这种全局性问题才返回 Err
        if t.len() > 1024 {
            failed.push(FailedImage {
                path: t.to_string(),
                reason: "路径过长，已拒绝".to_string(),
            });
            continue;
        }
        if t.chars().any(|c| c.is_control()) {
            failed.push(FailedImage {
                path: t.to_string(),
                reason: "路径里含控制字符，已拒绝".to_string(),
            });
            continue;
        }
        let real = match PathBuf::from(t).canonicalize() {
            Ok(p) => p,
            Err(_) => {
                failed.push(FailedImage {
                    path: t.to_string(),
                    reason: "找不到这张图片（文件可能已被删除或挪走）".to_string(),
                });
                continue;
            }
        };
        if let Err(e) = ensure_image_ext(&real) {
            failed.push(FailedImage {
                path: t.to_string(),
                reason: e,
            });
            continue;
        }
        let len = match std::fs::metadata(&real) {
            Ok(m) => m.len(),
            Err(e) => {
                failed.push(FailedImage {
                    path: t.to_string(),
                    reason: format!("读不了图片：{}", e),
                });
                continue;
            }
        };
        if len > MAX_ASSET_BYTES {
            failed.push(FailedImage {
                path: t.to_string(),
                reason: format!(
                    "图片太大（{} MB），上限是 {} MB",
                    len / (1 << 20),
                    MAX_ASSET_BYTES / (1 << 20)
                ),
            });
            continue;
        }
        let mut list = image_allowed.list.lock().unwrap_or_else(|p| p.into_inner());
        if list.len() >= 2000 {
            return Err("已授权的图片太多，请把图片挪进笔记文件夹用相对路径".to_string());
        }
        if !list.contains(&real) {
            list.push(real.clone());
        }
        authorized.push(display_path(&real));
    }
    Ok(ImageAllowResult { authorized, failed })
}

/// 读一张**已授权**的笔记外图片。清单是会话级的，重启即清空。
#[tauri::command]
fn read_absolute_image(
    image_allowed: State<ImageAllowed>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let real = image_allowed.check(Path::new(&path))?;
    ensure_image_ext(&real)?;
    let len = std::fs::metadata(&real)
        .map_err(|e| format!("读不了 {}: {}", path, e))?
        .len();
    if len > MAX_ASSET_BYTES {
        return Err(format!(
            "图片太大（{} MB），上限是 {} MB：{}",
            len / (1 << 20),
            MAX_ASSET_BYTES / (1 << 20),
            path
        ));
    }
    let bytes = std::fs::read(&real).map_err(|e| format!("读不了 {}: {}", path, e))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/*
 * 用系统默认程序打开一个**外部链接**。
 *
 * 🔴 为什么不直接在页面里 `<a target="_blank">`：WebView2 会按它自己的窗口策略
 *    弹一个没有任何配置的子窗口（或者干脆什么都不做），这两种表现都不可控。
 *    统一交给系统浏览器是唯一"用户预期内"的行为。
 *
 * 🔴 协议白名单写在 Rust 侧，**前端说了不算**：只允许 http / https / mailto，
 *    其余（file: / javascript: / data: / 自定义协议）直接拒绝。
 *    参数用 `Command::arg()` 逐个传，**不过 shell**，所以没有引号拼接注入的问题。
 */
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let u = url.trim();
    if u.is_empty() {
        return Err("链接是空的".to_string());
    }
    if u.len() > 4096 {
        return Err("链接太长，已拒绝".to_string());
    }
    if u.chars().any(|c| c.is_control()) {
        return Err("链接里含有控制字符，已拒绝".to_string());
    }
    let lower = u.to_ascii_lowercase();
    let ok = lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:");
    if !ok {
        return Err("只允许打开 http / https / mailto 链接".to_string());
    }

    #[cfg(windows)]
    fn spawn_url(u: &str) -> std::io::Result<std::process::Child> {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("rundll32.exe")
            // CREATE_NO_WINDOW：别为了开个链接闪一下黑框
            .creation_flags(0x0800_0000)
            .arg("url.dll,FileProtocolHandler")
            .arg(u)
            .spawn()
    }
    #[cfg(target_os = "macos")]
    fn spawn_url(u: &str) -> std::io::Result<std::process::Child> {
        std::process::Command::new("open").arg(u).spawn()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    fn spawn_url(u: &str) -> std::io::Result<std::process::Child> {
        std::process::Command::new("xdg-open").arg(u).spawn()
    }

    spawn_url(u)
        .map(|_| ())
        .map_err(|e| format!("打不开链接：{}", e))
}

/*
 * ---------------------------------------------------------------- Markdown → PDF（应用内转换）
 *
 * 方案 B（产品决策见 docs/M15）：**不引入 Pandoc / 排版引擎** ——
 * 前端把渲染好的打印 HTML 交上来，这里用**系统自带的 Microsoft Edge 无头打印**
 * 出 PDF。Edge 在装了 WebView2 的机器上几乎必在；输出是矢量文本，
 * 可选中、可批注 —— 这正是"转 PDF"的唯一目的。
 */

/// 在惯常位置找 msedge.exe。找不到返回 None（前端会给出明确的替代指引）。
fn find_edge() -> Option<PathBuf> {
    for p in [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ] {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// 真正的打印：同步、阻塞。调用方负责放进 blocking 线程。
///
/// 🔴 `--user-data-dir` 指到**独立临时目录**是必须的：不加的话，用户正开着
///    Edge 浏览器时，这个调用会把 URL 丢给**现有实例**然后立即退出 ——
///    表现是"转换秒回但 PDF 没生成"。
///
/// 🔴 失败时错误信息必须带 **Edge 的 stderr**：headless 打印失败（退出码 0
///    但没产物）光看退出码什么都查不出来，Chromium 自己会在 stderr 上
///    说"为什么"（`--enable-logging=stderr`）。
fn run_print_to_pdf(edge: &Path, html_path: &Path, pdf_path: &Path, profile_dir: &Path) -> Result<(), String> {
    let url = tauri::Url::from_file_path(html_path)
        .map_err(|_| format!("临时文件路径不合法：{}", html_path.display()))?
        .to_string();

    let mut cmd = std::process::Command::new(edge);
    // 🔴 开关必须用 `--switch=value` 等号形式：写成两个独立参数时 Chromium 会把
    //    路径当**位置参数**（第二个 URL）吞掉，输出根本不写 —— 实测退出码 13。
    cmd.args([
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--disable-extensions",
        "--disable-crash-reporter",
        "--no-pdf-header-footer",
        "--enable-logging=stderr",
        "--v=0",
    ])
    .arg(format!("--print-to-pdf={}", pdf_path.display()))
    .arg(&url)
    .arg(format!("--user-data-dir={}", profile_dir.display()))
    // stderr 收进管道，另起线程读 —— 管道不读会把子进程写满卡死
    .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 Edge 打印失败：{}", e))?;

    // 后台线程收 stderr（Chromium 的诊断都在这里）
    let mut stderr_buf = String::new();
    let stderr_reader = child.stderr.take().map(|mut s| {
        std::thread::spawn(move || {
            use std::io::Read;
            let mut tmp = [0u8; 4096];
            loop {
                match s.read(&mut tmp) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if stderr_buf.len() < 16 * 1024 {
                            stderr_buf.push_str(&String::from_utf8_lossy(&tmp[..n]));
                        }
                    }
                }
            }
            stderr_buf
        })
    });

    // 等待退出但带超时（wait 会永久挂起；try_wait 轮询 + 到点 kill）
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
    let status = loop {
        if let Some(s) = child.try_wait().map_err(|e| format!("等待 Edge 失败：{}", e))? {
            break s;
        }
        if std::time::Instant::now() > deadline {
            // 🔴 kill 主进程不够 —— Edge 是多进程，杀整棵树（否则残留子进程
            //    锁着 profile，之后所有转换都会被"转发后秒退"）
            let pid = child.id();
            let _ = child.kill();
            let _ = child.wait();
            {
                use std::os::windows::process::CommandExt;
                let _ = std::process::Command::new("taskkill")
                    .args(["/T", "/F", "/PID", &pid.to_string()])
                    .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                    .spawn();
            }
            return Err("转换超时（120 秒）：文档太大或 Edge 失去响应".to_string());
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    };

    let stderr_tail = stderr_reader
        .and_then(|h| h.join().ok())
        .unwrap_or_default();
    let diag = || -> String {
        let interesting = |l: &str| {
            let lo = l.to_ascii_lowercase();
            ["error", "failed", "print", "pdf", "crash", "reject"]
                .iter()
                .any(|k| lo.contains(k))
        };
        let tail: Vec<&str> = stderr_tail.lines().filter(|l| interesting(l)).collect();
        let out = if tail.is_empty() {
            stderr_tail.lines().rev().take(3).collect::<Vec<_>>().join(" | ")
        } else {
            tail.join(" | ")
        };
        out[..out.len().min(400)].to_string()
    };

    if !pdf_path.is_file() {
        let d = diag();
        return Err(format!(
            "Edge 没有生成 PDF（退出码 {:?}，输出：{}）。临时文件 {} 保留着，可反馈排查",
            status.code(),
            if d.is_empty() { "无日志" } else { &d[..d.len().min(400)] },
            html_path.display(),
        ));
    }
    let len = std::fs::metadata(pdf_path).map_err(|e| e.to_string())?.len();
    if len == 0 {
        return Err("生成的 PDF 是空的，请重试一次".to_string());
    }
    Ok(())
}

/**
 * 应用内把 Markdown 转成 PDF。
 *
 * 流程：前端组装好**自包含**的打印 HTML（公式/高亮已静态化、字体已内嵌）→
 * 这里弹**保存对话框**（Rust 侧，沿用"对话框和登记都不在前端"的闸门模式）→
 * 写 %TEMP% 临时文件 → Edge 无头打印 → 校验产物 → 删临时文件 → 登记输出路径
 * （转出来的 PDF 用户是亲手选的位置，登记后能直接在应用里打开批注）。
 *
 * 安全边界：HTML 是前端从**净化后的** doc.html 组装的；临时文件落在
 * %TEMP% 且用完即删；输出路径只来自保存对话框 —— 前端给不了任意写盘能力。
 */
#[tauri::command]
async fn convert_md_to_pdf(
    app: tauri::AppHandle,
    allowed: State<'_, Allowed>,
    html: String,
) -> Result<String, String> {
    // ① 内容闸门：非空 + 大小上限（内嵌 KaTeX 字体的文档会有 1-2 MB，上限放宽到 32 MB）
    let html = html.trim().to_string();
    if html.is_empty() {
        return Err("没有可转换的内容".to_string());
    }
    if html.len() > 32 * 1024 * 1024 {
        return Err("转换内容太大，请精简文档后重试".to_string());
    }

    // ② 保存对话框（Rust 侧模态，用户亲手选输出位置）
    let mut dlg = app
        .dialog()
        .file()
        .set_title("把 Markdown 转成 PDF")
        .add_filter("PDF", &["pdf"]);
    #[cfg(desktop)]
    if let Some(win) = app.get_webview_window("main") {
        dlg = dlg.set_parent(&win);
    }
    let Some(out) = dlg.blocking_save_file() else {
        return Err("__cancelled__".to_string()); // 用户取消：不算错误，前端静默处理
    };
    let mut out_path = out.into_path().map_err(|e| e.to_string())?;
    // 补后缀（用户手输名字漏了 .pdf 时别生成一个没有后缀的文件）
    if out_path.extension().map(|e| e.to_ascii_lowercase()) != Some("pdf".into()) {
        out_path.set_extension("pdf");
    }

    // ③ 边打印边登记：输出路径是用户亲手选的，登记符合路径闸门哲学
    let real_out = resolveish(&out_path).ok_or("输出路径无法解析")?;
    allowed.add(real_out.clone());
    let shown_out = display_path(&real_out);

    // ④ 临时 HTML（%TEMP%）+ **每次独立**的 Edge profile 目录
    //    🔴 profile 固定路径是"第一次失败后全失败"的温床：一次残留锁，
    //    之后所有转换都被转发给残留实例秒退。独立目录 + 用完即删，状态不跨转换。
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let temp_html = std::env::temp_dir().join(format!("epl-print-{}-{}.html", std::process::id(), stamp));
    let profile_dir = std::env::temp_dir().join(format!("epl-edge-prof-{}-{}", std::process::id(), stamp));
    std::fs::write(&temp_html, html.as_bytes())
        .map_err(|e| format!("写临时文件失败：{}", e))?;

    // ⑤ 打印（放 blocking 线程，别把 async 运行时挂住）
    let edge = find_edge().ok_or_else(|| {
        "没找到 Microsoft Edge（转换需要它做打印引擎）。请确认系统装有 Edge，或继续用外部工具（Typora / Pandoc）转 PDF".to_string()
    })?;
    let edge2 = edge.clone();
    let th = temp_html.clone();
    let out2 = real_out.clone();
    let prof2 = profile_dir.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_print_to_pdf(&edge2, &th, &out2, &prof2)
    })
    .await
    .map_err(|e| format!("转换任务失败：{}", e))?;

    // ⑥ 临时文件用完即删（profile 里可能有几百个缓存小文件；删不掉也不影响结果）
    let _ = std::fs::remove_file(&temp_html);
    let _ = std::fs::remove_dir_all(&profile_dir);

    result?;
    Ok(shown_out)
}

/*
 * 读一份**系统中文字体**，给「把中文写进 PDF」用。
 *
 * 为什么需要它：PDF 的标准 14 字体里**没有 CJK 字形**，硬写中文要么是乱码，
 * 要么是查看器里一片空白/灰条。唯一可靠的做法是**嵌入字体**（子集化之后
 * 一份 PDF 只多几十 KB），而嵌入总得先有字体字节。
 *
 * 🔴 **不能**把字体打进安装包：完整中文字体 10 MB 左右，跟"lite"的定位冲突，
 *    而且用户机器上本来就有。所以运行时从 `%WINDIR%\Fonts` 读。
 *
 * 🔴 **这条命令刻意没有路径参数、也不进白名单闸门**：它能读的只有下面
 *    候选列表里的三个文件名，不是"通用读文件"。加参数就变成了新的洞。
 *
 * ⚠️ 返回 `tauri::ipc::Response` 的理由同 `read_pdf_bytes`：
 *    `Vec<u8>` 会被序列化成数字数组（9.7 MB 的字体 → 30 MB 的 JSON）。
 *
 * ⚠️ 候选顺序：`simhei.ttf`（黑体，单文件 TTF、字形覆盖最稳）优先。
 *    `msyh.ttc` / `simsun.ttc` 是**字体集合**，fontkit 打开要额外指定索引，
 *    这里不用它们。
 */
#[tauri::command]
fn read_system_font() -> Result<tauri::ipc::Response, String> {
    let windir = std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".to_string());
    let fonts_dir = Path::new(&windir).join("Fonts");
    const CANDIDATES: [&str; 3] = ["simhei.ttf", "Deng.ttf", "simkai.ttf"];
    for name in CANDIDATES {
        let p = fonts_dir.join(name);
        if !p.is_file() {
            continue;
        }
        match std::fs::read(&p) {
            Ok(bytes) => return Ok(tauri::ipc::Response::new(bytes)),
            // 某个文件读不了（权限/占用）不算致命，继续试下一个
            Err(_) => continue,
        }
    }
    Err("这台机器上没找到可用的中文字体（simhei.ttf / Deng.ttf / simkai.ttf）".into())
}

/// 打开文件时判断：这个路径还在不在（上次记住的文件可能被删了）。
///
/// ⚠️ 返回 `Result` 而不是 `bool` 是**故意的**：被闸门拒绝和"文件真的不在"必须能分开。
///    前端那边两者的处理正好相反（见 fileList.ts 里 stillExists / pathExists 的注释）——
///    要是把"拒绝"混成 `false`，用户会看到自己列表里的条目**被静默删掉**。
#[tauri::command]
fn path_exists(allowed: State<Allowed>, path: String) -> Result<bool, String> {
    allowed.check(&path)?;
    Ok(Path::new(&path).exists())
}

/*
 * 默认的另存目录：文档库 / edge-pdf-lite / save。
 *
 * ⚠️ 刻意**不用**安装目录（exe 所在目录）：用安装包装进 `C:\Program Files\...`
 *    之后那个目录对普通用户是只读的，建子目录会直接失败 —— 每次保存都报错。
 *    文档库永远可写，也是 Windows 应用存放用户产物的惯例位置。
 *
 * 目录顺手建好：用户第一次保存时不该遇到"目录不存在"。
 */
#[tauri::command]
fn default_save_dir(allowed: State<Allowed>) -> Result<String, String> {
    let docs = dirs_next().ok_or_else(|| "找不到文档库目录".to_string())?;
    let dir = Path::new(&docs).join("edge-pdf-lite").join("save");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("建不了保存目录 {}: {}", dir.display(), e))?;
    // 自己把自己登记了 —— 这个目录是"我们定的、用户没挑过"，
    // 不登记的话第一次另存就会被闸门拦掉。登记的是**规范化后**的路径，
    // 跟 check() 里的规范化方式保持一致（否则比对会永远差一个 \\?\ 前缀）。
    if let Some(real) = resolveish(&dir) {
        allowed.add(real);
    }
    Ok(dir.to_string_lossy().into_owned())
}

/// 文档库路径。`USERPROFILE\Documents` 优先，拿不到就退回用户目录。
fn dirs_next() -> Option<String> {
    // 不用 dirs crate（多一个依赖），这两个环境变量在 Windows 上足够可靠
    for key in ["USERPROFILE", "HOME"] {
        if let Ok(base) = std::env::var(key) {
            let d = Path::new(&base).join("Documents");
            if d.is_dir() {
                return Some(d.to_string_lossy().into_owned());
            }
            return Some(base);
        }
    }
    None
}

/*
 * 写 PDF。
 *
 * ⚠️ 字节走 **base64 字符串**而不是 `Vec<u8>`：
 *    Tauri 的 IPC 用 JSON 序列化参数，`Vec<u8>` 会被编成 `[12,34,56,...]`
 *    这种数字数组 —— 一份 20 MB 的 PDF 会膨胀到 60 MB 的文本，
 *    在低配机上光解析就要卡一下。base64 只有 1.33 倍。
 *
 * ⚠️ `make_backup`：覆盖**原文件**时要先留一份 .bak。
 *    这是不可逆操作唯一的后悔药，由调用方按"是不是覆盖原文件"决定。
 *
 * 🔴 **只读文件**：从网盘 / 压缩包解出来的 PDF 经常带 `FILE_ATTRIBUTE_READONLY`，
 *    `std::fs::write` 直接报"拒绝访问"。用户看到的只是"保存失败"，根本猜不到是属性问题
 *    （实测他就卡在这上面，而且因为前端把错误吞成了 undefined，连原因都看不到）。
 *    现在的做法：写之前**取消只读**（备份已经先做过了，有后悔药），
 *    并在返回值里说一声，让界面能提示"已帮你取消只读"。
 */
#[derive(serde::Serialize)]
struct WriteResult {
    /** 实际写入的路径（`\\?\` 已去掉，能直接显示/显示给用户） */
    path: String,
    /** 备份文件的完整路径；没备份就是 null */
    backup: Option<String>,
    /** 目标文件原来是只读的、被我们取消了 */
    readonly_cleared: bool,
}

/// 去掉只读属性。返回**是否真的改过**（本来就可写 → false）
fn clear_readonly(p: &Path) -> bool {
    let Ok(md) = std::fs::metadata(p) else {
        return false;
    };
    let mut perm = md.permissions();
    if !perm.readonly() {
        return false;
    }
    perm.set_readonly(false);
    std::fs::set_permissions(p, perm).is_ok()
}

#[tauri::command]
fn write_pdf_b64(
    allowed: State<Allowed>,
    path: String,
    b64: String,
    make_backup: bool,
    /*
     * 备份放哪。
     *
     * 空 / None = 跟被覆盖的文件放同一个目录（老行为）。
     * 有值 = 放到这个目录（用户把「另存目录」设成别处时，.bak 也该跟着过去，
     *        否则原件目录里会莫名其妙多出一堆 .bak）。
     *
     * ⚠️ 这个目录**也要过白名单闸门** —— 备份等于在目标目录里**新建**一个文件。
     *    闸门没过就退回原目录（不能让"备份位置不合规"演变成"保存整体失败"）。
     */
    backup_dir: Option<String>,
) -> Result<WriteResult, String> {
    // 闸门 ①：写到哪里必须在放行范围内（覆盖原文件 = 那个文件本身；
    //          另存 = 保存目录之内。两种都被白名单覆盖得到）
    allowed.check(&path)?;
    // 闸门 ②：只写 .pdf
    ensure_pdf_ext(Path::new(&path))?;

    let bytes = decode_base64(&b64).map_err(|e| format!("数据解码失败：{}", e))?;
    // 闸门 ③：大小（在解码之后判，才是真实字节数）
    ensure_size(bytes.len() as u64)?;

    // 父目录可能不存在（用户手填了一个路径）
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("建不了目录 {}: {}", display_path(parent), e))?;
    }

    let backup_out = if make_backup {
        backup_before_write(&allowed, Path::new(&path), backup_dir.as_deref())?
    } else {
        None
    };

    // 备份已经落好了，所以这里清只读是安全的
    let readonly_cleared = clear_readonly(Path::new(&path));

    std::fs::write(&path, &bytes)
        .map_err(|e| format!("写不了 {}：{}", display_path(Path::new(&path)), e))?;
    Ok(WriteResult {
        path: display_path(Path::new(&path)),
        backup: backup_out,
        readonly_cleared,
    })
}

/// 给一个**已经存在**的文件留 `.bak`，返回备份路径（给人看的形式）。
///
/// 抽出来的原因：`write_pdf_b64`（整份写）和 `write_pdf_tail`（增量追加）
/// 都要这段逻辑，各写一份迟早会在"备份目录没过闸门时怎么办"上分叉。
fn backup_before_write(
    allowed: &Allowed,
    file: &Path,
    backup_dir: Option<&str>,
) -> Result<Option<String>, String> {
    if !file.exists() {
        return Ok(None);
    }
    let mut target_dir: Option<PathBuf> = backup_dir
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .map(PathBuf::from);
    // 备份目录也必须是自己被放行过的地方；没登记就老老实实退回原目录
    if let Some(dir) = target_dir.as_ref() {
        let probe = dir.join("__epl_backup_probe__.pdf");
        if allowed.check(&probe.to_string_lossy()).is_err() || !dir.is_dir() {
            target_dir = None;
        }
    }
    let bak = backup_path(&file.to_string_lossy(), target_dir.as_deref());
    std::fs::copy(file, &bak)
        .map_err(|e| format!("备份失败（已中止保存，原文件没动）：{}", e))?;
    Ok(Some(display_path(&bak)))
}

/*
 * 保存「增量更新」的结果：**原文件 + 一小段增量**。
 *
 * 🔴 为什么需要它（一本 92 MB 的扫描书实测）：
 *    增量更新下产物 = 原文件字节 + 几千字节。前端原本把**整份**产物编成 base64
 *    再走 IPC —— 92 MB 在这台机器上光 `bytesToBase64` + `JSON.stringify`
 *    就超过 **3 分钟**（pdf-lib 自己只要 128 ms）。
 *    所以改成：前端只传那一小段，Rust 把原文件复制/原地追加。
 *
 * ⚠️ `src_len` 是前端**解析时**原文件的字节数。对不上就拒绝 —— 说明读完之后
 *    文件被改过，此时拿旧字节拼新内容会写出坏文件。宁可让用户重开，也不写坏的。
 *
 * ⚠️ 只对"增量产物"成立（产物以原文件字节为前缀）。前端在调用前先比过文件头，
 *    不是增量就走老命令。
 */
#[tauri::command]
fn write_pdf_tail(
    allowed: State<Allowed>,
    path: String,
    src_path: String,
    src_len: u64,
    tail_b64: String,
    make_backup: bool,
    backup_dir: Option<String>,
) -> Result<WriteResult, String> {
    let dst = allowed.check(&path)?;
    ensure_pdf_ext(&dst)?;
    let src = allowed.check(&src_path)?;
    ensure_pdf_ext(&src)?;

    let meta = std::fs::metadata(&src)
        .map_err(|e| format!("读不了原文件 {}：{}", display_path(&src), e))?;
    if meta.len() != src_len {
        return Err(format!(
            "原文件在保存前被改动过（读到 {} 字节，现在是 {} 字节），为了不把它写坏，这次没有保存。\
             重新打开这个文件后再保存一次。",
            src_len,
            meta.len()
        ));
    }

    let tail = decode_base64(&tail_b64).map_err(|e| format!("数据解码失败：{}", e))?;
    if tail.is_empty() {
        return Err("增量部分为空，已中止保存（原文件没动）".to_string());
    }
    // 正常增量只有几 KB；真出现一个离谱的尾巴，说明上游出了错，别硬写
    if tail.len() > 64 * 1024 * 1024 {
        return Err("增量部分异常大（超过 64 MB），已中止保存（原文件没动）".to_string());
    }

    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("建不了目录 {}：{}", display_path(parent), e))?;
    }

    let same_file = dst == src;
    // 备份的永远是**要被改动的那个文件**（覆盖原文件时是原件；另存时是目标位置上已有的旧文件）
    let backup_out = if make_backup {
        backup_before_write(&allowed, &dst, backup_dir.as_deref())?
    } else {
        None
    };

    if !same_file {
        /*
         * 另存一份：增量产物就是"原文件 + 尾巴"，所以直接复制原文件再追加。
         * 复制而不是"新建空文件"—— 前面那 92 MB 一个字节都不用传到 JS 里来。
         */
        std::fs::copy(&src, &dst).map_err(|e| {
            format!(
                "复制原文件到 {} 失败：{}（原文件没动）",
                display_path(&dst),
                e
            )
        })?;
    }

    // 复制过来的文件会继承只读属性；写之前清掉（备份已经先做过）
    let readonly_cleared = clear_readonly(&dst);

    {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&dst)
            .map_err(|e| format!("打不开 {} 追加写入：{}", display_path(&dst), e))?;
        f.write_all(&tail)
            .map_err(|e| format!("写入 {} 失败：{}", display_path(&dst), e))?;
        f.flush()
            .map_err(|e| format!("写入 {} 失败：{}", display_path(&dst), e))?;
    }

    Ok(WriteResult {
        path: display_path(&dst),
        backup: backup_out,
        readonly_cleared,
    })
}

/// 备份文件名：`书.pdf` → `书.bak.pdf`
///
/// @param dir 备份放在哪个目录；`None` = 跟源文件同目录
fn backup_path(path: &str, dir: Option<&Path>) -> std::path::PathBuf {
    let p = Path::new(path);
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let ext = p
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    let base: PathBuf = match dir {
        Some(d) => d.to_path_buf(),
        None => p
            .parent()
            .map(|d| d.to_path_buf())
            .unwrap_or_else(|| PathBuf::from(".")),
    };
    let mut name = format!("{}.bak{}", stem, ext);
    let mut out = base.join(&name);
    // 已经有一份 .bak 就往后排，别把上一份悄悄盖掉
    let mut i = 2;
    while out.exists() {
        name = format!("{}.bak{}{}", stem, i, ext);
        out = base.join(&name);
        i += 1;
    }
    out
}

/*
 * 重命名（**真的改磁盘上的文件名**）。
 *
 * ⚠️ `new_name` 必须带后缀，且后缀要与原来一致 —— 前端只让用户编辑主文件名、
 *    再自己拼回原后缀，所以到这里两者必然一致。这里再校验一次是为了防御：
 *    万一传了个新后缀进来，改完就打不开了（pdf.js 按扩展名找 mime 之外的场景
 *    还有一堆），宁可直接报错。
 *
 * ⚠️ 目标已存在时不覆盖 —— 那会静默毁掉另一个文件。
 */
#[tauri::command]
fn rename_file(allowed: State<Allowed>, path: String, new_name: String) -> Result<String, String> {
    // 闸门：源文件必须在放行范围内。
    // 目标不用再单独查 —— 它是下面从"已放行的源文件"的父目录拼出来的。
    allowed.check(&path)?;

    let p = Path::new(&path);
    let old_ext = p
        .extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let new_ext = Path::new(&new_name)
        .extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if old_ext != new_ext {
        return Err(format!("不能改后缀（{} → {}）", old_ext, new_ext));
    }

    /*
     * 🔴 `new_name` 里只要有分隔符或 `..`，下面的 `dir.join()` 就会拼到**目录外面**去，
     *    于是"改名"能变成"把文件挪到任意位置"。前端输入框确实挡了一层，
     *    但边界上的校验不能依赖调用方 —— 挡住这一整类事情才是闸门存在的意义。
     */
    if new_name.is_empty()
        || new_name != new_name.trim()
        || new_name.contains(['\\', '/'])
        || new_name.contains(':')
        || new_name == "."
        || new_name == ".."
    {
        return Err(format!("新文件名不合法：{:?}", new_name));
    }

    let dir = p
        .parent()
        .ok_or_else(|| format!("拿不到所在目录：{}", path))?;
    let target = dir.join(&new_name);
    if target.exists() {
        return Err(format!("已经有一个 {} 了", new_name));
    }

    std::fs::rename(&path, &target)
        .map_err(|e| format!("重命名失败（原文件没动）：{}", e))?;
    // 这个返回值会被前端写回文件列表 → 再去掉一次前缀（同 register_picked）
    Ok(display_path(&target))
}

/// 在文件管理器里选中这个文件（Windows 自带 explorer，不用额外插件）
#[tauri::command]
fn reveal_in_folder(allowed: State<Allowed>, path: String) -> Result<(), String> {
    // 闸门：explorer 的参数来自这个字符串。不加这一条，它就成了
    // "让系统去打开任意路径"的入口（也是给人看的一份路径存在性回显）。
    let real = allowed.check(&path)?;
    /*
     * ⚠️ 交给 explorer 的必须是**去掉 `\\?\` 的路径**。
     *    explorer 不认扩展长度前缀：传 `\\?\D:\tmp\x` 它会打开"此电脑"（甚至没反应），
     *    而用户看到的现象只是"点了打开文件夹，位置不对"。
     */
    let shown = display_path(&real);
    // explorer 的 /select, 开关后面直接跟路径，逗号不能分开
    std::process::Command::new("explorer")
        .args(["/select,", &shown])
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("打不开文件管理器：{}", e))
}

/// base64 解码（手写，省一个依赖）
fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    const TBL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out: Vec<u8> = Vec::with_capacity(input.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits = 0;
    for c in input.bytes() {
        if c == b'=' || c == b'\n' || c == b'\r' || c == b' ' {
            continue;
        }
        let v = TBL
            .iter()
            .position(|&t| t == c)
            .ok_or_else(|| format!("非法字符 {:?}", c as char))? as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Ok(out)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    /*
     * ⚠️ 自愈必须在**这里**，不能放进下面的 `setup` 回调里。
     *
     * `setup` 跑的时候 Tauri 可能已经初始化过 WebView2 的环境（那一步就会
     * 占住 profile 目录），于是清理会静默失败 —— 标记照样写进去了，
     * 但坏文件一个都没删掉，用户看到的还是白屏。
     * 放到 Builder 之前是**唯一绝对干净**的时机：这时进程里还没有任何 WebView2。
     */
    let context = tauri::generate_context!();
    let identifier = context.config().identifier.clone();
    heal_webview_profile(&identifier);

    /*
     * 路径白名单的状态在这里建、交给 Tauri 托管（命令用 `State<Allowed>` 取）。
     * ⚠️ 落盘位置刻意放在 `EBWebView` **外面**：上面那句自愈会清 profile，
     *    但不该顺手把"用户选过哪些位置"一起清掉（清了等于文件列表全废）。
     */
    let allowed_store = data_root(&identifier).map(|root| root.join("allowed-paths.txt"));

    tauri::Builder::default()
        .manage(Allowed::load(allowed_store))
        .manage(ImageAllowed::default())
        /*
         * 🔴 **单实例保护，必须是第一个注册的插件**（插件文档要求）。
         *
         * 为什么非有不可：两次启动会去开**同一个 WebView2 profile 目录**，
         * 而 WebView2 不允许两个浏览器进程共用它 —— 实测第二个实例起得来窗口，
         * 但 WebView2 环境建不起来，界面就是坏的（用户报的"第二次启动就变成这样"，
         * 而且这种坏状态还会连累下一次启动）。
         * 有了它，第二次启动会把**已有窗口**拉到前面，不再去碰 profile。
         */
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        // 文件 / 文件夹选择对话框（拿**真实路径**用，浏览器里没有这个能力）
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            /*
             * 「这次启动到此为止还算数吗」——先按**坏的**记一笔，
             * 等前端真的跑起来，`app_ready` 会用 `.epl-ok` 把它盖过去（更新的 mtime）。
             *
             * 🔴 为什么写在 `setup` 而不是更早：**只有活下来的那个实例会走到这儿**。
             *    第二次双击的那个进程在单实例插件里就被干掉了（插件注册在最前面、
             *    初始化也在我们前面），所以它一个字都不会写 —— 这正是我第一版写错的地方
             *    （把标记写在 Builder 之前，结果被要死的实例篡改，下一次启动误判）。
             *
             * 这一笔同时覆盖了两种"没跑起来"：
             *   · 白屏（JS 从没执行 → 没人写 `.epl-ok`）
             *   · 用户看到白屏就关掉了（哪怕只开了一秒，`.epl-bad` 已经记下了）
             */
            if let Some(root) = data_root(&app.config().identifier).map(|r| r.join("EBWebView")) {
                mark(&root.join(".epl-bad"), "started, waiting for app_ready");
            }
            if cfg!(debug_assertions) {
                app.handle()
                    .plugin(
                        tauri_plugin_log::Builder::default()
                            .level(log::LevelFilter::Info)
                            .build(),
                    )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_dir,
            read_pdf_bytes,
            read_doc_bytes,
            read_doc_asset,
            allow_image_paths,
            read_absolute_image,
            open_external_url,
            convert_md_to_pdf,
            read_system_font,
            path_exists,
            default_save_dir,
            write_pdf_b64,
            write_pdf_tail,
            reveal_in_folder,
            rename_file,
            app_ready,
            pick_documents,
            pick_folder
        ])
        .run(context)
        .expect("error while building tauri application");
}

/*
 * 单元测试：只测**纯逻辑**（路径解析、扩展名、大小闸门）。
 *
 * 为什么单独补这一组：`read_doc_asset` 让前端第一次拥有了"按相对路径读文件"的能力，
 * 而它最好写的端到端判据是"读不到"—— 但"读不到"也可能是文件真的不存在。
 * 只有把 `resolve_asset` 拎出来单独测，才能区分
 * **"被规则拒绝"** 和 **"碰巧不存在"** 这两种完全不同的原因。
 *
 * 跑法：cd src-tauri && cargo test
 */
#[cfg(test)]
mod tests {
    use super::*;

    /// 造一个临时目录：`a.png` + `sub/b.jpg` + `sub/c.txt` + `sub/deep/d.webp`
    fn fixture(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("epl-asset-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub/deep")).unwrap();
        std::fs::write(dir.join("a.png"), b"png").unwrap();
        std::fs::write(dir.join("sub/b.jpg"), b"jpg").unwrap();
        std::fs::write(dir.join("sub/c.txt"), b"txt").unwrap();
        std::fs::write(dir.join("sub/deep/d.webp"), b"webp").unwrap();
        dir
    }

    #[test]
    fn asset_allows_inside_relative_paths() {
        let dir = fixture("ok");
        assert!(resolve_asset(&dir, "a.png").is_ok());
        assert!(resolve_asset(&dir, "sub/b.jpg").is_ok());
        assert!(resolve_asset(&dir, "sub/deep/d.webp").is_ok());
        // 前导 `./` 与反斜杠分隔符都是合法的相对写法
        assert!(resolve_asset(&dir, "./sub/b.jpg").is_ok());
        assert!(resolve_asset(&dir, "sub\\b.jpg").is_ok());
    }

    #[test]
    fn asset_rejects_any_parent_escape() {
        let dir = fixture("escape");
        for bad in [
            "../a.png",
            "sub/../../a.png",
            "sub/deep/../../../secret.png",
            "..\\..\\secret.png",
        ] {
            assert!(resolve_asset(&dir, bad).is_err(), "竟然放行了 {bad}");
        }
    }

    #[test]
    fn asset_rejects_absolute_forms() {
        let dir = fixture("abs");
        assert!(resolve_asset(&dir, "/etc/passwd").is_err());
        assert!(resolve_asset(&dir, "~/secret.png").is_err());
        #[cfg(windows)]
        {
            assert!(resolve_asset(&dir, r"C:/Windows/win.ini").is_err());
            assert!(resolve_asset(&dir, r"\\server\share\x.png").is_err());
        }
    }

    #[test]
    fn asset_reports_missing_separately() {
        let dir = fixture("missing");
        // 合法的相对路径、但文件不存在 —— 这是"找不到"，不是"越界"
        let err = resolve_asset(&dir, "sub/none.png").unwrap_err();
        assert!(err.contains("找不到"), "{err}");
    }

    #[test]
    fn doc_ext_accepts_pdf_and_markdown() {
        for ok in ["a.pdf", "A.PDF", "b.md", "c.markdown", "D.MarkDown"] {
            assert!(ensure_doc_ext(Path::new(ok)).is_ok(), "{ok} 应该放行");
        }
        for bad in ["a.txt", "b.docx", "c", "d.pdf.bak", "e.html"] {
            assert!(ensure_doc_ext(Path::new(bad)).is_err(), "{bad} 应该拒绝");
        }
    }

    #[test]
    fn image_ext_rejects_svg_and_unknowns() {
        for ok in ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp", "f.bmp"] {
            assert!(ensure_image_ext(Path::new(ok)).is_ok(), "{ok} 应该放行");
        }
        // SVG 能带脚本，不能当"一张图"读
        for bad in ["a.svg", "b.txt", "c", "d.png.html"] {
            assert!(ensure_image_ext(Path::new(bad)).is_err(), "{bad} 应该拒绝");
        }
    }

    #[test]
    fn md_size_limit_is_16_mib_pdf_is_2_gib() {
        let md = Path::new("note.md");
        assert!(ensure_doc_size(md, MAX_MD_BYTES).is_ok());
        assert!(ensure_doc_size(md, MAX_MD_BYTES + 1).is_err());
        let pdf = Path::new("book.pdf");
        assert!(ensure_doc_size(pdf, MAX_PDF_BYTES).is_ok());
        assert!(ensure_doc_size(pdf, MAX_PDF_BYTES + 1).is_err());
        // 同样的字节数，对 md 是超限、对 pdf 不是 —— 证明按类型分流
        assert!(ensure_doc_size(Path::new("x.md"), 64 * 1024 * 1024).is_err());
        assert!(ensure_doc_size(Path::new("x.pdf"), 64 * 1024 * 1024).is_ok());
    }

    #[test]
    fn markdown_detection_is_extension_only() {
        assert!(is_markdown_path(Path::new("a.md")));
        assert!(is_markdown_path(Path::new("a.MARKDOWN")));
        assert!(!is_markdown_path(Path::new("a.pdf")));
        assert!(!is_markdown_path(Path::new("a.mdx")));
    }

    /// 转换引擎的存在性 + 真打印一次。没装 Edge 的环境跳过（不假红）。
    #[test]
    fn edge_print_really_produces_pdf() {
        use std::io::Read;
        let Some(edge) = find_edge() else {
            eprintln!("skip: 本机没装 Microsoft Edge");
            return;
        };
        let dir = std::env::temp_dir().join(format!("epl-print-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let html = dir.join("sample.html");
        std::fs::write(
            &html,
            "<!doctype html><html><head><meta charset='utf-8'>\
             <style>@page{size:A4;margin:18mm}</style></head>\
             <body><h1>转换冒烟样本</h1><p>中文正文，验证字体与分页。</p></body></html>",
        )
        .unwrap();
        let pdf = dir.join("sample.pdf");
        run_print_to_pdf(
            &edge,
            &html,
            &pdf,
            &dir.join("profile"),
        )
        .expect("Edge 打印应该成功");
        let len = std::fs::metadata(&pdf).unwrap().len();
        assert!(len > 1000, "PDF 太小（{} 字节），不像正常产物", len);
        // PDF 魔数
        let mut head = [0u8; 5];
        std::fs::File::open(&pdf).unwrap().read_exact(&mut head).unwrap();
        assert_eq!(&head, b"%PDF-", "产物不是 PDF");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_edge_locations_are_the_usual_ones() {
        // 只验证函数不 panic；机器上有没有 Edge 都合法
        let e = find_edge();
        if let Some(p) = e {
            assert!(p.ends_with("msedge.exe"));
        }
    }
}
