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

// 同步决策先用纯逻辑测试覆盖；网络执行层接入后改为常规模块。
#[cfg(test)]
mod syncer;
