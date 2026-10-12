// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::Path;

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
    tauri::Builder::default()
        // 文件 / 文件夹选择对话框（拿**真实路径**用，浏览器里没有这个能力）
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
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
            rename_file
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
