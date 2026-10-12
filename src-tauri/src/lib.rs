mod backup;
mod edge;
mod notes;

use edge::{Edge, Rect};
use notes::Book;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow,
    WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// 0.1.x 用的应用标识符。0.2.0 换了标识符,启动时把旧位置的设置和笔记搬过来。
const OLD_IDENTIFIER: &str = "com.minipadnext.app";

/// F5 插入日期时间的默认格式,和中文 Windows 记事本一样,比如 13:45 2026/10/11
const DEFAULT_DATE_FORMAT: &str = "H:mm yyyy/M/d";

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
        Geom {
            x: 0,
            y: 0,
            w: 440,
            h: 540,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Settings {
    hotkey: String,
    always_on_top: bool,
    edge_hide: bool,
    edge_expand_button: bool,
    show_in_taskbar: bool,
    autostart: bool,
    theme: String,
    /// 强调色:空着是默认的橙色,"#3b82f6" 是纯色,"linear-gradient(135deg, #a, #b)" 是渐变色
    accent: String,
    /// 活跃标签的高亮:line 顶部线条、fill 整个标签、border 整圈边框
    tab_style: String,
    font_size: u32,
    notes_dir: String,
    /// 编辑区显示行号
    line_numbers: bool,
    /// 按 F5 插入的日期时间格式,写法和 Windows 一样,比如 H:mm yyyy/M/d
    date_format: String,
    /// 代码块显示行号
    code_line_numbers: bool,
    /// 标签下面显示格式栏
    format_bar: bool,
    /// 格式栏里不显示的按钮
    format_bar_hidden: Vec<String>,
    /// 格式栏按钮的顺序(按钮的名字,竖线分隔是 sep1、sep2…),空着就是默认顺序
    format_bar_order: Vec<String>,
    /// 每天第一次保存时把笔记文件夹打包备份
    backup_enabled: bool,
    /// 保留最近几份备份
    backup_keep: u32,
    /// 备份放在哪里,空着就用程序数据目录下的 backups
    backup_dir: String,
    window: Option<Geom>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            hotkey: "Ctrl+M".into(),
            always_on_top: true,
            edge_hide: true,
            edge_expand_button: true,
            show_in_taskbar: false,
            autostart: false,
            theme: "system".into(),
            accent: String::new(),
            tab_style: "line".into(),
            font_size: 14,
            notes_dir: String::new(),
            line_numbers: false,
            date_format: DEFAULT_DATE_FORMAT.into(),
            code_line_numbers: true,
            format_bar: true,
            format_bar_hidden: Vec::new(),
            format_bar_order: Vec::new(),
            backup_enabled: true,
            backup_keep: 14,
            backup_dir: String::new(),
            window: None,
        }
    }
}

#[derive(Serialize)]
struct LoadedState {
    settings: Settings,
    settings_error: Option<String>,
    notes_dir: String,
    /// 全部笔记本,「默认」(名字是空字符串)在最前
    books: Vec<Book>,
    /// 当前打开的笔记本
    book: String,
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
struct QuitState {
    active: Option<u64>,
    waiting_ack: bool,
}

#[derive(Default)]
struct AppState {
    settings: Mutex<Settings>,
    /// 配置文件不存在或成功读取时才可以写回。读失败/解析失败时保持原文件。
    settings_write_allowed: AtomicBool,
    settings_read_error: Mutex<Option<String>>,
    quit: Mutex<QuitState>,
    quit_sequence: AtomicU64,
    edge: Mutex<EdgeState>,
    geom: Mutex<Option<Geom>>,
    hotkey_error: Mutex<Option<String>>,
    /// 设置里正在录新热键,全局热键暂时停用
    hotkey_paused: AtomicBool,
    /// 窗口出来以后用户打过字:只要窗口还有焦点,就不自动缩回去
    typing: AtomicBool,
    /// 最近一次自动备份是哪天(这一天就不用再备份了)
    backup_day: Mutex<String>,
    /// 后台正在打包备份
    backup_running: AtomicBool,
}

#[derive(Serialize)]
struct BackupInfo {
    /// 实际使用的备份文件夹
    dir: String,
    /// 最近一份备份的日期
    latest: Option<String>,
    count: usize,
}

// ---------- 路径与设置 ----------

fn config_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("settings.json")
}

/// 默认与可执行文件放在一起；旧版本已有的数据优先保留原位置。
/// 安装目录不可写时继续使用用户数据目录，不影响在 Program Files 的安装。
static DEFAULT_NOTES_PATH: OnceLock<PathBuf> = OnceLock::new();
static DEFAULT_BACKUP_PATH: OnceLock<PathBuf> = OnceLock::new();

fn default_storage_dir(app: &AppHandle, folder: &str) -> PathBuf {
    let cache = if folder == "notes" {
        &DEFAULT_NOTES_PATH
    } else {
        &DEFAULT_BACKUP_PATH
    };
    cache
        .get_or_init(|| {
            let legacy = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(folder);
            let Some(program_root) = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(Path::to_path_buf))
            else {
                return legacy;
            };
            preferred_storage_dir(&program_root, &legacy, folder)
        })
        .clone()
}

fn contains_data(path: &Path) -> bool {
    fs::read_dir(path).is_ok_and(|mut entries| entries.next().is_some())
}

fn preferred_storage_dir(program_root: &Path, legacy: &Path, folder: &str) -> PathBuf {
    preferred_storage_dir_with_probe(program_root, legacy, folder, |root| {
        let probe = root.join(format!(".minipad-write-{}.tmp~", std::process::id()));
        let writable = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)
            .is_ok();
        if writable {
            let _ = fs::remove_file(&probe);
        }
        writable
    })
}

/// 测试可注入权限检查，Windows 的只读属性不能可靠模拟目录 ACL。
fn preferred_storage_dir_with_probe(
    program_root: &Path,
    legacy: &Path,
    folder: &str,
    writable: impl FnOnce(&Path) -> bool,
) -> PathBuf {
    let beside_exe = program_root.join(folder);
    // 若安装目录已有笔记，以那份数据为准；绝不覆盖已有目录。
    if contains_data(&beside_exe) {
        return beside_exe;
    }
    // 只在需要建目录或迁移旧数据时检测可写性，结果由 OnceLock 缓存。
    if writable(program_root) {
        if contains_data(legacy) {
            // 旧版本的默认内容安全复制到 exe 旁边；原文件仍然保留。
            // 若目标不可写、发生冲突或复制失败，就继续读取旧位置。
            return match notes::copy_notes_for_switch(legacy, &beside_exe) {
                Ok(()) => beside_exe,
                Err(e) => {
                    eprintln!("迁移旧默认目录失败，继续使用原目录: {e}");
                    legacy.to_path_buf()
                }
            };
        }
        beside_exe
    } else {
        // 包括旁边已经有空 notes/ 或 backups/ 的情况。目录不可写就使用 AppData。
        legacy.to_path_buf()
    }
}

fn notes_dir(app: &AppHandle, settings: &Settings) -> PathBuf {
    if !settings.notes_dir.trim().is_empty() {
        return PathBuf::from(settings.notes_dir.trim());
    }
    default_storage_dir(app, "notes")
}

fn current_notes_dir(app: &AppHandle) -> PathBuf {
    let s = app.state::<AppState>().settings.lock().unwrap().clone();
    notes_dir(app, &s)
}

fn backup_dir(app: &AppHandle, settings: &Settings) -> PathBuf {
    if !settings.backup_dir.trim().is_empty() {
        return PathBuf::from(settings.backup_dir.trim());
    }
    default_storage_dir(app, "backups")
}

/// `inner` 是不是 `outer` 本身或者在它里面(两个文件夹都要已经存在)
fn is_inside(inner: &Path, outer: &Path) -> bool {
    match (fs::canonicalize(inner), fs::canonicalize(outer)) {
        (Ok(i), Ok(o)) => i.starts_with(o),
        _ => false,
    }
}

/// 改笔记前调用:今天还没备份过就在后台把笔记文件夹打包。
/// 只试一次,失败了通知前端提示一下,明天(或者重启程序后)再试。
fn maybe_backup(app: &AppHandle) {
    let st = app.state::<AppState>();
    let settings = st.settings.lock().unwrap().clone();
    if !settings.backup_enabled {
        return;
    }
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    if *st.backup_day.lock().unwrap() == today || st.backup_running.swap(true, Ordering::SeqCst) {
        return;
    }
    let notes = notes_dir(app, &settings);
    let dest = backup_dir(app, &settings);
    let keep = settings.backup_keep as usize;
    let app = app.clone();
    std::thread::spawn(move || {
        let result = backup::run(&notes, &dest, &today, keep);
        let st = app.state::<AppState>();
        *st.backup_day.lock().unwrap() = today;
        st.backup_running.store(false, Ordering::SeqCst);
        if let Err(e) = result {
            eprintln!("{e}");
            let _ = app.emit("backup-error", e);
        }
    });
}

/// 迁移完成后将绝对路径钉在设置中。换安装位置时不再从旧 AppData
/// 重复复制陈旧的笔记；用户明确设置的路径始终优先。
fn pin_default_storage(settings: &mut Settings, notes: &Path, backups: &Path) -> bool {
    let mut changed = false;
    if settings.notes_dir.trim().is_empty() {
        settings.notes_dir = notes.to_string_lossy().into_owned();
        changed = true;
    }
    if settings.backup_dir.trim().is_empty() {
        settings.backup_dir = backups.to_string_lossy().into_owned();
        changed = true;
    }
    changed
}

/// 区分文件不存在与读取/解析失败；只有前两种可安全写回。
/// 不可读取的配置本次运行使用默认值，但不得覆盖原有 settings.json。
fn decode_settings_result(
    result: std::io::Result<Vec<u8>>,
) -> (Settings, bool, Option<String>) {
    match result {
        Ok(bytes) => match serde_json::from_str::<Settings>(&notes::decode_text(&bytes)) {
            Ok(settings) => (settings, true, None),
            Err(e) => (
                Settings::default(),
                false,
                Some(format!("设置文件解析失败:{e}")),
            ),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            (Settings::default(), true, None)
        }
        Err(e) => (
            Settings::default(),
            false,
            Some(format!("设置文件读取失败:{e}")),
        ),
    }
}

fn load_settings(app: &AppHandle) -> (Settings, bool, Option<String>) {
    decode_settings_result(fs::read(config_path(app)))
}

fn write_settings_if_allowed(path: &Path, settings: &Settings, allowed: bool) -> Result<(), String> {
    if !allowed {
        // 保护原文件：即使后来暂时恢复可写，也不能用本次运行的默认值覆盖。
        return Ok(());
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    notes::write_atomic(path, &json)
}

fn persist_settings(app: &AppHandle) {
    let state = app.state::<AppState>();
    if !state.settings_write_allowed.load(Ordering::SeqCst) {
        return;
    }
    let mut s = state.settings.lock().unwrap().clone();
    if let Some(g) = state.geom.lock().unwrap().clone() {
        s.window = Some(g);
    }
    if let Err(e) = write_settings_if_allowed(&config_path(app), &s, true) {
        eprintln!("保存设置失败:{e}");
    }
}

/// 保存前整理前端传来的设置:去掉首尾空格,数字限制在合理范围
fn tidy_settings(s: &mut Settings) {
    s.hotkey = s.hotkey.trim().to_string();
    s.notes_dir = s.notes_dir.trim().to_string();
    s.backup_dir = s.backup_dir.trim().to_string();
    s.backup_keep = s.backup_keep.clamp(1, 365);
    // 强调色只是给界面用的一小段文字,太长或者有奇怪的字符就不要
    s.accent = s.accent.trim().to_string();
    if s.accent.len() > 160
        || !s
            .accent
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || " #(),-.".contains(c))
    {
        s.accent.clear();
    }
    if !["line", "fill", "border"].contains(&s.tab_style.as_str()) {
        s.tab_style = "line".into();
    }
    // 日期格式最多 64 个字(按字算,不按字节),空着就用默认的
    let format: String = s.date_format.trim().chars().take(64).collect();
    s.date_format = match format.trim_end() {
        "" => DEFAULT_DATE_FORMAT.to_string(),
        f => f.to_string(),
    };
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
- 看到的就是排好版的样子:行首打 `# ` 变标题,`- ` 变列表,`> ` 变引用,`**粗体**`、`` `代码` `` 打完就变样;选中文字会出来一排按钮
- 标签下面的**格式栏**有标题、粗体、列表、表格、<span style="color: #df2a3f">字体颜色</span>和<span style="background-color: #fbe9a6">背景颜色</span>等按钮;右边的按钮可以选显示哪些、拖动排顺序,顶栏的格式栏按钮(像一个带工具条的小窗口)可以收起它
- 顶栏的太阳 / 月亮按钮切换深色和浅色;设置里可以换<span style="color: #5fb4ff; background-image: linear-gradient(90deg, #5fb4ff, #d66cf0); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent">强调色,也能用渐变色</span>
- 在列表里按 **Enter** 接着写下一项,**Ctrl+Enter** 勾选任务,**F5** 插入当前日期时间
- 打 ```` ``` ```` 再按 Enter 插入代码块;代码块顶栏的"添加标题"和语言点一下就能改,右边有"复制"按钮
- 页面多了可以分**笔记本**:点标签栏最左边的笔记本名字(或按 **Ctrl+B**)新建和切换,每个笔记本就是笔记文件夹里的一个子文件夹
- 每天第一次保存时会自动把笔记文件夹备份成 zip,默认保留最近 14 份,可以在设置里改

```python 试试复制
print("点右上角的复制按钮试试")
```

## 快捷键

| 按键 | 作用 |
| --- | --- |
| Ctrl+M | 呼出 / 隐藏(全局) |
| Ctrl+B | 选中文字时加粗,没选中时切换笔记本 |
| Ctrl+I | 斜体 |
| Ctrl+T | 新建页面 |
| Ctrl+F | 搜索全部笔记本的页面 |
| Ctrl+Tab | 下一个页面 |
| Ctrl+1 ~ 9 | 跳到第 N 个页面 |
| Ctrl+Enter | 勾选 / 取消勾选任务 |
| Shift+Enter | 段落里换行 |
| F5 | 插入当前日期时间 |
| Ctrl+点击链接 | 用浏览器打开 |
| 双击标签 | 重命名 |
| 右键标签 | 重命名、移到别的笔记本、删除 |
| Esc | 隐藏窗口 |
"#;

// ---------- 命令 ----------

#[tauri::command]
fn load_state(app: AppHandle) -> Result<LoadedState, String> {
    let st = app.state::<AppState>();
    let settings = st.settings.lock().unwrap().clone();
    let dir = notes_dir(&app, &settings);
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建笔记文件夹 {}:{e}", dir.display()))?;

    // 第一次用(文件夹里既没有页面也没有笔记本)时写一页说明
    if notes::list_names(&dir)?.is_empty() && notes::list_books(&dir)?.is_empty() {
        notes::write_atomic(&notes::note_path(&dir, "欢迎"), WELCOME)?;
    }
    let books = notes::load_books(&dir)?;
    let saved = notes::read_meta(&dir).book;
    let book = if books.iter().any(|b| b.name == saved) {
        saved
    } else {
        String::new()
    };
    let hotkey_error = st.hotkey_error.lock().unwrap().clone();
    let settings_error = st.settings_read_error.lock().unwrap().clone();
    Ok(LoadedState {
        settings,
        settings_error,
        notes_dir: dir.to_string_lossy().to_string(),
        books,
        book,
        hotkey_error,
        version: app.package_info().version.to_string(),
        debug: cfg!(debug_assertions),
    })
}

/// 重新读一遍笔记文件夹,用来发现在别处(网盘同步、其他编辑器)改过的内容
#[tauri::command]
fn read_notes(app: AppHandle) -> Result<Vec<Book>, String> {
    notes::load_books(&current_notes_dir(&app))
}

#[tauri::command]
fn book_exists(app: AppHandle, book: String) -> Result<bool, String> {
    let dir = notes::book_dir(&current_notes_dir(&app), &book)?;
    match fs::metadata(dir) {
        Ok(meta) => Ok(meta.is_dir()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Ok(true),
    }
}

#[tauri::command]
fn save_note(app: AppHandle, book: String, name: String, content: String) -> Result<(), String> {
    let path = notes::page_path(&current_notes_dir(&app), &book, &name)?;
    maybe_backup(&app);
    notes::write_atomic(&path, &content)
}

#[tauri::command]
fn create_note(app: AppHandle, book: String, name: String) -> Result<String, String> {
    let dir = notes::book_dir(&current_notes_dir(&app), &book)?;
    maybe_backup(&app);
    let name = notes::unique_name(&dir, &name, None);
    notes::write_atomic(&notes::note_path(&dir, &name), "")?;
    Ok(name)
}

#[tauri::command]
fn rename_note(app: AppHandle, book: String, old: String, new: String) -> Result<String, String> {
    let root = current_notes_dir(&app);
    let src = notes::page_path(&root, &book, &old)?;
    let dir = notes::book_dir(&root, &book)?;
    let new = notes::unique_name(&dir, &new, Some(&old));
    if new != old {
        maybe_backup(&app);
        fs::rename(src, notes::note_path(&dir, &new)).map_err(|e| e.to_string())?;
    }
    Ok(new)
}

#[tauri::command]
fn delete_note(app: AppHandle, book: String, name: String) -> Result<(), String> {
    maybe_backup(&app);
    notes::move_to_trash(&current_notes_dir(&app), &book, &name)
}

/// 把页面移到另一个笔记本,返回它在那边的名字(重名时会加编号)
#[tauri::command]
fn move_note(app: AppHandle, book: String, name: String, target: String) -> Result<String, String> {
    maybe_backup(&app);
    notes::move_note(&current_notes_dir(&app), &book, &name, &target)
}

#[tauri::command]
fn save_meta(
    app: AppHandle,
    book: String,
    order: Vec<String>,
    active: String,
    modes: HashMap<String, String>,
) -> Result<(), String> {
    notes::save_book_meta(&current_notes_dir(&app), &book, order, active, modes)
}

#[tauri::command]
fn create_book(app: AppHandle, name: String) -> Result<String, String> {
    maybe_backup(&app);
    notes::create_book(&current_notes_dir(&app), &name)
}

#[tauri::command]
fn rename_book(app: AppHandle, old: String, new: String) -> Result<String, String> {
    maybe_backup(&app);
    notes::rename_book(&current_notes_dir(&app), &old, &new)
}

#[tauri::command]
fn delete_book(app: AppHandle, name: String) -> Result<(), String> {
    maybe_backup(&app);
    notes::delete_book(&current_notes_dir(&app), &name)
}

/// 记住当前打开的笔记本,下次启动还打开它
#[tauri::command]
fn set_current_book(app: AppHandle, book: String) -> Result<(), String> {
    notes::set_current_book(&current_notes_dir(&app), &book)
}

#[tauri::command]
fn backup_info(app: AppHandle) -> BackupInfo {
    let settings = app.state::<AppState>().settings.lock().unwrap().clone();
    let dir = backup_dir(&app, &settings);
    let all = backup::list(&dir);
    BackupInfo {
        dir: dir.to_string_lossy().to_string(),
        latest: all.last().map(|(day, _)| day.clone()),
        count: all.len(),
    }
}

#[tauri::command]
fn open_backup_dir(app: AppHandle) -> Result<(), String> {
    let settings = app.state::<AppState>().settings.lock().unwrap().clone();
    let dir = backup_dir(&app, &settings);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| e.to_string())
}

/// 设置变更按热键、开机启动、文件复制的顺序提交；文件复制必须最后执行。
/// 迁移失败时撤回已经成功的系统设置，并报告任何回滚失败。
fn apply_settings_side_effects<H, A, M>(
    hotkey_changed: bool,
    autostart_changed: bool,
    autostart_enabled: bool,
    mut set_hotkey: H,
    mut set_autostart: A,
    copy_notes: M,
) -> Result<(), String>
where
    H: FnMut(bool) -> Result<(), String>,
    A: FnMut(bool) -> Result<(), String>,
    M: FnOnce() -> Result<(), String>,
{
    if hotkey_changed {
        if let Err(e) = set_hotkey(true) {
            let rollback = set_hotkey(false).err();
            return Err(append_rollback_error(e, rollback.into_iter().collect()));
        }
    }
    if autostart_changed {
        if let Err(e) = set_autostart(autostart_enabled) {
            let rollback = if hotkey_changed {
                set_hotkey(false).err()
            } else {
                None
            };
            return Err(append_rollback_error(e, rollback.into_iter().collect()));
        }
    }
    if let Err(e) = copy_notes() {
        let mut errors = Vec::new();
        if autostart_changed {
            if let Err(revert) = set_autostart(!autostart_enabled) {
                errors.push(revert);
            }
        }
        if hotkey_changed {
            if let Err(revert) = set_hotkey(false) {
                errors.push(revert);
            }
        }
        return Err(append_rollback_error(e, errors));
    }
    Ok(())
}

fn append_rollback_error(original: String, rollback: Vec<String>) -> String {
    if rollback.is_empty() {
        original
    } else {
        format!("{original}（回滚失败：{}）", rollback.join("；"))
    }
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    settings: Settings,
    migrate_notes: Option<bool>,
) -> Result<Settings, String> {
    let state = app.state::<AppState>();
    if !state.settings_write_allowed.load(Ordering::SeqCst) {
        let reason = state.settings_read_error.lock().unwrap().clone();
        return Err(format!(
            "启动时无法读取原设置文件，已禁止覆盖；请恢复原文件并重新启动。{}",
            reason.unwrap_or_default()
        ));
    }
    let old = state.settings.lock().unwrap().clone();
    let mut new = settings;
    new.window = old.window.clone();
    tidy_settings(&mut new);

    let old_notes = notes_dir(&app, &old);
    let new_notes = notes_dir(&app, &new);
    let copying_notes = old_notes != new_notes && migrate_notes.unwrap_or(false);
    if !copying_notes && !new.notes_dir.is_empty() {
        fs::create_dir_all(&new.notes_dir).map_err(|e| format!("无法使用这个文件夹:{e}"))?;
    }
    if new.backup_enabled {
        let dest = backup_dir(&app, &new);
        fs::create_dir_all(&dest).map_err(|e| format!("无法使用这个备份位置:{e}"))?;
        if is_inside(&dest, &notes_dir(&app, &new)) {
            return Err("备份位置不能放在笔记文件夹里面,请换一个文件夹".into());
        }
    }
    // 先验证并更新全局热键和开机启动，最后才复制目录。
    // 后续失败时回滚系统设置，避免产生“设置未切换、目标已有副本”的半途状态。
    let hotkey_changed = new.hotkey != old.hotkey;
    let retry_hotkey = state.hotkey_error.lock().unwrap().is_some();
    let update_hotkey = hotkey_changed || retry_hotkey;
    let update_autostart = new.autostart != old.autostart;
    let autolaunch = app.autolaunch();
    apply_settings_side_effects(
        update_hotkey,
        update_autostart,
        new.autostart,
        |use_new| {
            state.hotkey_paused.store(false, Ordering::SeqCst);
            let target = if use_new { &new.hotkey } else { &old.hotkey };
            let result = register_hotkey(&app, target);
            *state.hotkey_error.lock().unwrap() =
                result.as_ref().err().map(|e| format!("{target}:{e}"));
            result.map_err(|e| format!("热键 {target} 无法使用:{e}"))
        },
        |enable| {
            let result = if enable {
                autolaunch.enable()
            } else {
                autolaunch.disable()
            };
            result.map_err(|e| format!("开机启动设置失败:{e}"))
        },
        || {
            if copying_notes {
                notes::copy_notes_for_switch(&old_notes, &new_notes)?;
            }
            Ok(())
        },
    )?;

    if let Some(win) = main_window(&app) {
        let _ = win.set_always_on_top(new.always_on_top);
        let _ = win.set_skip_taskbar(!new.show_in_taskbar);
    }
    if !new.edge_hide {
        restore_from_edge(&app, false);
    }
    // 换了笔记文件夹或备份位置,今天就在新地方重新判断要不要备份
    if new.notes_dir != old.notes_dir
        || new.backup_dir != old.backup_dir
        || new.backup_enabled != old.backup_enabled
    {
        state.backup_day.lock().unwrap().clear();
    }
    *state.settings.lock().unwrap() = new.clone();
    persist_settings(&app);
    Ok(new)
}

/// 设置里录新热键时先停用全局热键,否则按下现在的热键会把窗口藏起来
#[tauri::command]
fn pause_hotkey(app: AppHandle) {
    let _ = app.global_shortcut().unregister_all();
    app.state::<AppState>()
        .hotkey_paused
        .store(true, Ordering::SeqCst);
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
async fn pick_folder(app: AppHandle, title: Option<String>) -> Option<String> {
    let title = title.unwrap_or_else(|| "选择文件夹".into());
    let mut dialog = app.dialog().file().set_title(title);
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
fn show_window(app: AppHandle) {
    show_main(&app);
}

#[tauri::command]
fn expand_edge(app: AppHandle) {
    restore_from_edge(&app, true);
}

#[tauri::command]
fn open_notes_dir(app: AppHandle) -> Result<(), String> {
    let dir = current_notes_dir(&app);
    tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_link(url: String) -> Result<(), String> {
    let lower = url.to_lowercase();
    if !(lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:"))
    {
        return Err("只能打开网页链接".into());
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    persist_settings(&app);
    app.exit(0);
}

#[tauri::command]
fn quit_ack(app: AppHandle, id: u64) -> bool {
    let state = app.state::<AppState>();
    let mut quit = state.quit.lock().unwrap();
    if quit.active == Some(id) && quit.waiting_ack {
        quit.waiting_ack = false;
        true
    } else {
        false
    }
}

#[tauri::command]
fn quit_cancel(app: AppHandle, id: u64) {
    let state = app.state::<AppState>();
    let mut quit = state.quit.lock().unwrap();
    if quit.active == Some(id) && !quit.waiting_ack {
        quit.active = None;
    }
}

// 只在前端完全没有确认收到消息时，才由系统原生对话框接管退出。
fn request_tray_quit(app: &AppHandle) {
    let state = app.state::<AppState>();
    let id = {
        let mut quit = state.quit.lock().unwrap();
        if quit.active.is_some() {
            return;
        }
        let id = state.quit_sequence.fetch_add(1, Ordering::SeqCst) + 1;
        quit.active = Some(id);
        quit.waiting_ack = true;
        id
    };
    let _ = app.emit("before-quit", id);
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(10));
        let state = handle.state::<AppState>();
        {
            let mut quit = state.quit.lock().unwrap();
            if quit.active != Some(id) || !quit.waiting_ack {
                return;
            }
            quit.waiting_ack = false;
        }
        let dialog_app = handle.clone();
        handle
            .dialog()
            .message("程序没有响应，仍要退出吗？尚未保存的笔记可能丢失。")
            .title("Minipad Next")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "仍要退出".into(),
                "取消".into(),
            ))
            .show(move |confirmed| {
                if confirmed {
                    quit_app(dialog_app);
                } else {
                    let state = dialog_app.state::<AppState>();
                    state.quit.lock().unwrap().active = None;
                    show_main(&dialog_app);
                }
            });
    });
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
        app.state::<AppState>()
            .typing
            .store(false, Ordering::SeqCst);
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
    let edge_hidden = app
        .state::<AppState>()
        .edge
        .lock()
        .unwrap()
        .hidden
        .is_some();
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
    let Some(rect) = window_rect(&win) else {
        return;
    };
    let (x, y) = edge::shown_position(edge, rect, mon);
    let _ = win.set_position(PhysicalPosition::new(x, y));
    let _ = app.emit("edge-shown", ());
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
        let show_button = st.settings.lock().unwrap().edge_expand_button;
        let (x, y) = if show_button {
            edge::hidden_position_with_strip(edge, rect, mon, edge::BUTTON_STRIP)
        } else {
            edge::hidden_position(edge, rect, mon)
        };
        let _ = app.emit("flush", ());
        let _ = app.emit("edge-hidden", edge.name());
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
}

/// 启动时恢复上次的位置和大小;如果那个位置已经不在任何显示器上就居中
fn apply_saved_geometry(win: &WebviewWindow, g: &Geom) {
    let monitors = win.available_monitors().unwrap_or_default();
    let visible = monitors.iter().any(|m| {
        let r = monitor_rect(m);
        g.x + 40 < r.x + r.w
            && g.x + g.w as i32 - 40 > r.x
            && g.y >= r.y - 4
            && g.y + 30 < r.y + r.h
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
            book_exists,
            save_note,
            create_note,
            rename_note,
            delete_note,
            move_note,
            save_meta,
            create_book,
            rename_book,
            delete_book,
            set_current_book,
            backup_info,
            open_backup_dir,
            save_settings,
            pause_hotkey,
            resume_hotkey,
            note_activity,
            pick_folder,
            hide_window,
            show_window,
            expand_edge,
            open_notes_dir,
            open_link,
            quit_app,
            quit_ack,
            quit_cancel
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            migrate_old_data(&handle);
            let (mut settings, write_allowed, read_error) = load_settings(&handle);
            if let Some(e) = &read_error {
                eprintln!("{e}；本次运行使用默认值，禁止自动覆盖 settings.json");
            }
            // 首次解析默认目录时可能把旧数据安全复制到 EXE 同级。
            // 配置损坏/暂时不可读时，运行中可使用默认目录，但不得将其写回配置文件。
            let default_notes = notes_dir(&handle, &settings);
            let default_backups = backup_dir(&handle, &settings);
            let pinned = pin_default_storage(&mut settings, &default_notes, &default_backups);
            notes::cleanup_stale_temps(&notes_dir(&handle, &settings));
            {
                let st = handle.state::<AppState>();
                st.settings_write_allowed.store(write_allowed, Ordering::SeqCst);
                *st.settings_read_error.lock().unwrap() = read_error;
                *st.settings.lock().unwrap() = settings.clone();
                *st.geom.lock().unwrap() = settings.window.clone();
                if pinned && write_allowed {
                    if let Err(e) = write_settings_if_allowed(&config_path(&handle), &settings, true) {
                        eprintln!("无法记住迁移后的存储路径: {e}");
                    }
                }
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
            let open_dir =
                MenuItem::with_id(app, "open_dir", "打开笔记文件夹", true, None::<&str>)?;
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
                        request_tray_quit(app);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_read_states_distinguish_missing_valid_corrupt_and_unreadable() {
        let root = notes::temp_dir("settings-read-guard");
        let path = root.join("settings.json");

        let (missing, can_write, err) = decode_settings_result(fs::read(&path));
        assert!(can_write);
        assert!(err.is_none());
        assert_eq!(missing.hotkey, "Ctrl+M");

        let original = r#"{"hotkey":"Ctrl+Alt+M","notes_dir":"D:\\\\custom","theme":"dark"}"#;
        fs::write(&path, original).unwrap();
        let (loaded, can_write, err) = decode_settings_result(fs::read(&path));
        assert!(can_write);
        assert!(err.is_none());
        assert_eq!(loaded.hotkey, "Ctrl+Alt+M");
        assert_eq!(loaded.theme, "dark");

        let corrupt = b"{\"hotkey\": ".to_vec();
        fs::write(&path, &corrupt).unwrap();
        let (fallback, can_write, err) = decode_settings_result(fs::read(&path));
        assert!(!can_write);
        assert!(err.unwrap().contains("解析失败"));
        write_settings_if_allowed(&path, &fallback, can_write).unwrap();
        assert_eq!(fs::read(&path).unwrap(), corrupt);

        let (fallback, can_write, err) = decode_settings_result(Err(
            std::io::Error::new(std::io::ErrorKind::PermissionDenied, "模拟杀毒软件占用"),
        ));
        assert!(!can_write);
        assert!(err.unwrap().contains("读取失败"));
        write_settings_if_allowed(&path, &fallback, can_write).unwrap();
        assert_eq!(fs::read(&path).unwrap(), corrupt);

        // 恢复为合法 JSON 后，下次启动可继续读取自定义位置。
        fs::write(&path, original).unwrap();
        let (recovered, can_write, err) = decode_settings_result(fs::read(&path));
        assert!(can_write);
        assert!(err.is_none());
        assert_eq!(recovered.notes_dir, "D:\\\\custom");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unreadable_settings_never_get_pinned_back_to_disk() {
        let root = notes::temp_dir("settings-guarded-pin");
        let path = root.join("settings.json");
        let damaged = b"old settings must survive";
        fs::write(&path, damaged).unwrap();
        let (mut fallback, can_write, _) = decode_settings_result(fs::read(&path));
        let pinned = pin_default_storage(
            &mut fallback,
            &root.join("installed").join("notes"),
            &root.join("installed").join("backups"),
        );
        assert!(pinned);
        assert!(!can_write);
        write_settings_if_allowed(&path, &fallback, can_write).unwrap();
        assert_eq!(fs::read(&path).unwrap(), damaged);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn old_settings_get_the_new_defaults() {
        // 0.2.1 的设置文件里还没有行号和日期格式
        let json = r#"{
            "hotkey": "Ctrl+Alt+M",
            "always_on_top": false,
            "edge_hide": true,
            "show_in_taskbar": true,
            "autostart": false,
            "theme": "dark",
            "font_size": 16,
            "notes_dir": "D:\\笔记",
            "backup_enabled": false,
            "backup_keep": 30,
            "backup_dir": "",
            "window": { "x": 10, "y": 20, "w": 500, "h": 600 }
        }"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        assert!(!s.line_numbers);
        assert!(s.code_line_numbers);
        assert_eq!(s.date_format, DEFAULT_DATE_FORMAT);
        assert_eq!(s.hotkey, "Ctrl+Alt+M");
        assert!(!s.always_on_top && s.show_in_taskbar && !s.backup_enabled);
        assert_eq!((s.theme.as_str(), s.font_size), ("dark", 16));
        assert_eq!(s.notes_dir, "D:\\笔记");
        assert_eq!(s.backup_keep, 30);
        let g = s.window.unwrap();
        assert_eq!((g.x, g.y, g.w, g.h), (10, 20, 500, 600));
    }

    #[test]
    fn tidy_settings_trims_and_limits() {
        let mut s = Settings {
            hotkey: " Ctrl+M ".into(),
            notes_dir: "  D:\\笔记 ".into(),
            backup_dir: " ".into(),
            backup_keep: 0,
            date_format: "  yyyy-MM-dd  ".into(),
            ..Settings::default()
        };
        tidy_settings(&mut s);
        assert_eq!(s.hotkey, "Ctrl+M");
        assert_eq!(s.notes_dir, "D:\\笔记");
        assert_eq!(s.backup_dir, "");
        assert_eq!(s.backup_keep, 1);
        assert_eq!(s.date_format, "yyyy-MM-dd");

        s.backup_keep = 1000;
        s.date_format = " \t ".into();
        tidy_settings(&mut s);
        assert_eq!(s.backup_keep, 365);
        assert_eq!(s.date_format, DEFAULT_DATE_FORMAT);

        // 按字截断,不会把中文切坏;截断后末尾的空格也去掉
        s.date_format = "年月日".repeat(30);
        tidy_settings(&mut s);
        assert_eq!(s.date_format, format!("{}年", "年月日".repeat(21)));
        s.date_format = format!("{} H:mm", "年".repeat(63));
        tidy_settings(&mut s);
        assert_eq!(s.date_format, "年".repeat(63));
    }

    #[test]
    fn tidy_settings_falls_back_to_the_top_line_for_unknown_tab_styles() {
        for (given, kept) in [
            ("line", "line"),
            ("fill", "fill"),
            ("border", "border"),
            ("", "line"),
            ("glow", "line"),
        ] {
            let mut s = Settings {
                tab_style: given.into(),
                ..Settings::default()
            };
            tidy_settings(&mut s);
            assert_eq!(s.tab_style, kept, "{given}");
        }
    }

    #[test]
    fn tidy_settings_keeps_only_plain_accent_values() {
        let mut s = Settings::default();
        for ok in [
            "",
            "#3b82f6",
            "linear-gradient(135deg, #ff5f6d, #ffa94d, #f5d142)",
        ] {
            s.accent = format!("  {ok} ");
            tidy_settings(&mut s);
            assert_eq!(s.accent, ok);
        }
        let long = "#".repeat(200);
        for bad in [
            "url(javascript:x)",
            "red; background: url(x)",
            long.as_str(),
        ] {
            s.accent = bad.to_string();
            tidy_settings(&mut s);
            assert_eq!(s.accent, "", "{bad}");
        }
    }
    #[test]
    fn hotkey_failure_prevents_folder_copy() {
        use std::cell::{Cell, RefCell};
        let events = RefCell::new(Vec::new());
        let copied = Cell::new(false);
        let error = apply_settings_side_effects(
            true,
            true,
            true,
            |new| {
                events
                    .borrow_mut()
                    .push(if new { "new-hotkey" } else { "old-hotkey" });
                if new {
                    Err("快捷键被占用".into())
                } else {
                    Ok(())
                }
            },
            |enabled| {
                events.borrow_mut().push(if enabled {
                    "autostart-on"
                } else {
                    "autostart-off"
                });
                Ok(())
            },
            || {
                copied.set(true);
                Ok(())
            },
        )
        .unwrap_err();
        assert!(error.contains("快捷键被占用"));
        assert_eq!(*events.borrow(), ["new-hotkey", "old-hotkey"]);
        assert!(!copied.get());
    }

    #[test]
    fn autostart_failure_does_not_copy_and_restores_hotkey() {
        use std::cell::{Cell, RefCell};
        let events = RefCell::new(Vec::new());
        let copied = Cell::new(false);
        let error = apply_settings_side_effects(
            true,
            true,
            true,
            |new| {
                events
                    .borrow_mut()
                    .push(if new { "new-hotkey" } else { "old-hotkey" });
                Ok(())
            },
            |enabled| {
                events.borrow_mut().push(if enabled {
                    "autostart-on"
                } else {
                    "autostart-off"
                });
                Err("启动设置不可用".into())
            },
            || {
                copied.set(true);
                Ok(())
            },
        )
        .unwrap_err();
        assert!(error.contains("启动设置不可用"));
        assert_eq!(
            *events.borrow(),
            ["new-hotkey", "autostart-on", "old-hotkey"]
        );
        assert!(!copied.get());
    }

    #[test]
    fn folder_copy_failure_reverts_autostart_and_hotkey() {
        use std::cell::RefCell;
        let events = RefCell::new(Vec::new());
        let root = notes::temp_dir("settings-rollback");
        let old_dir = root.join("old");
        let dest = root.join("dest");
        fs::create_dir_all(&old_dir).unwrap();
        fs::write(old_dir.join("note.md"), "old").unwrap();
        fs::create_dir_all(&dest).unwrap();
        fs::write(dest.join("occupied.md"), "no overwrite").unwrap();
        let err = apply_settings_side_effects(
            true,
            true,
            true,
            |new| {
                events
                    .borrow_mut()
                    .push(if new { "new-hotkey" } else { "old-hotkey" });
                Ok(())
            },
            |enabled| {
                events.borrow_mut().push(if enabled {
                    "autostart-on"
                } else {
                    "autostart-off"
                });
                Ok(())
            },
            || notes::copy_notes_for_switch(&old_dir, &dest),
        )
        .unwrap_err();
        assert!(err.contains("目标文件夹为空"));
        assert_eq!(
            *events.borrow(),
            ["new-hotkey", "autostart-on", "autostart-off", "old-hotkey"]
        );
        assert_eq!(
            fs::read_to_string(dest.join("occupied.md")).unwrap(),
            "no overwrite"
        );
        assert_eq!(fs::read_to_string(old_dir.join("note.md")).unwrap(), "old");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn explicit_storage_paths_survive_install_location_changes() {
        let root = notes::temp_dir("sticky-path");
        let old_install = root.join("old-app");
        let new_install = root.join("new-app");
        let stale_appdata = root.join("old-appdata");
        fs::create_dir_all(&old_install).unwrap();
        fs::create_dir_all(&new_install).unwrap();
        fs::create_dir_all(&stale_appdata).unwrap();
        fs::write(stale_appdata.join("stale.md"), "旧副本").unwrap();
        let original = preferred_storage_dir(&old_install, &stale_appdata, "notes");
        fs::write(original.join("current.md"), "最近更新").unwrap();
        let mut settings = Settings::default();
        assert!(pin_default_storage(
            &mut settings,
            &original,
            &old_install.join("backups"),
        ));
        let encoded = serde_json::to_string(&settings).unwrap();
        let reloaded: Settings = serde_json::from_str(&encoded).unwrap();
        assert!(!pin_default_storage(
            &mut reloaded.clone(),
            &new_install.join("notes"),
            &new_install.join("backups"),
        ));
        assert_eq!(PathBuf::from(reloaded.notes_dir.as_str()), original);
        assert_eq!(
            fs::read_to_string(PathBuf::from(reloaded.notes_dir.as_str()).join("current.md"))
                .unwrap(),
            "最近更新"
        );
        assert_eq!(
            reloaded.backup_dir,
            old_install.join("backups").to_string_lossy()
        );
        assert!(!new_install.join("notes").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unwritable_install_folder_falls_back_even_with_empty_notes_directory() {
        let root = notes::temp_dir("readonly-install");
        let program = root.join("installed");
        let legacy = root.join("appdata");
        fs::create_dir_all(program.join("notes")).unwrap();
        fs::create_dir_all(program.join("backups")).unwrap();
        for folder in ["notes", "backups"] {
            assert_eq!(
                preferred_storage_dir_with_probe(&program, &legacy, folder, |_| false),
                legacy
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn configured_storage_paths_are_never_overwritten() {
        let mut settings = Settings {
            notes_dir: "D:\\\\notes".into(),
            backup_dir: "E:\\\\backups".into(),
            ..Settings::default()
        };
        assert!(!pin_default_storage(
            &mut settings,
            Path::new("C:/app/notes"),
            Path::new("C:/app/backups"),
        ));
        assert_eq!(settings.notes_dir, "D:\\\\notes");
        assert_eq!(settings.backup_dir, "E:\\\\backups");
    }

    #[test]
    fn default_storage_prefers_program_folder_without_losing_existing_legacy_data() {
        let root = notes::temp_dir("default-path");
        let program = root.join("program");
        let legacy = root.join("legacy-notes");
        fs::create_dir_all(&program).unwrap();
        assert_eq!(
            preferred_storage_dir(&program, &legacy, "notes"),
            program.join("notes")
        );
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("previous.md"), "old").unwrap();
        assert_eq!(
            preferred_storage_dir(&program, &legacy, "notes"),
            program.join("notes")
        );
        assert_eq!(
            fs::read_to_string(program.join("notes").join("previous.md")).unwrap(),
            "old"
        );
        assert_eq!(
            fs::read_to_string(legacy.join("previous.md")).unwrap(),
            "old"
        );
        fs::write(program.join("notes").join("new.md"), "new").unwrap();
        assert_eq!(
            preferred_storage_dir(&program, &legacy, "notes"),
            program.join("notes")
        );
        fs::remove_dir_all(root).unwrap();
    }
}
