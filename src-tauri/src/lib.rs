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
            path_exists
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
