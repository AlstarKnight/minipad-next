use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const NOTE_EXT: &str = "md";
const META_FILE: &str = ".minipad.json";
const TRASH_DIR: &str = ".trash";
/// 贴边隐藏后露在屏幕内的宽度(物理像素)
const EDGE_STRIP: i32 = 4;
/// 判断"靠边"的容差
const EDGE_SNAP: i32 = 8;

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

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
struct Meta {
    order: Vec<String>,
    active: String,
    modes: HashMap<String, String>,
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
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Edge {
    Top,
    Left,
    Right,
}

#[derive(Default)]
struct EdgeState {
    hidden: Option<Edge>,
    /// 隐藏时所在显示器的范围 (x, y, w, h)
    monitor: (i32, i32, i32, i32),
    outside_ticks: u32,
}

#[derive(Default)]
struct AppState {
    settings: Mutex<Settings>,
    edge: Mutex<EdgeState>,
    geom: Mutex<Option<Geom>>,
}

// ---------- 路径与文件 ----------

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
    fs::read_to_string(config_path(app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_atomic(path: &Path, data: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp~");
    fs::write(&tmp, data).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn persist_settings(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut s = state.settings.lock().unwrap().clone();
    if let Some(g) = state.geom.lock().unwrap().clone() {
        s.window = Some(g);
    }
    if let Ok(json) = serde_json::to_string_pretty(&s) {
        let _ = write_atomic(&config_path(app), &json);
    }
}

/// 把页面名变成合法的 Windows 文件名
fn sanitize_name(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    s = s.trim().trim_end_matches(['.', ' ']).to_string();
    if s.starts_with('.') {
        s = format!("_{}", &s[1..]);
    }
    if s.chars().count() > 80 {
        s = s.chars().take(80).collect();
    }
    if s.is_empty() {
        s = "新页面".into();
    }
    let upper = s.to_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"];
    if reserved.contains(&upper.as_str())
        || ((upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.len() == 4
            && upper.as_bytes()[3].is_ascii_digit())
    {
        s.push('_');
    }
    s
}

fn note_path(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{name}.{NOTE_EXT}"))
}

fn unique_name(dir: &Path, base: &str, except: Option<&str>) -> String {
    let base = sanitize_name(base);
    // Windows 文件名不区分大小写,这里也按不区分处理
    let except = except.map(|e| e.to_lowercase());
    let existing: Vec<String> = fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let p = e.path();
                    if p.extension().and_then(|x| x.to_str()) != Some(NOTE_EXT) {
                        return None;
                    }
                    Some(p.file_stem()?.to_string_lossy().to_lowercase())
                })
                .collect()
        })
        .unwrap_or_default();
    let taken = |n: &str| {
        let n = n.to_lowercase();
        Some(&n) != except.as_ref() && existing.contains(&n)
    };
    if !taken(&base) {
        return base;
    }
    (2..)
        .map(|i| format!("{base} ({i})"))
        .find(|n| !taken(n))
        .unwrap()
}

fn read_meta(dir: &Path) -> Meta {
    fs::read_to_string(dir.join(META_FILE))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_meta(dir: &Path, meta: &Meta) -> Result<(), String> {
    let json = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    write_atomic(&dir.join(META_FILE), &json)
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
    let settings = app.state::<AppState>().settings.lock().unwrap().clone();
    let dir = notes_dir(&app, &settings);
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建笔记文件夹 {}: {e}", dir.display()))?;

    let mut names: Vec<String> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if p.is_file() && p.extension().and_then(|x| x.to_str()) == Some(NOTE_EXT) {
                p.file_stem().map(|s| s.to_string_lossy().to_string())
            } else {
                None
            }
        })
        .collect();
    names.sort();

    if names.is_empty() {
        write_atomic(&note_path(&dir, "欢迎"), WELCOME)?;
        names.push("欢迎".into());
    }

    let meta = read_meta(&dir);
    let mut ordered: Vec<String> = meta
        .order
        .iter()
        .filter(|n| names.contains(n))
        .cloned()
        .collect();
    for n in &names {
        if !ordered.contains(n) {
            ordered.push(n.clone());
        }
    }

    let notes = ordered
        .iter()
        .map(|n| Note {
            name: n.clone(),
            content: fs::read_to_string(note_path(&dir, n)).unwrap_or_default(),
            mode: meta.modes.get(n).cloned().unwrap_or_else(|| "edit".into()),
        })
        .collect();
    let active = if ordered.contains(&meta.active) {
        meta.active.clone()
    } else {
        ordered[0].clone()
    };
    Ok(LoadedState {
        settings,
        notes_dir: dir.to_string_lossy().to_string(),
        notes,
        active,
    })
}

#[tauri::command]
fn save_note(app: AppHandle, name: String, content: String) -> Result<(), String> {
    let dir = current_notes_dir(&app);
    write_atomic(&note_path(&dir, &name), &content)
}

#[tauri::command]
fn create_note(app: AppHandle, name: String) -> Result<String, String> {
    let dir = current_notes_dir(&app);
    let name = unique_name(&dir, &name, None);
    write_atomic(&note_path(&dir, &name), "")?;
    Ok(name)
}

#[tauri::command]
fn rename_note(app: AppHandle, old: String, new: String) -> Result<String, String> {
    let dir = current_notes_dir(&app);
    let new = unique_name(&dir, &new, Some(&old));
    if new != old {
        fs::rename(note_path(&dir, &old), note_path(&dir, &new)).map_err(|e| e.to_string())?;
    }
    Ok(new)
}

#[tauri::command]
fn delete_note(app: AppHandle, name: String) -> Result<(), String> {
    let dir = current_notes_dir(&app);
    let trash = dir.join(TRASH_DIR);
    fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let src = note_path(&dir, &name);
    if src.exists() {
        fs::rename(&src, trash.join(format!("{name}.{stamp}.{NOTE_EXT}")))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn save_meta(
    app: AppHandle,
    order: Vec<String>,
    active: String,
    modes: HashMap<String, String>,
) -> Result<(), String> {
    let dir = current_notes_dir(&app);
    write_meta(&dir, &Meta { order, active, modes })
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    let state = app.state::<AppState>();
    let old = state.settings.lock().unwrap().clone();
    let mut new = settings;
    new.window = old.window.clone();

    if new.hotkey != old.hotkey {
        let gs = app.global_shortcut();
        let _ = gs.unregister_all();
        if let Err(e) = gs.register(new.hotkey.as_str()) {
            let _ = gs.register(old.hotkey.as_str());
            return Err(format!("热键 {} 无法使用:{e}", new.hotkey));
        }
    }
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_always_on_top(new.always_on_top);
        let _ = win.set_skip_taskbar(!new.show_in_taskbar);
    }
    if new.autostart != old.autostart {
        let al = app.autolaunch();
        let r = if new.autostart { al.enable() } else { al.disable() };
        r.map_err(|e| format!("开机启动设置失败:{e}"))?;
    }
    if !new.notes_dir.trim().is_empty() {
        fs::create_dir_all(new.notes_dir.trim())
            .map_err(|e| format!("无法使用这个文件夹:{e}"))?;
    }
    if !new.edge_hide {
        restore_from_edge(&app, false);
    }
    *state.settings.lock().unwrap() = new.clone();
    persist_settings(&app);
    Ok(new)
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

fn show_main(app: &AppHandle) {
    if let Some(win) = main_window(app) {
        restore_from_edge(app, false);
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
    let (edge, mon) = {
        let st = app.state::<AppState>();
        let e = st.edge.lock().unwrap();
        (e.hidden, e.monitor)
    };
    let Some(edge) = edge else { return };
    let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else { return };
    let (mx, my, mw, _) = mon;
    let target = match edge {
        Edge::Top => PhysicalPosition::new(pos.x, my),
        Edge::Left => PhysicalPosition::new(mx, pos.y),
        Edge::Right => PhysicalPosition::new(mx + mw - size.width as i32, pos.y),
    };
    let _ = win.set_position(target);
    {
        let st = app.state::<AppState>();
        let mut e = st.edge.lock().unwrap();
        e.hidden = None;
        e.outside_ticks = 0;
    }
    *app.state::<AppState>().geom.lock().unwrap() = Some(Geom {
        x: target.x,
        y: target.y,
        w: size.width,
        h: size.height,
    });
    if focus {
        let _ = win.set_focus();
    }
}

fn edge_tick(app: &AppHandle) {
    let enabled = app.state::<AppState>().settings.lock().unwrap().edge_hide;
    if !enabled {
        return;
    }
    let Some(win) = main_window(app) else { return };
    if !win.is_visible().unwrap_or(false) || win.is_minimized().unwrap_or(false) {
        return;
    }
    let (Ok(pos), Ok(size), Ok(cur)) = (win.outer_position(), win.outer_size(), win.cursor_position())
    else {
        return;
    };
    let (cx, cy) = (cur.x as i32, cur.y as i32);
    let (x, y, w, h) = (pos.x, pos.y, size.width as i32, size.height as i32);
    let inside = |m: i32| cx >= x - m && cx < x + w + m && cy >= y - m && cy < y + h + m;

    let hidden = app.state::<AppState>().edge.lock().unwrap().hidden;
    if hidden.is_some() {
        // 鼠标碰到露出来的那条边就滑出来
        if inside(1) {
            restore_from_edge(app, true);
        }
        return;
    }

    let Ok(Some(mon)) = win.current_monitor() else { return };
    let (mx, my) = (mon.position().x, mon.position().y);
    let (mw, mh) = (mon.size().width as i32, mon.size().height as i32);
    let edge = if y <= my + EDGE_SNAP {
        Some(Edge::Top)
    } else if x <= mx + EDGE_SNAP {
        Some(Edge::Left)
    } else if x + w >= mx + mw - EDGE_SNAP {
        Some(Edge::Right)
    } else {
        None
    };

    let ticks = {
        let st = app.state::<AppState>();
        let mut e = st.edge.lock().unwrap();
        if edge.is_none() || inside(2) {
            e.outside_ticks = 0;
        } else {
            e.outside_ticks += 1;
        }
        e.outside_ticks
    };
    // 鼠标离开约 0.45 秒后再缩回去,避免误触
    let Some(edge) = edge else { return };
    if ticks < 3 {
        return;
    }
    {
        let st = app.state::<AppState>();
        let mut e = st.edge.lock().unwrap();
        e.hidden = Some(edge);
        e.monitor = (mx, my, mw, mh);
        e.outside_ticks = 0;
    }
    let target = match edge {
        Edge::Top => PhysicalPosition::new(x, my - h + EDGE_STRIP),
        Edge::Left => PhysicalPosition::new(mx - w + EDGE_STRIP, y),
        Edge::Right => PhysicalPosition::new(mx + mw - EDGE_STRIP, y),
    };
    let _ = app.emit("flush", ());
    let _ = win.set_position(target);
}

/// 启动时恢复上次的位置和大小;如果那个位置已经不在任何显示器上就居中
fn apply_saved_geometry(win: &WebviewWindow, g: &Geom) {
    let monitors = win.available_monitors().unwrap_or_default();
    let visible = monitors.iter().any(|m| {
        let (mx, my) = (m.position().x, m.position().y);
        let (mw, mh) = (m.size().width as i32, m.size().height as i32);
        g.x + 40 < mx + mw && g.x + g.w as i32 - 40 > mx && g.y >= my - 4 && g.y + 30 < my + mh
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
            save_note,
            create_note,
            rename_note,
            delete_note,
            save_meta,
            save_settings,
            hide_window,
            open_notes_dir,
            open_link,
            quit_app
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let settings = load_settings(&handle);
            {
                let st = handle.state::<AppState>();
                *st.settings.lock().unwrap() = settings.clone();
                *st.geom.lock().unwrap() = settings.window.clone();
            }

            if let Err(e) = handle.global_shortcut().register(settings.hotkey.as_str()) {
                eprintln!("热键注册失败: {e}");
                let _ = handle.emit("hotkey-error", format!("{}: {e}", settings.hotkey));
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
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    // 关闭按钮只是隐藏到托盘
                    api.prevent_close();
                    hide_main(app);
                }
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    let st = app.state::<AppState>();
                    if st.edge.lock().unwrap().hidden.is_some() {
                        return;
                    }
                    if let (Ok(p), Ok(s)) = (window.outer_position(), window.outer_size()) {
                        if window.is_minimized().unwrap_or(false) || s.width == 0 {
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
