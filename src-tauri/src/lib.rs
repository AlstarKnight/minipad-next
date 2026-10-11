mod edge;
mod notes;

use edge::{Edge, Rect};
use notes::NoteFile;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow,
    WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// 0.1.x 用的应用标识符。0.2.0 换了标识符,启动时把旧位置的设置和笔记搬过来。
const OLD_IDENTIFIER: &str = "com.minipadnext.app";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Geom {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
}

impl Default for Geom {
    fn default() -> Self {
        Geom { x: 0, y: 0, w: 440, h: 540 }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Settings {
    hotkey: String,
    always_on_top: bool,
    edge_hide: bool,
    show_in_taskbar: bool,
    autostart: bool,
    theme: String,
    font_size: u32,
    notes_dir: String,
    window: Option<Geom>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            hotkey: "Ctrl+M".into(),
            always_on_top: true,
            edge_hide: true,
            show_in_taskbar: false,
            autostart: false,
            theme: "system".into(),
            font_size: 14,
            notes_dir: String::new(),
            window: None,
        }
    }
}

#[derive(Serialize)]
struct Note {
    name: String,
    content: String,
    mode: String,
}

#[derive(Serialize)]
struct LoadedState {
    settings: Settings,
    notes_dir: String,
    notes: Vec<Note>,
    active: String,
    /// 启动时热键注册失败的原因(比如被别的软件占用了)
    hotkey_error: Option<String>,
    version: String,
    debug: bool,
}

#[derive(Default)]
struct EdgeState {
    hidden: Option<Edge>,
    /// 隐藏时所在显示器的范围
    monitor: Rect,
    outside_ticks: u32,
}

#[derive(Default)]
struct AppState {
    settings: Mutex<Settings>,
    edge: Mutex<EdgeState>,
    geom: Mutex<Option<Geom>>,
    hotkey_error: Mutex<Option<String>>,
    /// 设置里正在录新热键,全局热键暂时停用
    hotkey_paused: AtomicBool,
    /// 窗口出来以后用户打过字:只要窗口还有焦点,就不自动缩回去
    typing: AtomicBool,
}

// ---------- 路径与设置 ----------

fn config_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("settings.json")
}

fn notes_dir(app: &AppHandle, settings: &Settings) -> PathBuf {
    if !settings.notes_dir.trim().is_empty() {
        return PathBuf::from(settings.notes_dir.trim());
    }
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("notes")
}

fn current_notes_dir(app: &AppHandle) -> PathBuf {
    let s = app.state::<AppState>().settings.lock().unwrap().clone();
    notes_dir(app, &s)
}

fn load_settings(app: &AppHandle) -> Settings {
    fs::read(config_path(app))
        .ok()
        .and_then(|b| serde_json::from_str(&notes::decode_text(&b)).ok())
        .unwrap_or_default()
}

fn persist_settings(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut s = state.settings.lock().unwrap().clone();
    if let Some(g) = state.geom.lock().unwrap().clone() {
        s.window = Some(g);
    }
    if let Ok(json) = serde_json::to_string_pretty(&s) {
        let _ = notes::write_atomic(&config_path(app), &json);
    }
}

/// 把 0.1.x 存在旧标识符目录下的设置和笔记搬到新目录
fn migrate_old_data(app: &AppHandle) {
    let path = app.path();
    let targets = [
        (path.app_config_dir(), "settings.json"),
        (path.app_data_dir(), "notes"),
    ];
    for (dir, item) in targets {
        let Ok(dir) = dir else { continue };
        let old = dir.with_file_name(OLD_IDENTIFIER).join(item);
        if let Err(e) = notes::migrate_path(&old, &dir.join(item)) {
            eprintln!("迁移 {} 失败: {e}", old.display());
        }
    }
}

fn register_hotkey(app: &AppHandle, hotkey: &str) -> Result<(), String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    gs.register(hotkey).map_err(|e| e.to_string())
}

/// 重新启用全局热键(录热键时暂停过的话)
fn resume_hotkey_if_paused(app: &AppHandle) {
    let st = app.state::<AppState>();
    if !st.hotkey_paused.swap(false, Ordering::SeqCst) {
        return;
    }
    let hotkey = st.settings.lock().unwrap().hotkey.clone();
    let result = register_hotkey(app, &hotkey);
    *st.hotkey_error.lock().unwrap() = result.err().map(|e| format!("{hotkey}:{e}"));
}

const WELCOME: &str = r#"# 欢迎使用 Minipad Next

- 按 **Ctrl+M** 呼出或隐藏这个窗口(可以在设置里改)
- 把窗口拖到屏幕**上边、左边或右边**,鼠标移开后会自动贴边隐藏,鼠标碰到边缘再滑出来
- 内容会自动保存,每个页面就是笔记文件夹里的一个 `.md` 文件
- 按 **Ctrl+E** 在"编辑"和"阅读"之间切换,阅读模式下代码块右上角有"复制"按钮

```python
print("点右上角的复制按钮试试")
```

## 快捷键

| 按键 | 作用 |
| --- | --- |
| Ctrl+M | 呼出 / 隐藏(全局) |
| Ctrl+T | 新建页面 |
| Ctrl+E | 编辑 / 阅读切换 |
| Ctrl+F | 搜索全部页面 |
| Ctrl+Tab | 下一个页面 |
| Ctrl+1 ~ 9 | 跳到第 N 个页面 |
| 双击标签 | 重命名 |
| Esc | 隐藏窗口 |
"#;

// ---------- 命令 ----------

#[tauri::command]
fn load_state(app: AppHandle) -> Result<LoadedState, String> {
    let st = app.state::<AppState>();
    let settings = st.settings.lock().unwrap().clone();
    let dir = notes_dir(&app, &settings);
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建笔记文件夹 {}:{e}", dir.display()))?;

    let mut names = notes::list_names(&dir)?;
    if names.is_empty() {
        notes::write_atomic(&notes::note_path(&dir, "欢迎"), WELCOME)?;
        names.push("欢迎".into());
    }

    let meta = notes::read_meta(&dir);
    let ordered = notes::order_names(&names, &meta.order);
    let list = ordered
        .iter()
        .map(|n| Note {
            name: n.clone(),
            content: notes::read_note(&dir, n),
            mode: meta.modes.get(n).cloned().unwrap_or_else(|| "edit".into()),
        })
        .collect();
    let active = if ordered.contains(&meta.active) {
        meta.active.clone()
    } else {
        ordered[0].clone()
    };
    let hotkey_error = st.hotkey_error.lock().unwrap().clone();
    Ok(LoadedState {
        settings,
        notes_dir: dir.to_string_lossy().to_string(),
        notes: list,
        active,
        hotkey_error,
        version: app.package_info().version.to_string(),
        debug: cfg!(debug_assertions),
    })
}

/// 重新读一遍笔记文件夹,用来发现在别处(网盘同步、其他编辑器)改过的内容
#[tauri::command]
fn read_notes(app: AppHandle) -> Result<Vec<NoteFile>, String> {
    notes::read_all(&current_notes_dir(&app))
}

#[tauri::command]
fn save_note(app: AppHandle, name: String, content: String) -> Result<(), String> {
    let dir = current_notes_dir(&app);
    notes::write_atomic(&notes::note_path(&dir, &name), &content)
}

#[tauri::command]
fn create_note(app: AppHandle, name: String) -> Result<String, String> {
    let dir = current_notes_dir(&app);
    let name = notes::unique_name(&dir, &name, None);
    notes::write_atomic(&notes::note_path(&dir, &name), "")?;
    Ok(name)
}

#[tauri::command]
fn rename_note(app: AppHandle, old: String, new: String) -> Result<String, String> {
    let dir = current_notes_dir(&app);
    let new = notes::unique_name(&dir, &new, Some(&old));
    if new != old {
        fs::rename(notes::note_path(&dir, &old), notes::note_path(&dir, &new))
            .map_err(|e| e.to_string())?;
    }
    Ok(new)
}

#[tauri::command]
fn delete_note(app: AppHandle, name: String) -> Result<(), String> {
    notes::move_to_trash(&current_notes_dir(&app), &name)
}

#[tauri::command]
fn save_meta(
    app: AppHandle,
    order: Vec<String>,
    active: String,
    modes: HashMap<String, String>,
) -> Result<(), String> {
    let dir = current_notes_dir(&app);
    notes::write_meta(&dir, &notes::Meta { order, active, modes })
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    let state = app.state::<AppState>();
    let old = state.settings.lock().unwrap().clone();
    let mut new = settings;
    new.window = old.window.clone();
    new.hotkey = new.hotkey.trim().to_string();
    new.notes_dir = new.notes_dir.trim().to_string();

    if !new.notes_dir.is_empty() {
        fs::create_dir_all(&new.notes_dir).map_err(|e| format!("无法使用这个文件夹:{e}"))?;
    }
    // 先换热键(失败就恢复旧的),再改开机启动(失败就把热键也换回去),保证要么都生效要么都不变
    state.hotkey_paused.store(false, Ordering::SeqCst);
    if let Err(e) = register_hotkey(&app, &new.hotkey) {
        let _ = register_hotkey(&app, &old.hotkey);
        return Err(format!("热键 {} 无法使用:{e}", new.hotkey));
    }
    if new.autostart != old.autostart {
        let al = app.autolaunch();
        let r = if new.autostart { al.enable() } else { al.disable() };
        if let Err(e) = r {
            let _ = register_hotkey(&app, &old.hotkey);
            return Err(format!("开机启动设置失败:{e}"));
        }
    }
    *state.hotkey_error.lock().unwrap() = None;

    if let Some(win) = main_window(&app) {
        let _ = win.set_always_on_top(new.always_on_top);
        let _ = win.set_skip_taskbar(!new.show_in_taskbar);
    }
    if !new.edge_hide {
        restore_from_edge(&app, false);
    }
    *state.settings.lock().unwrap() = new.clone();
    persist_settings(&app);
    Ok(new)
}

/// 设置里录新热键时先停用全局热键,否则按下现在的热键会把窗口藏起来
#[tauri::command]
fn pause_hotkey(app: AppHandle) {
    let _ = app.global_shortcut().unregister_all();
    app.state::<AppState>().hotkey_paused.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn resume_hotkey(app: AppHandle) {
    resume_hotkey_if_paused(&app);
}

/// 前端在用户打字时调用(有节流),用来判断贴边隐藏该不该缩回去
#[tauri::command]
fn note_activity(app: AppHandle) {
    app.state::<AppState>().typing.store(true, Ordering::SeqCst);
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    let mut dialog = app.dialog().file().set_title("选择笔记文件夹");
    if let Some(win) = main_window(&app) {
        dialog = dialog.set_parent(&win);
    }
    dialog
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    hide_main(&app);
}

#[tauri::command]
fn open_notes_dir(app: AppHandle) -> Result<(), String> {
    let dir = current_notes_dir(&app);
    tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_link(url: String) -> Result<(), String> {
    let lower = url.to_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")) {
        return Err("只能打开网页链接".into());
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    persist_settings(&app);
    app.exit(0);
}

// ---------- 窗口显示 / 隐藏 / 贴边 ----------

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn window_rect(win: &WebviewWindow) -> Option<Rect> {
    let p = win.outer_position().ok()?;
    let s = win.outer_size().ok()?;
    Some(Rect::new(p.x, p.y, s.width as i32, s.height as i32))
}

fn monitor_rect(m: &Monitor) -> Rect {
    Rect::new(
        m.position().x,
        m.position().y,
        m.size().width as i32,
        m.size().height as i32,
    )
}

fn show_main(app: &AppHandle) {
    if let Some(win) = main_window(app) {
        restore_from_edge(app, false);
        app.state::<AppState>().typing.store(false, Ordering::SeqCst);
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        let _ = app.emit("shown", ());
    }
}

fn hide_main(app: &AppHandle) {
    if let Some(win) = main_window(app) {
        let _ = app.emit("flush", ());
        let _ = win.hide();
        resume_hotkey_if_paused(app);
        persist_settings(app);
    }
}

fn toggle_main(app: &AppHandle) {
    let Some(win) = main_window(app) else { return };
    let visible = win.is_visible().unwrap_or(false);
    let focused = win.is_focused().unwrap_or(false);
    let edge_hidden = app.state::<AppState>().edge.lock().unwrap().hidden.is_some();
    if visible && focused && !edge_hidden {
        hide_main(app);
    } else {
        show_main(app);
    }
}

/// 从贴边隐藏状态滑回屏幕内
fn restore_from_edge(app: &AppHandle, focus: bool) {
    let Some(win) = main_window(app) else { return };
    let st = app.state::<AppState>();
    let (edge, mon) = {
        let e = st.edge.lock().unwrap();
        (e.hidden, e.monitor)
    };
    let Some(edge) = edge else { return };
    let Some(rect) = window_rect(&win) else { return };
    let (x, y) = edge::shown_position(edge, rect, mon);
    let _ = win.set_position(PhysicalPosition::new(x, y));
    {
        let mut e = st.edge.lock().unwrap();
        e.hidden = None;
        e.outside_ticks = 0;
    }
    st.typing.store(false, Ordering::SeqCst);
    if let Ok(size) = win.inner_size() {
        *st.geom.lock().unwrap() = Some(Geom {
            x,
            y,
            w: size.width,
            h: size.height,
        });
    }
    if focus {
        let _ = win.set_focus();
    }
}

fn edge_tick(app: &AppHandle) {
    let st = app.state::<AppState>();
    if !st.settings.lock().unwrap().edge_hide {
        return;
    }
    let Some(win) = main_window(app) else { return };
    if !win.is_visible().unwrap_or(false)
        || win.is_minimized().unwrap_or(false)
        || win.is_maximized().unwrap_or(false)
        || win.is_fullscreen().unwrap_or(false)
    {
        return;
    }
    let (Some(rect), Ok(cur)) = (window_rect(&win), win.cursor_position()) else {
        return;
    };
    let (cx, cy) = (cur.x.round() as i32, cur.y.round() as i32);

    if st.edge.lock().unwrap().hidden.is_some() {
        // 鼠标碰到露出来的那条边就滑出来
        if rect.contains_with_margin(cx, cy, 1) {
            restore_from_edge(app, true);
        }
        return;
    }

    // 鼠标还在窗口上,或者正在打字,都不缩回去
    let busy = rect.contains_with_margin(cx, cy, 2)
        || (st.typing.load(Ordering::SeqCst) && win.is_focused().unwrap_or(false));
    let docked = if busy {
        None
    } else {
        win.current_monitor().ok().flatten().and_then(|m| {
            let mon = monitor_rect(&m);
            let monitors: Vec<Rect> = win
                .available_monitors()
                .unwrap_or_default()
                .iter()
                .map(monitor_rect)
                .collect();
            edge::docked_edge(rect, mon, &monitors).map(|e| (e, mon))
        })
    };

    // 鼠标离开约 0.45 秒后再缩回去,避免误触
    let ready = {
        let mut e = st.edge.lock().unwrap();
        match docked {
            None => {
                e.outside_ticks = 0;
                None
            }
            Some((edge, mon)) => {
                e.outside_ticks += 1;
                if e.outside_ticks >= 3 {
                    e.hidden = Some(edge);
                    e.monitor = mon;
                    e.outside_ticks = 0;
                    Some((edge, mon))
                } else {
                    None
                }
            }
        }
    };
    if let Some((edge, mon)) = ready {
        let (x, y) = edge::hidden_position(edge, rect, mon);
        let _ = app.emit("flush", ());
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
}

/// 启动时恢复上次的位置和大小;如果那个位置已经不在任何显示器上就居中
fn apply_saved_geometry(win: &WebviewWindow, g: &Geom) {
    let monitors = win.available_monitors().unwrap_or_default();
    let visible = monitors.iter().any(|m| {
        let r = monitor_rect(m);
        g.x + 40 < r.x + r.w && g.x + g.w as i32 - 40 > r.x && g.y >= r.y - 4 && g.y + 30 < r.y + r.h
    });
    if g.w >= 200 && g.h >= 150 {
        let _ = win.set_size(PhysicalSize::new(g.w, g.h));
    }
    if visible {
        let _ = win.set_position(PhysicalPosition::new(g.x, g.y));
    } else {
        let _ = win.center();
    }
}

// ---------- 启动 ----------

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_main(app);
                    }
                })
                .build(),
        )
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            load_state,
            read_notes,
            save_note,
            create_note,
            rename_note,
            delete_note,
            save_meta,
            save_settings,
            pause_hotkey,
            resume_hotkey,
            note_activity,
            pick_folder,
            hide_window,
            open_notes_dir,
            open_link,
            quit_app
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            migrate_old_data(&handle);
            let settings = load_settings(&handle);
            {
                let st = handle.state::<AppState>();
                *st.settings.lock().unwrap() = settings.clone();
                *st.geom.lock().unwrap() = settings.window.clone();
                if let Err(e) = register_hotkey(&handle, &settings.hotkey) {
                    eprintln!("热键注册失败: {e}");
                    *st.hotkey_error.lock().unwrap() = Some(format!("{}:{e}", settings.hotkey));
                }
            }

            let win = main_window(&handle).expect("main window");
            let _ = win.set_always_on_top(settings.always_on_top);
            let _ = win.set_skip_taskbar(!settings.show_in_taskbar);
            if let Some(g) = &settings.window {
                apply_saved_geometry(&win, g);
            }
            let start_hidden = std::env::args().any(|a| a == "--hidden");
            if !start_hidden {
                let _ = win.show();
                let _ = win.set_focus();
            }

            // 托盘
            let toggle = MenuItem::with_id(app, "toggle", "显示 / 隐藏", true, None::<&str>)?;
            let open_dir = MenuItem::with_id(app, "open_dir", "打开笔记文件夹", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle, &open_dir, &sep, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Minipad Next")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle_main(app),
                    "open_dir" => {
                        let _ = open_notes_dir(app.clone());
                    }
                    "quit" => {
                        // 让页面先把没保存的内容写盘,再退出
                        let _ = app.emit("before-quit", ());
                        let app = app.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(Duration::from_millis(1500));
                            persist_settings(&app);
                            app.exit(0);
                        });
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // 贴边隐藏轮询
            let h = handle.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(150));
                edge_tick(&h);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            let st = app.state::<AppState>();
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    // 关闭按钮只是隐藏到托盘
                    api.prevent_close();
                    hide_main(app);
                }
                WindowEvent::Focused(true) => {
                    // 前端借这个机会检查笔记有没有在别处被改过
                    let _ = app.emit("window-focus", ());
                }
                WindowEvent::Focused(false) => {
                    st.typing.store(false, Ordering::SeqCst);
                    resume_hotkey_if_paused(app);
                }
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    if st.edge.lock().unwrap().hidden.is_some() {
                        return;
                    }
                    if let (Ok(p), Ok(s)) = (window.outer_position(), window.inner_size()) {
                        if window.is_minimized().unwrap_or(false)
                            || window.is_maximized().unwrap_or(false)
                            || s.width == 0
                        {
                            return;
                        }
                        *st.geom.lock().unwrap() = Some(Geom {
                            x: p.x,
                            y: p.y,
                            w: s.width,
                            h: s.height,
                        });
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Minipad Next");
}
