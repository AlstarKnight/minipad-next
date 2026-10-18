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

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            mobile_load_books,
            mobile_create_book,
            mobile_create_note,
            mobile_save_note
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Minipad Next Android");
}
