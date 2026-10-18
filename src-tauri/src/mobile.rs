//! Android local-first note backend. Desktop-specific plugins and windows stay in desktop.rs.
//! WebDAV is deliberately a later, separate layer; local edits never depend on network access.
use crate::notes;
use serde::Serialize;
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("notes");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
fn mobile_load_books(app: AppHandle) -> Result<Vec<notes::Book>, String> {
    notes::load_books(&root(&app)?)
}

#[tauri::command]
fn mobile_create_book(app: AppHandle, name: String) -> Result<String, String> {
    notes::create_book(&root(&app)?, &name)
}

#[tauri::command]
fn mobile_create_note(app: AppHandle, book: String, name: String) -> Result<String, String> {
    let dir = notes::book_dir(&root(&app)?, &book)?;
    if !dir.is_dir() {
        return Err("笔记本不存在".into());
    }
    notes::create_note(&dir, &name)
}

#[derive(Serialize)]
struct SaveResult {
    conflict_name: Option<String>,
}

#[tauri::command]
fn mobile_save_note(
    app: AppHandle,
    book: String,
    name: String,
    content: String,
    expected: String,
) -> Result<SaveResult, String> {
    let stamp = chrono::Local::now().format("%Y-%m-%d %H.%M").to_string();
    let conflict = notes::save_page(
        &root(&app)?,
        &book,
        &name,
        &content,
        Some(&expected),
        true,
        &stamp,
    )?;
    Ok(SaveResult {
        conflict_name: conflict.map(|(name, _)| name),
    })
}

// Android file picker sends a data URL (a small image) through Tauri IPC.
// The image is stored in the selected book's assets/ folder, as on desktop.
#[tauri::command]
fn mobile_save_image(
    app: AppHandle,
    book: String,
    mime: String,
    data: String,
) -> Result<String, String> {
    use base64::Engine;
    let ext = match mime.as_str() {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        _ => return Err("不支持的图片格式".into()),
    };
    if data.len() > 16 * 1024 * 1024 {
        return Err("图片过大（上限约 10 MB）".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| "图片数据无法解码")?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err("图片超过 10 MB".into());
    }
    let valid = match ext {
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        "bmp" => bytes.starts_with(b"BM"),
        _ => false,
    };
    if !valid {
        return Err("图片内容与格式不匹配".into());
    }
    let dir = notes::book_dir(&root(&app)?, &book)?;
    if !dir.is_dir() {
        return Err("笔记本不存在".into());
    }
    let stamp = chrono::Local::now()
        .format("%Y%m%d-%H%M%S-%3f")
        .to_string();
    crate::images::save(&dir, &bytes, ext, &stamp)
}

// Private-directory images are returned as data URLs, not served by a public
// localhost endpoint. All paths are validated by the shared desktop helper.
#[tauri::command]
fn mobile_read_image(app: AppHandle, book: String, path: String) -> Result<String, String> {
    use base64::Engine;
    let dir = notes::book_dir(&root(&app)?, &book)?;
    let file = crate::images::resolve(&dir, &path)
        .ok_or("只能读取笔记本 assets 目录中的图片")?;
    let mime = crate::images::mime_for(
        file.extension()
            .and_then(|v| v.to_str())
            .ok_or("无效的图片扩展名")?,
    )
    .ok_or("不支持的图片格式")?;
    let size = fs::metadata(&file).map_err(|e| e.to_string())?.len();
    if size > 12 * 1024 * 1024 {
        return Err("图片超过读取限制".into());
    }
    let bytes = fs::read(file).map_err(|e| e.to_string())?;
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            mobile_load_books,
            mobile_create_book,
            mobile_create_note,
            mobile_save_note,
            mobile_save_image,
            mobile_read_image
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Minipad Next Android");
}
