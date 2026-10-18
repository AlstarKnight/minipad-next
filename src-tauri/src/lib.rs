// Windows features and window lifecycle stay on the desktop path.
// Android uses a minimal mobile backend and the same Markdown file format.
#[cfg(desktop)]
include!("desktop.rs");

#[cfg(mobile)]
mod images;
#[cfg(mobile)]
mod notes;
#[cfg(mobile)]
mod mobile;

#[cfg(mobile)]
#[tauri::mobile_entry_point]
pub fn run() {
    mobile::run();
}
