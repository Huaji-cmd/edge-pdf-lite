// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};

// `get_webview_window` / `config()` 这些是 trait 方法，不 import 就调不到
// （编译器会提示 "trait Manager which provides ... is implemented but not in scope"）
use tauri::Manager;

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
    let Ok(local) = std::env::var("LOCALAPPDATA") else {
        return;
    };
    let root: PathBuf = PathBuf::from(&local)
        .join(app.config().identifier.clone())
        .join("EBWebView");
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
    let Ok(local) = std::env::var("LOCALAPPDATA") else {
        return;
    };
    let root: PathBuf = PathBuf::from(&local).join(identifier).join("EBWebView");
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
 * 只返回子目录和 .pdf，其他文件一律过滤掉（这是 PDF 阅读器，
 * 混进一堆 docx 只会让列表变噪音）。
 */
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
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
        let is_pdf = name.to_lowercase().ends_with(".pdf");
        if !is_dir && !is_pdf {
            continue;
        }
        let full = entry.path().to_string_lossy().into_owned();
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
#[tauri::command]
fn read_pdf_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("读不了 {}: {}", path, e))
}

/// 打开文件时判断：这个路径还在不在（上次记住的文件可能被删了）
#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
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
fn default_save_dir() -> Result<String, String> {
    let docs = dirs_next().ok_or_else(|| "找不到文档库目录".to_string())?;
    let dir = Path::new(&docs).join("edge-pdf-lite").join("save");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("建不了保存目录 {}: {}", dir.display(), e))?;
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
 */
#[tauri::command]
fn write_pdf_b64(path: String, b64: String, make_backup: bool) -> Result<String, String> {
    let bytes = decode_base64(&b64).map_err(|e| format!("数据解码失败：{}", e))?;

    // 父目录可能不存在（用户手填了一个路径）
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("建不了目录 {}: {}", parent.display(), e))?;
    }

    if make_backup && Path::new(&path).exists() {
        let bak = backup_path(&path);
        std::fs::copy(&path, &bak)
            .map_err(|e| format!("备份失败（已中止保存，原文件没动）：{}", e))?;
    }

    std::fs::write(&path, &bytes).map_err(|e| format!("写不了 {}: {}", path, e))?;
    Ok(path)
}

/// 备份文件名：`书.pdf` → `书.bak.pdf`（放在同一个目录里）
fn backup_path(path: &str) -> std::path::PathBuf {
    let p = Path::new(path);
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let ext = p
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    let mut name = format!("{}.bak{}", stem, ext);
    let mut out = p.with_file_name(&name);
    // 已经有一份 .bak 就往后排，别把上一份悄悄盖掉
    let mut i = 2;
    while out.exists() {
        name = format!("{}.bak{}{}", stem, i, ext);
        out = p.with_file_name(&name);
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
fn rename_file(path: String, new_name: String) -> Result<String, String> {
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

    let dir = p
        .parent()
        .ok_or_else(|| format!("拿不到所在目录：{}", path))?;
    let target = dir.join(&new_name);
    if target.exists() {
        return Err(format!("已经有一个 {} 了", new_name));
    }

    std::fs::rename(&path, &target)
        .map_err(|e| format!("重命名失败（原文件没动）：{}", e))?;
    Ok(target.to_string_lossy().into_owned())
}

/// 在文件管理器里选中这个文件（Windows 自带 explorer，不用额外插件）
#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
    // explorer 的 /select, 开关后面直接跟路径，逗号不能分开
    std::process::Command::new("explorer")
        .args(["/select,", &path])
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
    heal_webview_profile(&context.config().identifier);

    tauri::Builder::default()
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
            if let Ok(local) = std::env::var("LOCALAPPDATA") {
                let root = PathBuf::from(&local)
                    .join(app.config().identifier.clone())
                    .join("EBWebView");
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
            path_exists,
            default_save_dir,
            write_pdf_b64,
            reveal_in_folder,
            rename_file,
            app_ready
        ])
        .run(context)
        .expect("error while building tauri application");
}
