//! Android local-first note backend. Desktop-specific plugins and windows stay in desktop.rs.
//! WebDAV is deliberately a later, separate layer; local edits never depend on network access.
use crate::notes;
use serde::{Deserialize, Serialize};
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

// Notebook and page names only. Page text is read one page at a time by mobile_read_note,
// so switching pages does not read every note in every notebook.
#[tauri::command]
fn mobile_list_books(app: AppHandle) -> Result<Vec<notes::BookIndex>, String> {
    notes::index_books(&root(&app)?)
}

#[tauri::command]
fn mobile_read_note(app: AppHandle, book: String, name: String) -> Result<notes::PageBody, String> {
    notes::read_page_body(&root(&app)?, &book, &name)
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
    let _write = crate::syncer::WRITE_LOCK
        .lock()
        .map_err(|e| e.to_string())?;
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
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S-%3f").to_string();
    crate::images::save(&dir, &bytes, ext, &stamp)
}

// Private-directory images are returned as data URLs, not served by a public
// localhost endpoint. All paths are validated by the shared desktop helper.
#[tauri::command]
fn mobile_read_image(app: AppHandle, book: String, path: String) -> Result<String, String> {
    use base64::Engine;
    let dir = notes::book_dir(&root(&app)?, &book)?;
    let file = crate::images::resolve(&dir, &path).ok_or("只能读取笔记本 assets 目录中的图片")?;
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

#[derive(Clone, Deserialize)]
#[serde(default)]
struct MobileWebdavConfig {
    enabled: bool,
    server: String,
    user: String,
    folder: String,
    allow_http: bool,
    images: bool,
    first_mode: String,
    delete_limit: usize,
    delete_divisor: usize,
}
impl Default for MobileWebdavConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            server: String::new(),
            user: String::new(),
            folder: "/MinipadNext/".into(),
            allow_http: false,
            images: true,
            first_mode: "merge".into(),
            delete_limit: 20,
            delete_divisor: 3,
        }
    }
}

fn mobile_webdav_password_path(
    app: &AppHandle,
    config: &MobileWebdavConfig,
) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let journal = crate::syncer::journal_path(&dir, &config.server, &config.user, "");
    let name = journal
        .file_stem()
        .and_then(|v| v.to_str())
        .ok_or("账号标识无效")?;
    Ok(dir.join(format!("{name}.password")))
}

fn read_mobile_webdav_password(
    app: &AppHandle,
    config: &MobileWebdavConfig,
) -> Result<String, String> {
    let stable = mobile_webdav_password_path(app, config)?;
    if let Ok(password) = fs::read_to_string(&stable) {
        return Ok(password);
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let old_id = crate::syncer::journal_path(&dir, &config.server, &config.user, &config.folder);
    let name = old_id
        .file_stem()
        .and_then(|v| v.to_str())
        .ok_or("账号标识无效")?;
    let legacy = dir.join(format!("{name}.password"));
    let password =
        fs::read_to_string(&legacy).map_err(|_| "请先保存 WebDAV 应用密码".to_string())?;
    crate::notes::write_atomic(&stable, &password)?;
    let _ = fs::remove_file(&legacy);
    Ok(password)
}

#[tauri::command]
fn mobile_webdav_set_password(
    app: AppHandle,
    config: MobileWebdavConfig,
    password: String,
) -> Result<(), String> {
    if config.server.trim().is_empty() || config.user.trim().is_empty() {
        return Err("请先输入服务器地址和用户名".into());
    }
    // Android 应用私有目录不属于同步、导出、备份的范围。
    crate::notes::write_atomic(&mobile_webdav_password_path(&app, &config)?, &password)
}

#[tauri::command]
async fn mobile_webdav_test(app: AppHandle, config: MobileWebdavConfig) -> Result<String, String> {
    let password = read_mobile_webdav_password(&app, &config)
        .map_err(|_| "请先保存 WebDAV 应用密码".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let client = crate::webdav::WebdavClient::new(
            &config.server,
            &config.user,
            &password,
            &config.folder,
            config.allow_http,
        )?;
        client.test_connection()?;
        Ok::<_, String>("连接与写入测试成功".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn mobile_webdav_status() -> crate::syncer::WebdavStatus {
    crate::syncer::status()
}

#[tauri::command]
fn mobile_webdav_forget(app: AppHandle, config: MobileWebdavConfig) -> Result<(), String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let journal = crate::syncer::journal_path_for_root(
        &data,
        &root(&app)?,
        &config.server,
        &config.user,
        &config.folder,
    );
    for path in [journal, mobile_webdav_password_path(&app, &config)?] {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    crate::syncer::update_status("off", "已断开，手机笔记没有被删除");
    Ok(())
}

#[tauri::command]
async fn mobile_webdav_sync_now(
    app: AppHandle,
    config: MobileWebdavConfig,
    confirm_deletes: bool,
) -> Result<crate::syncer::SyncReport, String> {
    if !config.enabled {
        return Err("请先开启 WebDAV 同步".into());
    }
    let password = read_mobile_webdav_password(&app, &config)
        .map_err(|_| "请先保存 WebDAV 应用密码".to_string())?;
    let dir = root(&app)?;
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let journal = crate::syncer::journal_path_for_root(
        &data,
        &root(&app)?,
        &config.server,
        &config.user,
        &config.folder,
    );
    let mode = match config.first_mode.as_str() {
        "remote" => crate::syncer::FirstSync::Remote,
        "local" => crate::syncer::FirstSync::Local,
        _ => crate::syncer::FirstSync::Merge,
    };
    let options = crate::syncer::SyncOptions {
        images: config.images,
        first_mode: mode,
        conflict_copy: true,
        confirm_deletes,
        delete_limit: config.delete_limit.clamp(1, 1000),
        delete_divisor: config.delete_divisor.clamp(1, 10),
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _run = crate::syncer::RUN_LOCK.lock().map_err(|e| e.to_string())?;
        crate::syncer::update_status("syncing", "正在同步手机笔记");
        let client = crate::webdav::WebdavClient::new(
            &config.server,
            &config.user,
            &password,
            &config.folder,
            config.allow_http,
        )?;
        crate::syncer::sync_once(&client, &dir, &journal, &options, || Ok(()))
    })
    .await
    .map_err(|e| e.to_string())?;
    match &result {
        Ok(report) => {
            let state = if report.conflicts > 0 {
                "conflict"
            } else {
                "synced"
            };
            let text = format!(
                "同步完成：上传 {}，下载 {}，冲突 {}，回收站 {}",
                report.uploaded, report.downloaded, report.conflicts, report.deleted,
            );
            crate::syncer::update_status(state, &text);
            if !report.changed.is_empty() {
                use tauri::Emitter;
                let _ = app.emit("webdav-changed", &report.changed);
            }
        }
        Err(e) if e.starts_with("WEB_DAV_CONFIRM_DELETE:") => {
            crate::syncer::update_status("confirm", "删除数量过多，需要用户确认");
        }
        Err(e) => {
            let kind = if e.contains("离线") || e.contains("超时") {
                "offline"
            } else {
                "error"
            };
            crate::syncer::update_status(kind, e);
        }
    }
    result
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            mobile_list_books,
            mobile_read_note,
            mobile_create_book,
            mobile_create_note,
            mobile_save_note,
            mobile_save_image,
            mobile_read_image,
            mobile_webdav_set_password,
            mobile_webdav_test,
            mobile_webdav_status,
            mobile_webdav_sync_now,
            mobile_webdav_forget
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Minipad Next Android");
}
