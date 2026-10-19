// Windows features and window lifecycle stay on the desktop path.
// Android uses a minimal mobile backend and the same Markdown file format.
#[cfg(desktop)]
include!("desktop.rs");

#[cfg(mobile)]
mod images;
#[cfg(mobile)]
mod mobile;
#[cfg(mobile)]
mod notes;

#[cfg(mobile)]
#[tauri::mobile_entry_point]
pub fn run() {
    mobile::run();
}

// Windows 和 Android 共用 WebDAV 客户端、文件比较和同步执行。
mod syncer;
mod webdav;
