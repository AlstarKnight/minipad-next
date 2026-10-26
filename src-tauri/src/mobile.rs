//! Android local-first note backend. Desktop-specific plugins and windows stay in desktop.rs.
//! WebDAV is deliberately a later, separate layer; local edits never depend on network access.
use crate::notes;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

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

/// Deleting a page moves it into the notes folder's .trash, the same as on the desktop; the next
/// WebDAV sync then moves the cloud copy into the cloud's .trash.
#[tauri::command]
fn mobile_delete_note(app: AppHandle, book: String, name: String) -> Result<(), String> {
    notes::move_to_trash(&root(&app)?, &book, &name)
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

fn password_file(config: &MobileWebdavConfig, folder: &str) -> Result<String, String> {
    let id = crate::syncer::journal_path(Path::new(""), &config.server, &config.user, folder);
    let name = id
        .file_stem()
        .and_then(|v| v.to_str())
        .ok_or("账号标识无效")?;
    Ok(format!("{name}.password"))
}

/// 密码放在 Android 的 no_backup 目录，系统自动备份和换机迁移都不会带走它。
fn mobile_webdav_password_path(
    app: &AppHandle,
    config: &MobileWebdavConfig,
) -> Result<PathBuf, String> {
    let dir = app.path().data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("no_backup").join(password_file(config, "")?))
}

/// 旧版本放在会被自动备份的应用目录里：按账号的一份，和更早按文件夹的一份。
fn legacy_password_paths(
    app: &AppHandle,
    config: &MobileWebdavConfig,
) -> Result<[PathBuf; 2], String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok([
        dir.join(password_file(config, "")?),
        dir.join(password_file(config, &config.folder)?),
    ])
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn read_mobile_webdav_password(
    app: &AppHandle,
    config: &MobileWebdavConfig,
) -> Result<String, String> {
    let stable = mobile_webdav_password_path(app, config)?;
    if let Ok(password) = fs::read_to_string(&stable) {
        return Ok(password);
    }
    for legacy in legacy_password_paths(app, config)? {
        if let Ok(password) = fs::read_to_string(&legacy) {
            crate::notes::write_atomic(&stable, &password)?;
            remove_if_exists(&legacy)?;
            return Ok(password);
        }
    }
    Err("请先保存 WebDAV 应用密码".into())
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
    crate::notes::write_atomic(&mobile_webdav_password_path(&app, &config)?, &password)?;
    for legacy in legacy_password_paths(&app, &config)? {
        remove_if_exists(&legacy)?;
    }
    Ok(())
}

/// 测试表单里还没保存的设置；密码框为空时用已保存的密码。
#[tauri::command]
async fn mobile_webdav_test(
    app: AppHandle,
    config: MobileWebdavConfig,
    password: Option<String>,
) -> Result<String, String> {
    let password = match password.filter(|p| !p.is_empty()) {
        Some(password) => password,
        None => read_mobile_webdav_password(&app, &config)
            .map_err(|_| "请先保存 WebDAV 应用密码".to_string())?,
    };
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
    let [account, folder] = legacy_password_paths(&app, &config)?;
    for path in [
        journal,
        mobile_webdav_password_path(&app, &config)?,
        account,
        folder,
    ] {
        remove_if_exists(&path)?;
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

/// 能交给手机打开的链接:网页、邮件、电话。别的(相对路径、file:、javascript: 等)一律不开
fn external_link(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    ["http://", "https://", "mailto:", "tel:"]
        .iter()
        .any(|scheme| lower.starts_with(scheme))
}

/// 点页面里的链接:网页用系统浏览器或应用内浏览器(Custom Tabs)打开,邮件、电话交给对应的应用
#[tauri::command]
async fn mobile_open_url(app: AppHandle, url: String, in_app: bool) -> Result<(), String> {
    if !external_link(&url) {
        return Err("这个链接不能在手机上打开".into());
    }
    // 应用内浏览器只能开网页
    let with = (in_app && url.to_ascii_lowercase().starts_with("http")).then_some("inAppBrowser");
    tauri::async_runtime::spawn_blocking(move || app.opener().open_url(url, with))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// 兜底:WebView 要离开应用自己的页面(tauri.localhost)时一律拦下,网页、邮件、电话链接转交系统打开。
/// 页面里哪里漏拦了链接,也不会把整个应用换成那个网页
fn link_guard<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("link-guard")
        .on_navigation(|webview, url| {
            if tauri::is_dev()
                || url.host_str() == Some("tauri.localhost")
                || url.scheme() == "about"
            {
                return true;
            }
            if external_link(url.as_str()) {
                let app = webview.app_handle().clone();
                let url = url.to_string();
                // 这里在 Android 的界面线程上,而 opener 要等界面线程回话,所以换个线程去开
                std::thread::spawn(move || {
                    let _ = app.opener().open_url(url, None::<&str>);
                });
            }
            false
        })
        .build()
}

pub fn run() {
    tauri::Builder::default()
        // 链接交给系统打开;opener 自带的点击拦截脚本不要(页面自己处理点链接)
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(link_guard())
        // 页面里的图片和电脑一样按地址读(note 协议,只能读笔记本 assets 里的图片),不再整张转成 base64 经 IPC 传
        .register_uri_scheme_protocol("note", |ctx, request| match root(ctx.app_handle()) {
            Ok(dir) => crate::images::protocol_response(&dir, request.uri()),
            Err(_) => tauri::http::Response::builder()
                .status(404)
                .body(Vec::new())
                .unwrap(),
        })
        .invoke_handler(tauri::generate_handler![
            mobile_list_books,
            mobile_read_note,
            mobile_create_book,
            mobile_create_note,
            mobile_delete_note,
            mobile_save_note,
            mobile_save_image,
            mobile_open_url,
            mobile_webdav_set_password,
            mobile_webdav_test,
            mobile_webdav_status,
            mobile_webdav_sync_now,
            mobile_webdav_forget
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Minipad Next Android");
}
