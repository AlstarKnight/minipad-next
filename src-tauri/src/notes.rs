//! 笔记文件的读写:文件名清理、去重、编码识别、页面顺序、笔记本。
//! 这里的函数不依赖 Tauri,方便单独测试。
//!
//! 笔记文件夹里的每个子文件夹是一个笔记本,里面的 `.md` 文件是它的页面;
//! 直接放在笔记文件夹里的页面属于「默认」笔记本,程序里用空字符串表示它。
//! `.trash` 这类点开头的文件夹不算笔记本,子文件夹里再套的文件夹也不读。

use encoding_rs::{Encoding, GB18030};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub const NOTE_EXT: &str = "md";
pub const TRASH_DIR: &str = ".trash";
const META_FILE: &str = ".minipad.json";
/// 「默认」笔记本显示的名字,其他笔记本不能叫这个
pub const DEFAULT_BOOK_LABEL: &str = "默认";

/// 页面顺序、当前页面、每页的编辑/阅读模式,存在每个笔记本文件夹的 .minipad.json;
/// 笔记文件夹根目录那份还记着当前打开的是哪个笔记本
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct Meta {
    pub order: Vec<String>,
    pub active: String,
    pub modes: HashMap<String, String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub book: String,
    /// 标签分组(设置里打开分组功能才用):分组的名字、颜色、是否折叠,按出现的顺序
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<TabGroup>,
    /// 页面名 → 所在分组的 id
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub note_groups: HashMap<String, String>,
    /// 笔记本自己的顶栏图标，不设置时使用 book。
    #[serde(skip_serializing_if = "String::is_empty")]
    pub icon: String,
    /// 笔记本图标颜色，可单独自定义。
    #[serde(skip_serializing_if = "String::is_empty")]
    pub icon_color: String,
}

/// 一个标签分组。颜色是 "#rrggbb",名字可以空着(只显示颜色)
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct TabGroup {
    pub id: String,
    pub name: String,
    pub color: String,
    pub collapsed: bool,
}

/// 前端保存分组时发来的:分组列表和每页所在的分组
pub struct Groups {
    pub groups: Vec<TabGroup>,
    pub note_groups: HashMap<String, String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Note {
    pub name: String,
    pub content: String,
    pub mode: String,
    /// 内容不可读取时保留页面占位，空内容不得回写磁盘。
    pub unreadable: bool,
    pub reason: Option<String>,
    /// 所在分组的 id,不在分组里是空的
    pub group: String,
}

/// 一个笔记本和它的全部页面(按保存过的顺序)
#[derive(Serialize, Clone, Debug)]
pub struct Book {
    pub name: String,
    pub notes: Vec<Note>,
    pub active: String,
    /// 还有页面在里面的分组
    pub groups: Vec<TabGroup>,
    pub icon: String,
    pub icon_color: String,
}

pub fn write_atomic(path: &Path, data: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // 同一文件可能由不同调用方同时写入；临时文件名必须唯一。
    let seq = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let mut file_name = path.file_name().ok_or("无效的文件路径")?.to_os_string();
    file_name.push(format!(".{}.{}.tmp~", std::process::id(), seq));
    let tmp = path.with_file_name(file_name);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    let result = (|| {
        file.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        rename_with_retry(|| fs::rename(&tmp, path)).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// 杀毒软件、OneDrive、索引服务正打开着目标文件时 Windows 会暂时拒绝改名:
/// 稍等一下再试几次(临时文件一直留着),还不行才算失败
fn rename_with_retry(mut rename: impl FnMut() -> std::io::Result<()>) -> std::io::Result<()> {
    for wait in [10, 50, 100, 200] {
        match rename() {
            Err(e) if is_busy(&e) => std::thread::sleep(Duration::from_millis(wait)),
            result => return result,
        }
    }
    rename()
}

/// 文件正被别的程序占着:拒绝访问,或者 Windows 的共享冲突(32)、锁定冲突(33)
fn is_busy(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::PermissionDenied
        || (cfg!(windows) && matches!(e.raw_os_error(), Some(32 | 33)))
}

/// 启动时清理笔记文件夹和各笔记本中残留超过一小时的临时文件。
/// 只匹配本程序的临时写入后缀，不进入隐藏文件夹与更深的子目录。
pub fn cleanup_stale_temps(root: &Path) {
    let Some(cutoff) = SystemTime::now().checked_sub(Duration::from_secs(3600)) else {
        return;
    };
    let mut dirs = vec![root.to_path_buf()];
    if let Ok(books) = list_books(root) {
        dirs.extend(books.into_iter().map(|b| root.join(b)));
    }
    for dir in dirs {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".tmp~") {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if !meta.is_file() || !meta.modified().is_ok_and(|time| time < cutoff) {
                continue;
            }
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// 把名字变成合法的 Windows 文件名,清理完是空的就用 `fallback`
fn clean_name(name: &str, fallback: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let mut s = fit_name(s.trim_start());
    if s.starts_with('.') {
        s = format!("_{}", &s[1..]);
    }
    if s.is_empty() {
        s = fallback.into();
    }
    // 第一个点前面是设备名(CON.txt、aux.1 也不行)时,在设备名后面加 _
    let stem = s[..s.find('.').unwrap_or(s.len())].trim_end_matches(' ');
    if is_reserved(stem) {
        let at = stem.len();
        s.insert(at, '_');
        s = fit_name(&s);
    }
    s
}

/// 最多留 80 个字,先截短再去掉末尾的空白、点和空格:Windows 会悄悄去掉末尾的点和空格,
/// 不然建出来的文件夹和返回的名字对不上
fn fit_name(s: &str) -> String {
    let s: String = s.chars().take(80).collect();
    s.trim_end().trim_end_matches(['.', ' ']).to_string()
}

/// Windows 保留的设备名(不分大小写)
fn is_reserved(stem: &str) -> bool {
    let upper = stem.to_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&upper.as_str()) {
        return true;
    }
    let mut digit = upper.chars().skip(3);
    (upper.starts_with("COM") || upper.starts_with("LPT"))
        && matches!(
            (digit.next(), digit.next()),
            (Some('0'..='9' | '¹' | '²' | '³'), None)
        )
}

/// 把页面名变成合法的 Windows 文件名
pub fn sanitize_name(name: &str) -> String {
    clean_name(name, "新页面")
}

pub fn note_path(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{name}.{NOTE_EXT}"))
}

/// 前端传来的名字不能带路径分隔符,免得读写到笔记文件夹外面去
fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\', ':'])
        || name.chars().any(char::is_control)
    {
        return Err(format!("名字不合法:{name}"));
    }
    Ok(())
}

/// 笔记本对应的文件夹:「默认」是笔记文件夹本身,其他笔记本是它下面的子文件夹
pub fn book_dir(root: &Path, book: &str) -> Result<PathBuf, String> {
    if book.is_empty() {
        return Ok(root.to_path_buf());
    }
    check_name(book)?;
    if book.starts_with('.') {
        return Err(format!("笔记本名字不合法:{book}"));
    }
    Ok(root.join(book))
}

/// 某个笔记本里某个页面的文件
pub fn page_path(root: &Path, book: &str, name: &str) -> Result<PathBuf, String> {
    check_name(name)?;
    Ok(note_path(&book_dir(root, book)?, name))
}

fn is_note_file(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|x| x.to_str())
            .is_some_and(|x| x.eq_ignore_ascii_case(NOTE_EXT))
}

/// 一个文件夹里所有页面的名字(按名字排序)
pub fn list_names(dir: &Path) -> Result<Vec<String>, String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if is_note_file(&p) {
                p.file_stem().map(|s| s.to_string_lossy().to_string())
            } else {
                None
            }
        })
        .collect();
    names.sort();
    Ok(names)
}

/// 笔记文件夹下的笔记本(子文件夹,点开头的除外),按名字排序
pub fn list_books(root: &Path) -> Result<Vec<String>, String> {
    let mut books: Vec<String> = fs::read_dir(root)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| !n.starts_with('.'))
        .collect();
    books.sort();
    Ok(books)
}

/// `base` 没被占用就用它,否则依次试 "base (2)"、"base (3)"……
fn first_free(base: String, taken: impl Fn(&str) -> bool) -> String {
    if !taken(&base) {
        return base;
    }
    (2..)
        .map(|i| format!("{base} ({i})"))
        .find(|n| !taken(n))
        .unwrap()
}

/// 生成一个不和已有页面(以及同名的文件夹等)重名的名字;`except` 是重命名时的原名,不算冲突。
/// 列不出已有的页面就报错,免得挑中一个已经有的名字
pub fn unique_name(dir: &Path, base: &str, except: Option<&str>) -> Result<String, String> {
    // Windows 文件名不区分大小写,这里也按不区分处理
    let except = except.map(|e| e.to_lowercase());
    let existing: Vec<String> = list_names(dir)?
        .into_iter()
        .map(|n| n.to_lowercase())
        .collect();
    Ok(first_free(sanitize_name(base), |n| {
        let lower = n.to_lowercase();
        Some(&lower) != except.as_ref() && (existing.contains(&lower) || note_path(dir, n).exists())
    }))
}

/// 新建一个空页面,返回实际用的名字。用 create_new 建文件,绝不会把已有的页面清空:
/// 挑好的名字刚好被占了(比如网盘同步刚放进来一个同名文件)就换下一个再试
pub fn create_note(dir: &Path, base: &str) -> Result<String, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    for _ in 0..5 {
        let name = unique_name(dir, base, None)?;
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(note_path(dir, &name))
        {
            Ok(_) => return Ok(name),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(format!("新建页面「{name}」失败:{e}")),
        }
    }
    Err("新建页面失败:挑好的名字一直被占用,请稍后再试".into())
}

/// 页面改名,返回实际用的名字(和别的页面重名时加编号;只改大小写不算重名)
pub fn rename_note(root: &Path, book: &str, old: &str, new: &str) -> Result<String, String> {
    let src = page_path(root, book, old)?;
    let dir = book_dir(root, book)?;
    let new = unique_name(&dir, new, Some(old))?;
    if new != old {
        fs::rename(src, note_path(&dir, &new)).map_err(|e| e.to_string())?;
    }
    Ok(new)
}

/// 生成一个不和已有笔记本(以及同名文件)冲突的笔记本名;「默认」留给根目录
pub fn unique_book_name(root: &Path, base: &str, except: Option<&str>) -> String {
    let except = except.map(|e| e.to_lowercase());
    let existing: Vec<String> = fs::read_dir(root)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.file_name().to_string_lossy().to_lowercase())
                .collect()
        })
        .unwrap_or_default();
    first_free(clean_name(base, "新笔记本"), |n| {
        let n = n.to_lowercase();
        n == DEFAULT_BOOK_LABEL || (Some(&n) != except.as_ref() && existing.contains(&n))
    })
}

/// 把文件内容解码成文本:认得 UTF-8 / UTF-16 的 BOM;不是合法 UTF-8 时按 GB18030(兼容 GBK)解码,
/// 这样从老软件里拷过来的中文 txt 也不会乱码;只坏了零星几处的 UTF-8 仍按 UTF-8 解。换行统一成 \n。
/// 第二个值表示有没有认不出来、被换成 � 的字节。
fn decode(bytes: &[u8]) -> (String, bool) {
    let (text, lossy) = if let Some((encoding, bom_len)) = Encoding::for_bom(bytes) {
        let (text, lossy) = encoding.decode_without_bom_handling(&bytes[bom_len..]);
        (text.into_owned(), lossy)
    } else {
        match std::str::from_utf8(bytes) {
            Ok(s) => (s.to_owned(), false),
            Err(_) if damaged_utf8(bytes) => (String::from_utf8_lossy(bytes).into_owned(), true),
            Err(_) => {
                let (text, lossy) = GB18030.decode_without_bom_handling(bytes);
                (text.into_owned(), lossy)
            }
        }
    };
    let text = if text.contains('\r') {
        text.replace("\r\n", "\n")
    } else {
        text
    };
    (text, lossy)
}

/// 大部分是合法的 UTF-8(非 ASCII 的字至少是坏处的 3 倍),只是混进了几个坏字节,
/// 比如同步时截断了半个字:这是损坏的 UTF-8,不是 GBK
fn damaged_utf8(bytes: &[u8]) -> bool {
    let (mut valid, mut invalid) = (0, 0);
    for chunk in bytes.utf8_chunks() {
        valid += chunk.valid().chars().filter(|c| !c.is_ascii()).count();
        invalid += usize::from(!chunk.invalid().is_empty());
    }
    valid >= 3 * invalid
}

/// 解码文件内容,认不出来的字节换成 �(设置、元信息、minipad2 的文件用)
pub fn decode_text(bytes: &[u8]) -> String {
    decode(bytes).0
}

/// 解码有损失就不要:这样的页面编辑后会把乱码存回去
fn decode_text_checked(bytes: &[u8]) -> Option<String> {
    let (text, lossy) = decode(bytes);
    (!lossy).then_some(text)
}

/// 冲突副本的名字,比如「周报 (冲突 2026-10-12 18.30)」;原名太长时截短,保证后缀完整
pub fn conflict_name(name: &str, stamp: &str) -> String {
    let suffix = format!(" (冲突 {stamp})");
    let room = 80usize.saturating_sub(suffix.chars().count());
    let base: String = name.chars().take(room).collect();
    format!("{}{suffix}", base.trim_end())
}

/// 页面文件现在的内容 `current` 既不是上次读到的 `expected`,也不是要写的 `content`,说明在别处被改过:
/// 把它另存成同一个笔记本里的冲突副本,返回副本的名字和内容。
fn save_conflict_copy(
    dir: &Path,
    name: &str,
    expected: &str,
    content: &str,
    current: String,
    stamp: &str,
) -> Result<Option<(String, String)>, String> {
    if current == expected || current == content {
        return Ok(None);
    }
    let copy = unique_name(dir, &conflict_name(name, stamp), None)?;
    write_atomic(&note_path(dir, &copy), &current)
        .map_err(|e| format!("「{name}」在别处也被修改了,但另存那边的版本失败:{e}"))?;
    Ok(Some((copy, current)))
}

/// 保存页面,文件里已经是这些内容就不再写。`expected` 是前端上次从磁盘读到(或写进去)的内容:
/// `keep_both` 时如果文件在别处被改过,先把那边的版本另存成冲突副本(返回它的名字和内容)再写。
/// 文件不在了就没什么可留的,照常保存;读不出来就没法确认,先不保存(直接覆盖时照常写)。
pub fn save_page(
    root: &Path,
    book: &str,
    name: &str,
    content: &str,
    expected: Option<&str>,
    keep_both: bool,
    stamp: &str,
) -> Result<Option<(String, String)>, String> {
    let path = page_path(root, book, name)?;
    let expected = expected.filter(|_| keep_both);
    let current = match fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) if expected.is_some() => {
            return Err(format!(
                "无法确认「{name}」有没有在别处被修改，暂不保存:{e}"
            ))
        }
        Err(_) => None,
    };
    if current.as_deref() == Some(content.as_bytes()) {
        return Ok(None);
    }
    let conflict = match (expected, current) {
        (Some(expected), Some(bytes)) => save_conflict_copy(
            &book_dir(root, book)?,
            name,
            expected,
            content,
            decode_text(&bytes),
            stamp,
        )?,
        _ => None,
    };
    write_atomic(&path, content).map_err(|e| format!("保存「{name}」失败:{e}"))?;
    Ok(conflict)
}

pub fn read_note(dir: &Path, name: &str) -> Result<String, String> {
    let bytes =
        fs::read(note_path(dir, name)).map_err(|e| format!("无法读取笔记「{name}」: {e}"))?;
    decode_text_checked(&bytes).ok_or_else(|| {
        format!("笔记「{name}」里有无法识别的字节(文件可能已损坏),为免乱码写回原文件,暂不打开")
    })
}

/// 只用来显示的读取:读不出来或者内容损坏都当成没有
pub fn read_meta(dir: &Path) -> Meta {
    fs::read(dir.join(META_FILE))
        .ok()
        .and_then(|b| serde_json::from_str(&decode_text(&b)).ok())
        .unwrap_or_default()
}

/// 改写 .minipad.json 之前读它:不存在就从默认值开始;读不出来就报错,免得拿默认值把图标、分组、
/// 当前笔记本这些覆盖掉;内容损坏就把原文件改名留底(.minipad.json.bad-<秒数>),再从默认值开始
fn read_meta_strict(dir: &Path) -> Result<Meta, String> {
    let path = dir.join(META_FILE);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Meta::default()),
        Err(e) => return Err(format!("笔记本元信息读取失败:{e}")),
    };
    if let Ok(meta) = serde_json::from_str(&decode_text(&bytes)) {
        return Ok(meta);
    }
    let bad = free_path(dir, &format!("{META_FILE}.bad-{}", stamp()), "");
    fs::rename(&path, bad).map_err(|e| format!("笔记本元信息损坏，另存原文件失败:{e}"))?;
    Ok(Meta::default())
}

pub fn write_meta(dir: &Path, meta: &Meta) -> Result<(), String> {
    let json = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    write_atomic(&dir.join(META_FILE), &json)
}

/// 按保存过的顺序排列页面,新出现的文件排在后面
pub fn order_names(names: &[String], saved: &[String]) -> Vec<String> {
    let mut ordered: Vec<String> = saved
        .iter()
        .filter(|n| names.contains(n))
        .cloned()
        .collect();
    for n in names {
        if !ordered.contains(n) {
            ordered.push(n.clone());
        }
    }
    ordered
}

/// 测试可替换读取函数，确保单页失败不会影响其他页。
fn load_book_with_reader<F>(root: &Path, book: &str, mut read: F) -> Result<Book, String>
where
    F: FnMut(&Path, &str) -> Result<String, String>,
{
    let dir = book_dir(root, book)?;
    let meta = read_meta(&dir);
    let names = order_names(&list_names(&dir)?, &meta.order);
    let active = if names.contains(&meta.active) {
        meta.active.clone()
    } else {
        names.first().cloned().unwrap_or_default()
    };
    let notes: Vec<Note> = names
        .into_iter()
        .map(|name| {
            let (content, unreadable, reason) = match read(&dir, &name) {
                Ok(text) => (text, false, None),
                Err(e) => (String::new(), true, Some(e)),
            };
            Note {
                content,
                unreadable,
                reason,
                group: meta
                    .note_groups
                    .get(&name)
                    .filter(|g| meta.groups.iter().any(|x| &x.id == *g))
                    .cloned()
                    .unwrap_or_default(),
                mode: meta
                    .modes
                    .get(&name)
                    .cloned()
                    .unwrap_or_else(|| "edit".into()),
                name,
            }
        })
        .collect();
    let groups = meta
        .groups
        .iter()
        .filter(|g| notes.iter().any(|n| n.group == g.id))
        .cloned()
        .collect();
    Ok(Book {
        name: book.to_string(),
        notes,
        active,
        groups,
        icon: meta.icon,
        icon_color: meta.icon_color,
    })
}

/// 读出一个笔记本；个别页面无法读取时仍将其保留为不可编辑的占位。
pub fn load_book(root: &Path, book: &str) -> Result<Book, String> {
    load_book_with_reader(root, book, read_note)
}

/// 无法读取的子笔记本跳过，不阻断其余笔记本；前端同步必须保留暂时缺失的笔记本。
pub fn load_books(root: &Path) -> Result<Vec<Book>, String> {
    let mut books = vec![load_book(root, "")?];
    for name in list_books(root)? {
        if let Ok(book) = load_book(root, &name) {
            books.push(book);
        }
    }
    Ok(books)
}

/// 保存一个笔记本的页面顺序、当前页面、模式和分组(groups 是 None 时分组保持原样)。
/// 笔记本已经不在了就不写,免得把删掉的文件夹又建出来。
pub fn save_book_meta(
    root: &Path,
    book: &str,
    order: Vec<String>,
    active: String,
    modes: HashMap<String, String>,
    groups: Option<Groups>,
) -> Result<(), String> {
    let dir = book_dir(root, book)?;
    if !dir.is_dir() {
        return Ok(());
    }
    let mut meta = read_meta_strict(&dir)?;
    meta.order = order;
    meta.active = active;
    meta.modes = modes;
    if let Some(g) = groups {
        // 只记还有页面的分组,页面也只记在分组里的
        let note_groups: HashMap<String, String> = g
            .note_groups
            .into_iter()
            .filter(|(n, id)| {
                !id.is_empty() && meta.order.contains(n) && g.groups.iter().any(|x| &x.id == id)
            })
            .collect();
        meta.groups = g
            .groups
            .into_iter()
            .filter(|x| !x.id.is_empty() && note_groups.values().any(|id| id == &x.id))
            .collect();
        meta.note_groups = note_groups;
    }
    write_meta(&dir, &meta)
}

/// 仅接受纯色或与应用强调色一致的安全渐变写法，绝不信任任意 CSS。
pub fn normalized_book_color(value: &str) -> Option<String> {
    let value = value.trim();
    let valid_hex = |s: &str| {
        s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
    };
    if valid_hex(value) {
        return Some(value.to_ascii_lowercase());
    }
    let body = value.strip_prefix("linear-gradient(")?.strip_suffix(')')?;
    let (degrees, colors) = body.split_once("deg,")?;
    let degrees = degrees.trim().parse::<u16>().ok()?;
    if degrees > 360 {
        return None;
    }
    let raw_stops: Vec<_> = colors.split(',').map(str::trim).collect();
    if !(2..=7).contains(&raw_stops.len()) {
        return None;
    }
    let mut stops = Vec::new();
    let mut positions = Vec::new();
    for stop in raw_stops {
        let words: Vec<_> = stop.split_whitespace().collect();
        if words.is_empty() || words.len() > 2 || !valid_hex(words[0]) {
            return None;
        }
        let pos = if words.len() == 2 {
            let digits = words[1].strip_suffix('%')?;
            let value = digits.parse::<u8>().ok()?;
            if value > 100 {
                return None;
            }
            Some(value)
        } else {
            None
        };
        positions.push(pos);
        stops.push(words[0].to_ascii_lowercase());
    }
    if positions.iter().any(Option::is_some) {
        if positions.iter().any(Option::is_none) {
            return None;
        }
        let values: Vec<_> = positions.iter().map(|v| v.unwrap_or(0)).collect();
        if values.windows(2).any(|w| w[0] > w[1]) {
            return None;
        }
        for (stop, percent) in stops.iter_mut().zip(values) {
            *stop = format!("{stop} {percent}%");
        }
    }
    Some(format!(
        "linear-gradient({degrees}deg, {})",
        stops.join(", ")
    ))
}

/// 笔记本图标与颜色独立保存在对应的 .minipad.json，改页面顺序不会覆盖它。
pub fn set_book_appearance(root: &Path, book: &str, icon: &str, color: &str) -> Result<(), String> {
    const ICONS: [&str; 8] = [
        "book",
        "folder",
        "briefcase",
        "heart",
        "star",
        "lightbulb",
        "code",
        "bookmark",
    ];
    if !ICONS.contains(&icon) {
        return Err("不支持的笔记本图标".into());
    }
    let normalized = if color.is_empty() {
        String::new()
    } else {
        normalized_book_color(color)
            .ok_or("图标颜色必须是 #RRGGBB 或有效的 linear-gradient 渐变")?
    };
    let dir = book_dir(root, book)?;
    if !dir.is_dir() {
        return Err(format!(
            "笔记本不存在:{}",
            if book.is_empty() { "默认" } else { book }
        ));
    }
    // 外观更改不能在元文件暂时不可读时把页面排序等内容覆盖为默认值。
    let mut meta = read_meta_strict(&dir)?;
    meta.icon = if icon == "book" {
        String::new()
    } else {
        icon.into()
    };
    meta.icon_color = normalized;
    write_meta(&dir, &meta)
}

/// 记住当前打开的笔记本
pub fn set_current_book(root: &Path, book: &str) -> Result<(), String> {
    let mut meta = read_meta_strict(root)?;
    if meta.book != book {
        meta.book = book.to_string();
        write_meta(root, &meta)?;
    }
    Ok(())
}

/// 新建笔记本(子文件夹),返回实际用的名字
pub fn create_book(root: &Path, name: &str) -> Result<String, String> {
    let name = unique_book_name(root, name, None);
    fs::create_dir_all(root.join(&name)).map_err(|e| e.to_string())?;
    Ok(name)
}

/// 笔记本改名(就是给文件夹改名),返回实际用的名字
pub fn rename_book(root: &Path, old: &str, new: &str) -> Result<String, String> {
    if old.is_empty() {
        return Err(format!("「{DEFAULT_BOOK_LABEL}」笔记本不能改名"));
    }
    let src = book_dir(root, old)?;
    let new = unique_book_name(root, new, Some(old));
    if new != old {
        fs::rename(&src, root.join(&new)).map_err(|e| e.to_string())?;
        if read_meta(root).book == old {
            set_current_book(root, &new)?;
        }
    }
    Ok(new)
}

/// 删除笔记本:整个文件夹移到 .trash 里,文件夹名加上时间戳
pub fn delete_book(root: &Path, name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err(format!("「{DEFAULT_BOOK_LABEL}」笔记本不能删除"));
    }
    let src = book_dir(root, name)?;
    if !src.exists() {
        return Ok(());
    }
    let trash = root.join(TRASH_DIR);
    fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    let dst = free_path(&trash, &format!("{name}.{}", stamp()), "");
    fs::rename(&src, dst).map_err(|e| e.to_string())?;
    if read_meta(root).book == name {
        set_current_book(root, "")?;
    }
    Ok(())
}

/// 把页面移到另一个笔记本,那边有同名页面时自动改名,返回页面在那边的名字
pub fn move_note(root: &Path, book: &str, name: &str, target: &str) -> Result<String, String> {
    let src = page_path(root, book, name)?;
    let dir = book_dir(root, target)?;
    if book == target {
        return Ok(name.to_string());
    }
    if !src.exists() {
        return Err(format!("找不到页面「{name}」"));
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let new = unique_name(&dir, name, None)?;
    fs::rename(&src, note_path(&dir, &new)).map_err(|e| e.to_string())?;
    Ok(new)
}

fn stamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `dir` 里一个还没被占用的路径:`{stem}{ext}`,已经有了就加 " (2)"、" (3)"……
fn free_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let name = first_free(stem.to_string(), |n| dir.join(format!("{n}{ext}")).exists());
    dir.join(format!("{name}{ext}"))
}

/// 删除页面:移到笔记文件夹的 .trash 里(其他笔记本的页面放在 .trash 下同名的文件夹里),文件名加上时间戳
pub fn move_to_trash(root: &Path, book: &str, name: &str) -> Result<(), String> {
    let src = page_path(root, book, name)?;
    if !src.exists() {
        return Ok(());
    }
    let trash = root.join(TRASH_DIR).join(book);
    fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    let dst = free_path(
        &trash,
        &format!("{name}.{}", stamp()),
        &format!(".{NOTE_EXT}"),
    );
    fs::rename(&src, dst).map_err(|e| e.to_string())
}

/// 把 `old` 搬到 `new`(新位置已经有东西时不动)。能直接改名就改名,不行就复制一份,旧的留着当备份。
/// 返回是否搬过。
pub fn migrate_path(old: &Path, new: &Path) -> Result<bool, String> {
    if new.exists() || !old.exists() {
        return Ok(false);
    }
    if let Some(parent) = new.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if fs::rename(old, new).is_ok() {
        return Ok(true);
    }
    copy_into_place(old, new)?;
    Ok(true)
}

/// 先复制到 `new` 旁边的临时位置,完整复制完才改成 `new`:中途失败不会留下半截的数据,
/// 免得下次启动看到 `new` 已经有了就当成真的。失败时删掉临时副本。文件和文件夹都行。
fn copy_into_place(old: &Path, new: &Path) -> Result<(), String> {
    let seq = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let mut name = new.file_name().ok_or("无效的路径")?.to_os_string();
    name.push(format!(".{}.{seq}.tmp~", std::process::id()));
    let tmp = new.with_file_name(name);
    let result =
        copy_recursive(old, &tmp).and_then(|()| fs::rename(&tmp, new).map_err(|e| e.to_string()));
    if result.is_err() {
        let _ = if old.is_dir() {
            fs::remove_dir_all(&tmp)
        } else {
            fs::remove_file(&tmp)
        };
    }
    result
}

/// 更换笔记目录时安全复制全部内容。新目录必须为空，源目录会保留以便恢复。
/// 在目标目录同级先写临时目录，只有完全复制成功才切换到目标目录。
pub fn copy_notes_for_switch(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.is_dir() {
        return Err(format!("原笔记目录不存在:{}", source.display()));
    }
    let parent = destination.parent().ok_or("目标路径无效")?;
    fs::create_dir_all(parent).map_err(|e| format!("无法建立目标目录的上级文件夹:{e}"))?;
    let source_abs = fs::canonicalize(source).map_err(|e| e.to_string())?;
    let dest_abs = if destination.exists() {
        fs::canonicalize(destination).map_err(|e| e.to_string())?
    } else {
        fs::canonicalize(parent)
            .map_err(|e| e.to_string())?
            .join(destination.file_name().ok_or("目标路径无效")?)
    };
    if dest_abs.starts_with(&source_abs) || source_abs.starts_with(&dest_abs) {
        return Err("新旧笔记文件夹不能互相包含".into());
    }
    if destination.exists()
        && (!destination.is_dir()
            || fs::read_dir(destination)
                .map_err(|e| format!("无法检查目标目录:{e}"))?
                .next()
                .is_some())
    {
        return Err("迁移要求目标文件夹为空；如果要使用已有笔记文件夹，请取消勾选迁移".into());
    }
    let seq = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let stage = parent.join(format!(".minipad-copy-{}-{seq}", std::process::id()));
    if stage.exists() {
        return Err("迁移临时目录已存在，请重试".into());
    }
    if let Err(e) = copy_recursive(source, &stage) {
        let _ = fs::remove_dir_all(&stage);
        return Err(format!("笔记迁移失败，原笔记保留:{e}"));
    }
    let result = (|| {
        if destination.exists() {
            fs::remove_dir(destination).map_err(|e| format!("目标目录已变化:{e}"))?;
        }
        fs::rename(&stage, destination).map_err(|e| format!("完成迁移失败:{e}"))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&stage);
    }
    result
}

fn copy_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if src.is_dir() {
        fs::create_dir_all(dst).map_err(|e| e.to_string())?;
        for entry in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(src, dst).map(|_| ()).map_err(|e| e.to_string())
    }
}

/// 测试用的临时文件夹,每个测试一个
#[cfg(test)]
pub fn temp_dir(tag: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir =
        std::env::temp_dir().join(format!("minipad-test-{tag}-{}-{stamp}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(book: &Book) -> Vec<&str> {
        book.notes.iter().map(|n| n.name.as_str()).collect()
    }

    fn trash_entries(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn sanitize_replaces_illegal_characters() {
        assert_eq!(
            sanitize_name("a/b\\c:d*e?f\"g<h>i|j"),
            "a_b_c_d_e_f_g_h_i_j"
        );
        assert_eq!(sanitize_name("  标题.  "), "标题");
        assert_eq!(sanitize_name(".hidden"), "_hidden");
        assert_eq!(sanitize_name("   "), "新页面");
        assert_eq!(sanitize_name("con"), "con_");
        assert_eq!(sanitize_name("COM1"), "COM1_");
        assert_eq!(sanitize_name("COMMA"), "COMMA");
        assert_eq!(sanitize_name(&"长".repeat(100)).chars().count(), 80);
    }

    #[test]
    fn names_stay_valid_on_windows_after_truncation_and_with_extensions() {
        for (given, kept) in [
            ("CON.txt", "CON_.txt"),
            ("aux.1", "aux_.1"),
            ("nul", "nul_"),
            ("Nul  ", "Nul_"),
            ("CON .txt", "CON_ .txt"),
            ("conin$", "conin$_"),
            ("CONOUT$.log", "CONOUT$_.log"),
            ("COM¹", "COM¹_"),
            ("lpt3.md", "lpt3_.md"),
            ("LPT0", "LPT0_"),
            ("COMMA.txt", "COMMA.txt"),
            ("COM10", "COM10"),
            ("CONSOLE", "CONSOLE"),
            ("我的CON", "我的CON"),
        ] {
            assert_eq!(sanitize_name(given), kept, "{given}");
        }
        // 先截短再去掉末尾的点和空格,文件夹名和返回的名字才对得上
        assert_eq!(
            sanitize_name(&format!("{} b", "长".repeat(79))),
            "长".repeat(79)
        );
        assert_eq!(
            sanitize_name(&format!("{}.b", "长".repeat(79))),
            "长".repeat(79)
        );
        let root = temp_dir("long-book");
        let name = create_book(&root, &format!("{}. x", "本".repeat(78))).unwrap();
        assert_eq!(name, "本".repeat(78));
        assert!(list_books(&root).unwrap().contains(&name));
        fs::remove_dir_all(&root).unwrap();
        // 加上 _ 以后也不超过 80 个字,再清理一遍不会变
        let long = sanitize_name(&format!("CON.{}", "长".repeat(90)));
        assert!(long.starts_with("CON_."));
        assert_eq!(long.chars().count(), 80);
        assert_eq!(sanitize_name(&long), long);
    }

    #[test]
    fn unique_name_avoids_existing_pages_case_insensitively() {
        let dir = temp_dir("unique");
        fs::write(note_path(&dir, "笔记"), "").unwrap();
        fs::write(note_path(&dir, "Todo"), "").unwrap();
        assert_eq!(unique_name(&dir, "新页面", None).unwrap(), "新页面");
        assert_eq!(unique_name(&dir, "笔记", None).unwrap(), "笔记 (2)");
        assert_eq!(unique_name(&dir, "todo", None).unwrap(), "todo (2)");
        // 重命名时只改大小写,不算和自己冲突
        assert_eq!(unique_name(&dir, "TODO", Some("Todo")).unwrap(), "TODO");
        // 叫「附件.md」的文件夹不是页面,但这个名字也用不了
        fs::create_dir(note_path(&dir, "附件")).unwrap();
        assert_eq!(unique_name(&dir, "附件", None).unwrap(), "附件 (2)");
        // 列不出已有的页面:报错,不瞎挑一个
        assert!(unique_name(&dir.join("不在了"), "新页面", None).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn new_pages_never_replace_existing_files() {
        let dir = temp_dir("create-note");
        assert_eq!(create_note(&dir, "新页面").unwrap(), "新页面");
        assert_eq!(fs::read(note_path(&dir, "新页面")).unwrap(), b"");
        fs::write(note_path(&dir, "新页面"), "已经写了内容").unwrap();
        assert_eq!(create_note(&dir, "新页面").unwrap(), "新页面 (2)");
        assert_eq!(
            fs::read_to_string(note_path(&dir, "新页面")).unwrap(),
            "已经写了内容"
        );
        // 笔记本文件夹在别处被删了:和以前一样重新建出来
        let gone = dir.join("工作");
        assert_eq!(create_note(&gone, "计划").unwrap(), "计划");
        assert!(note_path(&gone, "计划").is_file());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rename_note_keeps_names_unique() {
        let root = temp_dir("rename-note");
        fs::write(note_path(&root, "周报"), "本周").unwrap();
        fs::write(note_path(&root, "计划"), "下周").unwrap();
        assert_eq!(rename_note(&root, "", "周报", "计划").unwrap(), "计划 (2)");
        assert_eq!(
            fs::read_to_string(note_path(&root, "计划 (2)")).unwrap(),
            "本周"
        );
        assert_eq!(
            fs::read_to_string(note_path(&root, "计划")).unwrap(),
            "下周"
        );
        // 只改大小写、改成清理后一样的名字都行
        fs::write(note_path(&root, "Todo"), "").unwrap();
        assert_eq!(rename_note(&root, "", "Todo", "TODO").unwrap(), "TODO");
        assert_eq!(rename_note(&root, "", "TODO", "TODO.").unwrap(), "TODO");
        assert!(note_path(&root, "TODO").is_file());
        assert!(rename_note(&root, "", "../x", "y").is_err());
        assert!(rename_note(&root, "", "没有这页", "y").is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn decode_handles_bom_utf16_and_gbk() {
        assert_eq!(decode_text("普通文本".as_bytes()), "普通文本");
        assert_eq!(decode_text(b"\xEF\xBB\xBFhello"), "hello");
        assert_eq!(decode_text(b"a\r\nb\r\n"), "a\nb\n");
        // "中文" 的 UTF-16LE,带 BOM
        assert_eq!(decode_text(&[0xFF, 0xFE, 0x2D, 0x4E, 0x87, 0x65]), "中文");
        // "中文笔记" 的 GBK 编码
        let gbk = [0xD6, 0xD0, 0xCE, 0xC4, 0xB1, 0xCA, 0xBC, 0xC7];
        assert_eq!(decode_text(&gbk), "中文笔记");
    }

    #[test]
    fn decoding_damage_keeps_the_page_from_being_edited() {
        let dir = temp_dir("lossy");
        // UTF-8 的中文里混进一个坏字节(比如同步时截断了半个字):不当成 GBK 解出一整页乱码,也不打开编辑
        let mut damaged = "中文笔记的内容".as_bytes().to_vec();
        damaged.insert(6, 0xFF);
        assert_eq!(decode_text(&damaged), "中文\u{FFFD}笔记的内容");
        fs::write(note_path(&dir, "坏了"), &damaged).unwrap();
        assert!(read_note(&dir, "坏了").unwrap_err().contains("「坏了」"));
        // 真正的 GBK 文件照常打开
        let gbk = [0xD6, 0xD0, 0xCE, 0xC4, 0xB1, 0xCA, 0xBC, 0xC7];
        fs::write(note_path(&dir, "gbk"), gbk).unwrap();
        assert_eq!(read_note(&dir, "gbk").unwrap(), "中文笔记");
        // GB18030 也解不了的字节、BOM 后面的坏字节:有损失,不打开
        fs::write(note_path(&dir, "乱码"), [0xD6, 0xD0, 0xFF]).unwrap();
        assert!(read_note(&dir, "乱码").is_err());
        fs::write(note_path(&dir, "bom"), [0xEF, 0xBB, 0xBF, b'a', 0xFF]).unwrap();
        assert!(read_note(&dir, "bom").is_err());
        assert_eq!(read_note(&dir, "gbk").unwrap(), decode_text(&gbk));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn conflict_copy_keeps_the_other_version() {
        let root = temp_dir("conflict");
        let stamp = "2026-10-12 18.30";
        let save =
            |content: &str| save_page(&root, "", "周报", content, Some("原来的"), true, stamp);
        // 没被别处改过:不留副本
        fs::write(note_path(&root, "周报"), "原来的").unwrap();
        assert_eq!(save("我改的").unwrap(), None);
        assert_eq!(read_note(&root, "周报").unwrap(), "我改的");
        // 别处写进去的正好是要保存的内容(比如同步回来的自己的修改):也不算冲突
        assert_eq!(save("我改的").unwrap(), None);
        // 只是换行符不同不算改过
        fs::write(note_path(&root, "周报"), "第一行\r\n第二行").unwrap();
        assert_eq!(
            save_page(
                &root,
                "",
                "周报",
                "我改的",
                Some("第一行\n第二行"),
                true,
                stamp
            )
            .unwrap(),
            None
        );
        // 别处改成了别的内容:那边的版本另存一份,这边的照常写进去
        fs::write(note_path(&root, "周报"), "别处改的\r\n").unwrap();
        let (copy, text) = save("我改的").unwrap().unwrap();
        assert_eq!(copy, "周报 (冲突 2026-10-12 18.30)");
        assert_eq!(text, "别处改的\n");
        assert_eq!(read_note(&root, &copy).unwrap(), "别处改的\n");
        assert_eq!(read_note(&root, "周报").unwrap(), "我改的");
        // 同一分钟里又冲突一次,副本自动加编号
        fs::write(note_path(&root, "周报"), "别处又改了").unwrap();
        let (again, _) = save("我改的").unwrap().unwrap();
        assert_eq!(again, "周报 (冲突 2026-10-12 18.30) (2)");
        // 设置成直接覆盖:不留副本
        fs::write(note_path(&root, "周报"), "别处改的").unwrap();
        assert_eq!(
            save_page(&root, "", "周报", "覆盖", Some("原来的"), false, stamp).unwrap(),
            None
        );
        assert_eq!(read_note(&root, "周报").unwrap(), "覆盖");
        // 文件在别处被删了:没什么可留的,照常保存
        assert_eq!(
            save_page(&root, "", "没有这页", "新内容", Some("原来的"), true, stamp).unwrap(),
            None
        );
        assert_eq!(read_note(&root, "没有这页").unwrap(), "新内容");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn saving_skips_unchanged_files_and_never_guesses_after_a_read_error() {
        let root = temp_dir("save-page");
        let page = note_path(&root, "同样");
        fs::write(&page, "内容").unwrap();
        let past = SystemTime::now() - Duration::from_secs(7200);
        fs::OpenOptions::new()
            .write(true)
            .open(&page)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(past))
            .unwrap();
        // 文件里已经是这些内容:不再写一遍,也不会因为 expected 不同而留冲突副本
        assert_eq!(
            save_page(&root, "", "同样", "内容", Some("旧的"), true, "s").unwrap(),
            None
        );
        let modified = fs::metadata(&page).unwrap().modified().unwrap();
        assert!(modified < SystemTime::now() - Duration::from_secs(3600));
        assert_eq!(list_names(&root).unwrap(), ["同样"]);
        // 读不出来(这里页面文件是个文件夹):要留冲突副本时没法确认,先不保存,错误里有页面名字
        fs::create_dir(note_path(&root, "坏的")).unwrap();
        let err = save_page(&root, "", "坏的", "新内容", Some("旧的"), true, "s").unwrap_err();
        assert!(err.contains("无法确认「坏的」"), "{err}");
        // 直接覆盖时读不出来不拦着写(这里写也会失败,报的就是保存失败)
        let err = save_page(&root, "", "坏的", "新内容", Some("旧的"), false, "s").unwrap_err();
        assert!(err.contains("保存「坏的」失败"), "{err}");
        assert!(note_path(&root, "坏的").is_dir());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn busy_targets_are_renamed_after_a_short_wait() {
        let busy = || -> std::io::Result<()> { Err(std::io::ErrorKind::PermissionDenied.into()) };
        let mut calls = 0;
        let result = rename_with_retry(|| {
            calls += 1;
            if calls < 3 {
                busy()
            } else {
                Ok(())
            }
        });
        assert!(result.is_ok());
        assert_eq!(calls, 3);
        calls = 0;
        assert!(rename_with_retry(|| {
            calls += 1;
            busy()
        })
        .is_err());
        assert_eq!(calls, 5);
        // 别的错误(比如文件不在了)不等,直接报错;Windows 的共享冲突(32)也会再试
        calls = 0;
        assert!(rename_with_retry(|| {
            calls += 1;
            Err(std::io::ErrorKind::NotFound.into())
        })
        .is_err());
        assert_eq!(calls, 1);
        calls = 0;
        let _ = rename_with_retry(|| {
            calls += 1;
            Err(std::io::Error::from_raw_os_error(32))
        });
        assert_eq!(calls, if cfg!(windows) { 5 } else { 1 });
    }

    #[test]
    fn conflict_names_keep_the_suffix() {
        assert_eq!(
            conflict_name("周报", "2026-10-12 18.30"),
            "周报 (冲突 2026-10-12 18.30)"
        );
        let long = conflict_name(&"长".repeat(100), "2026-10-12 18.30");
        assert!(long.ends_with(" (冲突 2026-10-12 18.30)"));
        assert_eq!(long.chars().count(), 80);
        assert_eq!(sanitize_name(&long), long);
    }

    #[test]
    fn list_and_order_notes() {
        let dir = temp_dir("list");
        fs::write(note_path(&dir, "b"), "").unwrap();
        fs::write(note_path(&dir, "a"), "").unwrap();
        fs::write(dir.join("c.MD"), "").unwrap();
        fs::write(dir.join("readme.txt"), "").unwrap();
        fs::create_dir_all(dir.join("folder.md")).unwrap();
        let names = list_names(&dir).unwrap();
        assert_eq!(names, vec!["a", "b", "c"]);
        let saved = vec!["c".to_string(), "gone".to_string(), "a".to_string()];
        assert_eq!(order_names(&names, &saved), vec!["c", "a", "b"]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn trash_keeps_deleted_pages() {
        let root = temp_dir("trash");
        fs::write(note_path(&root, "要删的"), "内容").unwrap();
        move_to_trash(&root, "", "要删的").unwrap();
        assert!(!note_path(&root, "要删的").exists());
        let trashed = trash_entries(&root.join(TRASH_DIR));
        assert_eq!(trashed.len(), 1);
        assert_eq!(
            fs::read_to_string(root.join(TRASH_DIR).join(&trashed[0])).unwrap(),
            "内容"
        );
        // 同一秒里再删一个同名页面,不会盖掉前一个
        fs::write(note_path(&root, "要删的"), "第二个").unwrap();
        move_to_trash(&root, "", "要删的").unwrap();
        assert_eq!(trash_entries(&root.join(TRASH_DIR)).len(), 2);
        // 其他笔记本的页面放在 .trash 下同名的文件夹里
        fs::create_dir_all(root.join("工作")).unwrap();
        fs::write(note_path(&root.join("工作"), "周报"), "本周").unwrap();
        move_to_trash(&root, "工作", "周报").unwrap();
        assert!(!note_path(&root.join("工作"), "周报").exists());
        let in_book = trash_entries(&root.join(TRASH_DIR).join("工作"));
        assert_eq!(in_book.len(), 1);
        assert!(in_book[0].starts_with("周报.") && in_book[0].ends_with(".md"));
        // 不存在的页面直接忽略
        move_to_trash(&root, "", "没有这个").unwrap();
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn migrate_moves_only_when_target_is_free() {
        let root = temp_dir("migrate");
        let old = root.join("old").join("notes");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("a.md"), "旧笔记").unwrap();
        let new = root.join("new").join("notes");
        assert!(migrate_path(&old, &new).unwrap());
        assert_eq!(fs::read_to_string(new.join("a.md")).unwrap(), "旧笔记");
        // 已经搬过一次,新位置有东西了,不会再覆盖
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("b.md"), "").unwrap();
        assert!(!migrate_path(&old, &new).unwrap());
        assert!(!new.join("b.md").exists());
        // 旧位置不存在也没关系
        assert!(!migrate_path(&root.join("nothing"), &root.join("x")).unwrap());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn copied_migration_appears_only_when_complete() {
        let root = temp_dir("migrate-copy");
        let leftovers = |dir: &Path| {
            fs::read_dir(dir)
                .unwrap()
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp~"))
                .count()
        };
        // 文件(settings.json)和文件夹(notes)都是复制完才出现在新位置,旧的留着
        let old_file = root.join("old").join("settings.json");
        fs::create_dir_all(old_file.parent().unwrap()).unwrap();
        fs::write(&old_file, "{}").unwrap();
        let new_dir = root.join("new");
        fs::create_dir_all(&new_dir).unwrap();
        copy_into_place(&old_file, &new_dir.join("settings.json")).unwrap();
        assert_eq!(
            fs::read_to_string(new_dir.join("settings.json")).unwrap(),
            "{}"
        );
        let old_notes = root.join("old").join("notes");
        fs::create_dir_all(old_notes.join("工作")).unwrap();
        fs::write(old_notes.join("工作").join("周报.md"), "本周").unwrap();
        copy_into_place(&old_notes, &new_dir.join("notes")).unwrap();
        assert_eq!(
            fs::read_to_string(new_dir.join("notes").join("工作").join("周报.md")).unwrap(),
            "本周"
        );
        assert!(old_notes.join("工作").join("周报.md").exists());
        assert_eq!(leftovers(&new_dir), 0);
        // 最后一步失败(这里新位置被一个非空文件夹占着):临时副本删掉,新位置不动
        let taken = root.join("taken");
        fs::create_dir_all(taken.join("notes")).unwrap();
        fs::write(taken.join("notes").join("别的.md"), "别动").unwrap();
        assert!(copy_into_place(&old_notes, &taken.join("notes")).is_err());
        assert_eq!(leftovers(&taken), 0);
        assert_eq!(
            fs::read_to_string(taken.join("notes").join("别的.md")).unwrap(),
            "别动"
        );
        assert!(!taken.join("notes").join("工作").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn meta_round_trip() {
        let dir = temp_dir("meta");
        assert_eq!(read_meta(&dir), Meta::default());
        let mut modes = HashMap::new();
        modes.insert("a".to_string(), "view".to_string());
        let meta = Meta {
            order: vec!["b".into(), "a".into()],
            active: "a".into(),
            modes,
            book: "工作".into(),
            ..Default::default()
        };
        write_meta(&dir, &meta).unwrap();
        assert_eq!(read_meta(&dir), meta);
        // 0.2.0 写的 .minipad.json 没有 book,读出来就是「默认」
        fs::write(
            dir.join(META_FILE),
            r#"{"order":["a"],"active":"a","modes":{}}"#,
        )
        .unwrap();
        assert_eq!(read_meta(&dir).book, "");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn tab_groups_are_saved_with_the_book_and_empty_groups_dropped() {
        let root = temp_dir("groups");
        for n in ["a", "b", "c"] {
            fs::write(note_path(&root, n), n).unwrap();
        }
        let group = |id: &str, name: &str| TabGroup {
            id: id.into(),
            name: name.into(),
            color: "#4c8bf5".into(),
            collapsed: id == "g1",
        };
        save_book_meta(
            &root,
            "",
            vec!["a".into(), "b".into(), "c".into()],
            "a".into(),
            HashMap::new(),
            Some(Groups {
                groups: vec![group("g1", "工作"), group("g2", "空的")],
                note_groups: HashMap::from([
                    ("a".to_string(), "g1".to_string()),
                    ("b".to_string(), "g1".to_string()),
                    ("gone".to_string(), "g1".to_string()),
                    ("c".to_string(), "nope".to_string()),
                ]),
            }),
        )
        .unwrap();
        let meta = read_meta(&root);
        assert_eq!(
            meta.groups,
            vec![group("g1", "工作")],
            "a group with no pages is not kept"
        );
        assert_eq!(
            meta.note_groups.len(),
            2,
            "pages that are gone or in unknown groups are not kept"
        );
        let b = load_book(&root, "").unwrap();
        assert_eq!(b.groups, vec![group("g1", "工作")]);
        assert_eq!(
            b.notes.iter().map(|n| n.group.as_str()).collect::<Vec<_>>(),
            vec!["g1", "g1", ""]
        );
        // 不带分组保存(groups 是 None)时分组保持原样
        save_book_meta(
            &root,
            "",
            vec!["c".into(), "a".into(), "b".into()],
            "c".into(),
            HashMap::new(),
            None,
        )
        .unwrap();
        assert_eq!(read_meta(&root).groups, vec![group("g1", "工作")]);
        // 0.3.1 写的 .minipad.json 没有分组
        fs::write(
            root.join(META_FILE),
            r#"{"order":["a"],"active":"a","modes":{}}"#,
        )
        .unwrap();
        let b = load_book(&root, "").unwrap();
        assert!(b.groups.is_empty() && b.notes.iter().all(|n| n.group.is_empty()));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn notebook_appearance_is_persistent_and_survives_regular_meta_updates() {
        let root = temp_dir("book-appearance");
        fs::create_dir_all(root.join("工作")).unwrap();
        fs::write(root.join("工作").join("周报.md"), "内容").unwrap();
        set_book_appearance(&root, "工作", "briefcase", "#AABBCC").unwrap();
        let b = load_book(&root, "工作").unwrap();
        assert_eq!((&b.icon[..], &b.icon_color[..]), ("briefcase", "#aabbcc"));
        save_book_meta(
            &root,
            "工作",
            vec!["周报".into()],
            "周报".into(),
            HashMap::new(),
            None,
        )
        .unwrap();
        let b = load_book(&root, "工作").unwrap();
        assert_eq!((&b.icon[..], &b.icon_color[..]), ("briefcase", "#aabbcc"));
        assert!(set_book_appearance(&root, "工作", "bad-icon", "").is_err());
        assert!(set_book_appearance(&root, "工作", "star", "javascript:red").is_err());
        assert_eq!(read_meta(&root.join("工作")).icon, "briefcase");
        set_book_appearance(&root, "工作", "star", "").unwrap();
        assert_eq!(load_book(&root, "工作").unwrap().icon, "star");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn positioned_gradient_stops_roundtrip_and_validate() {
        let actual =
            normalized_book_color("linear-gradient(90deg, #AABBCC 0%, #112233 45%, #445566 100%)");
        assert_eq!(
            actual.as_deref(),
            Some("linear-gradient(90deg, #aabbcc 0%, #112233 45%, #445566 100%)")
        );
        for bad in [
            "linear-gradient(90deg, #aabbcc 90%, #112233 10%)",
            "linear-gradient(90deg, #aabbcc 0%, #112233)",
            "linear-gradient(90deg, #aabbcc 101%, #112233 100%)",
            "linear-gradient(90deg, #aabbcc 0%, #112233 var(--x))",
        ] {
            assert!(normalized_book_color(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn notebook_gradient_color_round_trip_and_invalid_css_rejected() {
        let root = temp_dir("book-gradient");
        fs::create_dir_all(root.join("工作")).unwrap();
        let color = "linear-gradient(135deg, #5FB4FF, #D66CF0)";
        set_book_appearance(&root, "工作", "star", color).unwrap();
        let b = load_book(&root, "工作").unwrap();
        assert_eq!(b.icon_color, "linear-gradient(135deg, #5fb4ff, #d66cf0)");
        for invalid in [
            "linear-gradient(135deg, red, blue)",
            "linear-gradient(999deg, #5fb4ff, #d66cf0)",
            "linear-gradient(135deg, #5fb4ff, url(x))",
            "linear-gradient(135deg, #5fb4ff)",
            "#12345",
            "javascript:alert(1)",
        ] {
            assert!(set_book_appearance(&root, "工作", "star", invalid).is_err());
            assert_eq!(
                load_book(&root, "工作").unwrap().icon_color,
                "linear-gradient(135deg, #5fb4ff, #d66cf0)"
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    /// 文件夹里改名留底的损坏元信息
    fn bad_meta_files(dir: &Path) -> Vec<PathBuf> {
        fs::read_dir(dir)
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with(".minipad.json.bad-")
            })
            .map(|e| e.path())
            .collect()
    }

    #[test]
    fn malformed_metadata_is_not_overwritten_when_changing_book_icon() {
        let root = temp_dir("bad-book-icon-meta");
        fs::create_dir_all(root.join("坏的")).unwrap();
        let path = root.join("坏的").join(META_FILE);
        let original = b"{ invalid JSON".to_vec();
        fs::write(&path, &original).unwrap();
        // 损坏的原文件改名留底(内容不变),再在默认值上改图标
        set_book_appearance(&root, "坏的", "star", "#123456").unwrap();
        let kept = bad_meta_files(&root.join("坏的"));
        assert_eq!(kept.len(), 1);
        assert_eq!(fs::read(&kept[0]).unwrap(), original);
        let meta = read_meta(&root.join("坏的"));
        assert_eq!((&meta.icon[..], &meta.icon_color[..]), ("star", "#123456"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn metadata_updates_never_replace_what_they_could_not_read() {
        let root = temp_dir("strict-meta");
        create_book(&root, "工作").unwrap();
        // 读不出来(这里 .minipad.json 是个文件夹):报错,什么都不写
        fs::create_dir(root.join("工作").join(META_FILE)).unwrap();
        assert!(
            save_book_meta(&root, "工作", vec![], String::new(), HashMap::new(), None).is_err()
        );
        assert!(set_book_appearance(&root, "工作", "star", "").is_err());
        assert!(root.join("工作").join(META_FILE).is_dir());
        fs::create_dir(root.join(META_FILE)).unwrap();
        assert!(set_current_book(&root, "工作").is_err());
        assert!(root.join(META_FILE).is_dir());
        // 根目录那份损坏了:改名留底,从默认值开始记当前笔记本;改名、删除笔记本照常
        fs::remove_dir(root.join(META_FILE)).unwrap();
        fs::write(root.join(META_FILE), "{ broken").unwrap();
        set_current_book(&root, "工作").unwrap();
        assert_eq!(read_meta(&root).book, "工作");
        let kept = bad_meta_files(&root);
        assert_eq!(kept.len(), 1);
        assert_eq!(fs::read_to_string(&kept[0]).unwrap(), "{ broken");
        assert_eq!(rename_book(&root, "工作", "生活").unwrap(), "生活");
        assert_eq!(read_meta(&root).book, "生活");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn books_are_subfolders_except_dot_folders() {
        let root = temp_dir("books");
        fs::write(note_path(&root, "欢迎"), "根目录的页面").unwrap();
        for d in ["工作", "生活", ".trash", ".git"] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        fs::write(root.join("说明.txt"), "").unwrap();
        fs::write(note_path(&root.join("工作"), "周报"), "本周").unwrap();
        fs::write(note_path(&root.join("工作"), "计划"), "").unwrap();
        // 笔记本里再套的文件夹不读
        fs::create_dir_all(root.join("工作").join("附件")).unwrap();
        fs::write(note_path(&root.join("工作").join("附件"), "深层"), "").unwrap();
        save_book_meta(
            &root,
            "工作",
            vec!["计划".into(), "周报".into()],
            "周报".into(),
            HashMap::from([("周报".to_string(), "view".to_string())]),
            None,
        )
        .unwrap();

        assert_eq!(list_books(&root).unwrap(), vec!["工作", "生活"]);
        let books = load_books(&root).unwrap();
        let book_names: Vec<&str> = books.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(book_names, vec!["", "工作", "生活"]);
        assert_eq!(names(&books[0]), vec!["欢迎"]);
        assert_eq!(books[0].active, "欢迎");
        assert_eq!(names(&books[1]), vec!["计划", "周报"]);
        assert_eq!(books[1].active, "周报");
        assert_eq!(books[1].notes[1].content, "本周");
        assert_eq!(books[1].notes[1].mode, "view");
        assert_eq!(books[1].notes[0].mode, "edit");
        assert!(books[2].notes.is_empty());
        assert_eq!(books[2].active, "");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn cleans_only_old_temporary_files_in_root_and_notebooks() {
        let root = temp_dir("temp-cleanup");
        let sub = root.join("工作");
        fs::create_dir_all(&sub).unwrap();
        let old = root.join("旧.md.123.1.tmp~");
        let old_sub = sub.join("旧.md.123.2.tmp~");
        let fresh = sub.join("新.md.123.3.tmp~");
        let normal = root.join("保留.md");
        for path in [&old, &old_sub, &fresh, &normal] {
            fs::write(path, "内容").unwrap();
        }
        let past = SystemTime::now() - Duration::from_secs(7200);
        for path in [&old, &old_sub] {
            fs::OpenOptions::new()
                .write(true)
                .open(path)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(past))
                .unwrap();
        }
        cleanup_stale_temps(&root);
        assert!(!old.exists());
        assert!(!old_sub.exists());
        assert!(fresh.exists());
        assert!(normal.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn switching_note_folder_copies_everything_and_keeps_original() {
        let root = temp_dir("folder-switch");
        let old = root.join("old");
        let next = root.join("new");
        fs::create_dir_all(old.join("项目")).unwrap();
        fs::create_dir_all(old.join(".trash")).unwrap();
        fs::write(old.join("我的.md"), "保留文本").unwrap();
        fs::write(old.join("项目").join("周报.md"), "项目内容").unwrap();
        fs::write(old.join(".trash").join("旧.md"), "回收站").unwrap();
        copy_notes_for_switch(&old, &next).unwrap();
        for path in ["我的.md", "项目/周报.md", ".trash/旧.md"] {
            assert_eq!(
                fs::read(next.join(path)).unwrap(),
                fs::read(old.join(path)).unwrap()
            );
        }
        assert!(copy_notes_for_switch(&old, &next).is_err());
        assert!(copy_notes_for_switch(&old, &old.join("inside")).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unreadable_note_does_not_block_other_pages() {
        let root = temp_dir("unreadable");
        fs::write(note_path(&root, "好页面"), "安全内容").unwrap();
        fs::write(note_path(&root, "坏页面"), "原文件不得覆盖").unwrap();
        let result = load_book_with_reader(&root, "", |dir, name| {
            if name == "坏页面" {
                Err("模拟访问被拒绝".to_string())
            } else {
                read_note(dir, name)
            }
        })
        .unwrap();
        assert_eq!(result.notes.len(), 2);
        let ok = result.notes.iter().find(|n| n.name == "好页面").unwrap();
        assert_eq!(ok.content, "安全内容");
        assert!(!ok.unreadable);
        let bad = result.notes.iter().find(|n| n.name == "坏页面").unwrap();
        assert!(bad.unreadable);
        assert_eq!(bad.content, "");
        assert_eq!(bad.reason.as_deref(), Some("模拟访问被拒绝"));
        assert_eq!(
            fs::read_to_string(note_path(&root, "坏页面")).unwrap(),
            "原文件不得覆盖"
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn create_and_rename_books() {
        let root = temp_dir("book-names");
        assert_eq!(create_book(&root, "工作").unwrap(), "工作");
        assert!(root.join("工作").is_dir());
        assert_eq!(create_book(&root, "工作").unwrap(), "工作 (2)");
        // 「默认」是根目录的名字,不能再用
        assert_eq!(create_book(&root, "默认").unwrap(), "默认 (2)");
        assert_eq!(create_book(&root, "  ").unwrap(), "新笔记本");
        assert_eq!(create_book(&root, ".git").unwrap(), "_git");
        assert_eq!(create_book(&root, "a/b").unwrap(), "a_b");
        // 和文件同名也不行
        fs::write(root.join("Notes"), "").unwrap();
        assert_eq!(create_book(&root, "notes").unwrap(), "notes (2)");

        fs::write(note_path(&root.join("工作 (2)"), "页面"), "内容").unwrap();
        set_current_book(&root, "工作 (2)").unwrap();
        assert_eq!(rename_book(&root, "工作 (2)", "生活").unwrap(), "生活");
        assert!(!root.join("工作 (2)").exists());
        assert_eq!(
            fs::read_to_string(note_path(&root.join("生活"), "页面")).unwrap(),
            "内容"
        );
        // 改名的是当前笔记本,记录也跟着改
        assert_eq!(read_meta(&root).book, "生活");
        // 改成已有的名字会自动加编号
        assert_eq!(rename_book(&root, "生活", "工作").unwrap(), "工作 (2)");
        // 只改大小写不算冲突
        create_book(&root, "Work").unwrap();
        assert_eq!(rename_book(&root, "Work", "WORK").unwrap(), "WORK");
        assert!(rename_book(&root, "", "随便").is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn delete_book_moves_folder_to_trash() {
        let root = temp_dir("book-delete");
        create_book(&root, "工作").unwrap();
        fs::write(note_path(&root.join("工作"), "周报"), "本周").unwrap();
        set_current_book(&root, "工作").unwrap();
        delete_book(&root, "工作").unwrap();
        assert!(!root.join("工作").exists());
        let trashed = trash_entries(&root.join(TRASH_DIR));
        assert_eq!(trashed.len(), 1);
        assert!(trashed[0].starts_with("工作."));
        let kept = root.join(TRASH_DIR).join(&trashed[0]);
        assert_eq!(
            fs::read_to_string(note_path(&kept, "周报")).unwrap(),
            "本周"
        );
        // 删掉的是当前笔记本,回到「默认」
        assert_eq!(read_meta(&root).book, "");
        assert!(list_books(&root).unwrap().is_empty());
        // 「默认」不能删,不存在的笔记本直接忽略
        assert!(delete_book(&root, "").is_err());
        delete_book(&root, "没有这个").unwrap();
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn move_note_between_books() {
        let root = temp_dir("move");
        fs::write(note_path(&root, "清单"), "根目录的清单").unwrap();
        create_book(&root, "工作").unwrap();
        fs::write(note_path(&root.join("工作"), "清单"), "工作的清单").unwrap();

        // 那边已经有同名页面,自动改名
        assert_eq!(move_note(&root, "", "清单", "工作").unwrap(), "清单 (2)");
        assert!(!note_path(&root, "清单").exists());
        assert_eq!(
            fs::read_to_string(note_path(&root.join("工作"), "清单 (2)")).unwrap(),
            "根目录的清单"
        );
        // 移回「默认」,那边没有重名,名字保持不变
        assert_eq!(
            move_note(&root, "工作", "清单 (2)", "").unwrap(),
            "清单 (2)"
        );
        assert_eq!(
            fs::read_to_string(note_path(&root, "清单 (2)")).unwrap(),
            "根目录的清单"
        );
        assert!(!note_path(&root.join("工作"), "清单 (2)").exists());
        // 移到同一个笔记本什么都不做,找不到的页面报错
        assert_eq!(move_note(&root, "", "清单 (2)", "").unwrap(), "清单 (2)");
        assert!(move_note(&root, "", "没有这个", "工作").is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn names_cannot_escape_the_notes_folder() {
        let root = temp_dir("escape");
        assert_eq!(book_dir(&root, "").unwrap(), root);
        assert_eq!(book_dir(&root, "工作").unwrap(), root.join("工作"));
        for bad in ["..", ".", "../x", "a/b", "a\\b", "C:", ".trash"] {
            assert!(book_dir(&root, bad).is_err(), "{bad} 应该被拒绝");
        }
        assert!(page_path(&root, "", "../x").is_err());
        assert!(page_path(&root, "", "").is_err());
        assert!(page_path(&root, "../x", "a").is_err());
        assert!(move_note(&root, "", "a", "..").is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn book_meta_is_saved_per_folder() {
        let root = temp_dir("book-meta");
        create_book(&root, "工作").unwrap();
        set_current_book(&root, "工作").unwrap();
        save_book_meta(
            &root,
            "",
            vec!["a".into()],
            "a".into(),
            HashMap::new(),
            None,
        )
        .unwrap();
        save_book_meta(
            &root,
            "工作",
            vec!["b".into()],
            "b".into(),
            HashMap::new(),
            None,
        )
        .unwrap();
        // 根目录那份记的当前笔记本不会被页面顺序覆盖掉
        let top = read_meta(&root);
        assert_eq!(
            (top.order, top.book),
            (vec!["a".to_string()], "工作".to_string())
        );
        assert_eq!(read_meta(&root.join("工作")).order, vec!["b"]);
        // 笔记本文件夹里的那份不写 book
        let raw = fs::read_to_string(root.join("工作").join(META_FILE)).unwrap();
        assert!(!raw.contains("\"book\""));
        // 已经删掉的笔记本不会因为保存顺序又被建出来
        save_book_meta(&root, "删掉了", vec![], String::new(), HashMap::new(), None).unwrap();
        assert!(!root.join("删掉了").exists());
        fs::remove_dir_all(&root).unwrap();
    }
}
