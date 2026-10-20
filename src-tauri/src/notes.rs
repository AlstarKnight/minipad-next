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
/// 从 minipad2 导入时先写进笔记文件夹里以它开头的临时文件夹,写完再改名成笔记本
pub const IMPORT_STAGE_PREFIX: &str = ".import-";
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
    /// 固定在标签栏最前面的页面
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub pinned: Vec<String>,
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
    /// 固定在标签栏最前面
    pub pinned: bool,
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
    write_atomic_bytes(path, data.as_bytes())
}

/// 下载的图片也用与 Markdown 完全一致的原子写入路径。
pub fn write_atomic_bytes(path: &Path, data: &[u8]) -> Result<(), String> {
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
        file.write_all(data).map_err(|e| e.to_string())?;
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
    // 导入到一半(程序被关掉)留下的临时笔记本
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let old = entry
                .metadata()
                .is_ok_and(|m| m.is_dir() && m.modified().is_ok_and(|t| t < cutoff));
            if name.starts_with(IMPORT_STAGE_PREFIX) && old {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
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

fn has_notes(dir: &Path) -> bool {
    fs::read_dir(dir).is_ok_and(|rd| rd.flatten().any(|e| is_note_file(&e.path())))
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

/// 笔记文件夹下的笔记本(子文件夹,点开头的除外),按名字排序。
/// 「默认」笔记本放图片的 assets 文件夹不算(以前就叫 assets、里面有页面的笔记本照样显示)
pub fn list_books(root: &Path) -> Result<Vec<String>, String> {
    let mut books: Vec<String> = fs::read_dir(root)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter(|e| e.file_name() != crate::images::DIR || has_notes(&e.path()))
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
        // assets 是「默认」笔记本放图片的文件夹,不能用作笔记本的名字
        n == DEFAULT_BOOK_LABEL
            || n == crate::images::DIR
            || (Some(&n) != except.as_ref() && existing.contains(&n))
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
/// 文件不在了就没什么可留的,照常保存;读不出来就不知道里面是什么,不管是不是直接覆盖都先不保存。
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
        // 直接覆盖只是不留别处改过的版本,读不出来的文件也不能盖
        Err(e) => return Err(format!("读不出「{name}」现在的内容，暂不保存:{e}")),
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

/// 读一页。文件里有认不出来的字节(可能已损坏)时内容照常读出来(那几处是 �),另外返回原因:
/// 这样的页面只能看、不能改,免得编辑后把乱码存回原文件
fn read_page(dir: &Path, name: &str) -> Result<(String, Option<String>), String> {
    let bytes =
        fs::read(note_path(dir, name)).map_err(|e| format!("无法读取笔记「{name}」: {e}"))?;
    let (text, lossy) = decode(&bytes);
    let damaged = lossy.then(|| {
        format!(
            "「{name}」里有无法识别的字节(文件可能已损坏),为免把乱码存回原文件,只能查看、不能编辑"
        )
    });
    Ok((text, damaged))
}

/// 读一页的内容,有认不出来的字节时报错
#[cfg(test)]
pub fn read_note(dir: &Path, name: &str) -> Result<String, String> {
    match read_page(dir, name)? {
        (text, None) => Ok(text),
        (_, Some(why)) => Err(why),
    }
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
    F: FnMut(&Path, &str) -> Result<(String, Option<String>), String>,
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
                Ok((text, None)) => (text, false, None),
                // 文件有损坏:内容照常显示,但和读不出来的页面一样只读
                Ok((text, Some(why))) => (text, true, Some(why)),
                Err(e) => (String::new(), true, Some(e)),
            };
            Note {
                content,
                unreadable,
                reason,
                pinned: meta.pinned.contains(&name),
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
    load_book_with_reader(root, book, read_page)
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

/// 手机端的目录:笔记本和页面名字(按保存过的顺序),不读页面内容
#[cfg(any(mobile, test))]
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct BookIndex {
    pub name: String,
    pub notes: Vec<String>,
}

/// 和 load_books 一样,无法读取的子笔记本跳过,默认笔记本读不出来才报错
#[cfg(any(mobile, test))]
pub fn index_books(root: &Path) -> Result<Vec<BookIndex>, String> {
    let index = |book: &str| -> Result<BookIndex, String> {
        let dir = book_dir(root, book)?;
        let meta = read_meta(&dir);
        Ok(BookIndex {
            name: book.to_string(),
            notes: order_names(&list_names(&dir)?, &meta.order),
        })
    };
    let mut books = vec![index("")?];
    for name in list_books(root)? {
        if let Ok(book) = index(&name) {
            books.push(book);
        }
    }
    Ok(books)
}

/// 手机端打开一页时才读它;读不出来或内容损坏的页面和 load_books 一样只读
#[cfg(any(mobile, test))]
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PageBody {
    pub content: String,
    pub unreadable: bool,
    pub reason: Option<String>,
}

#[cfg(any(mobile, test))]
pub fn read_page_body(root: &Path, book: &str, name: &str) -> Result<PageBody, String> {
    // 名字不能带路径分隔符:先走一遍会检查名字的 page_path
    page_path(root, book, name)?;
    let (content, unreadable, reason) = match read_page(&book_dir(root, book)?, name) {
        Ok((text, None)) => (text, false, None),
        Ok((text, Some(why))) => (text, true, Some(why)),
        Err(e) => (String::new(), true, Some(e)),
    };
    Ok(PageBody {
        content,
        unreadable,
        reason,
    })
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
    pinned: Option<Vec<String>>,
) -> Result<(), String> {
    let dir = book_dir(root, book)?;
    if !dir.is_dir() {
        return Ok(());
    }
    let mut meta = read_meta_strict(&dir)?;
    meta.order = order;
    meta.active = active;
    meta.modes = modes;
    if let Some(mut pinned) = pinned {
        let mut seen = std::collections::HashSet::new();
        pinned.retain(|n| meta.order.contains(n) && seen.insert(n.clone()));
        meta.pinned = pinned;
    }
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

/// 前端看到的(load_book 给它的)页面顺序、固定和分组。前端写笔记本信息时带上它上次读到(或写进去)的
/// 那份,用来判断磁盘上的这几项在那之后有没有被别处改过,比如 WebDAV 刚从另一台电脑同步下来、前端还没读到
#[derive(Deserialize, Default, Debug, PartialEq)]
#[serde(default)]
pub struct SharedMeta {
    pub order: Vec<String>,
    pub pinned: Vec<String>,
    /// [页面名, 分组 id]
    pub note_groups: Vec<(String, String)>,
    pub groups: Vec<TabGroup>,
}

impl SharedMeta {
    /// 磁盘上现在的样子,算法和 load_book 一样:只算存在的页面,分组得在分组列表里
    fn on_disk(dir: &Path, meta: &Meta) -> Result<Self, String> {
        let order = order_names(&list_names(dir)?, &meta.order);
        let group_of = |name: &String| {
            meta.note_groups
                .get(name)
                .filter(|id| meta.groups.iter().any(|g| &g.id == *id))
                .map_or("", String::as_str)
        };
        let pinned = order
            .iter()
            .filter(|n| meta.pinned.contains(n))
            .cloned()
            .collect();
        let note_groups = order
            .iter()
            .filter(|n| !group_of(n).is_empty())
            .map(|n| (n.clone(), group_of(n).to_string()))
            .collect();
        let groups = meta
            .groups
            .iter()
            .filter(|g| order.iter().any(|n| group_of(n) == g.id))
            .cloned()
            .collect();
        Ok(Self {
            order,
            pinned,
            note_groups,
            groups,
        })
    }
}

/// 固定和分组只看有哪些,不看先后(页面顺序单独比)
fn pin_set(names: &[String]) -> std::collections::BTreeSet<&str> {
    names.iter().map(String::as_str).collect()
}

type Grouping<'a> = (
    std::collections::BTreeMap<&'a str, &'a TabGroup>,
    std::collections::BTreeMap<&'a str, &'a str>,
);

fn grouping<'a>(
    groups: &'a [TabGroup],
    pages: impl IntoIterator<Item = (&'a String, &'a String)>,
) -> Grouping<'a> {
    (
        groups.iter().map(|g| (g.id.as_str(), g)).collect(),
        pages
            .into_iter()
            .map(|(name, id)| (name.as_str(), id.as_str()))
            .collect(),
    )
}

/// 写笔记本信息之前调用:页面顺序、固定、分组里,磁盘上在前端上次看到(base)以后被别处改过、
/// 前端这一项又没改的,换成磁盘上的,免得拿前端手里的旧样子把刚同步下来的改动盖回去;
/// 两边都改了的照前端的写。没有或读不出 .minipad.json 时没得比,也照前端的写
pub fn keep_disk_changes(
    root: &Path,
    book: &str,
    base: &SharedMeta,
    order: &mut Vec<String>,
    pinned: &mut Option<Vec<String>>,
    groups: &mut Option<Groups>,
) -> Result<(), String> {
    let dir = book_dir(root, book)?;
    let Ok(bytes) = fs::read(dir.join(META_FILE)) else {
        return Ok(());
    };
    let Ok(meta) = serde_json::from_str::<Meta>(&decode_text(&bytes)) else {
        return Ok(());
    };
    let disk = SharedMeta::on_disk(&dir, &meta)?;
    if disk.order != base.order && *order == base.order {
        order.clone_from(&disk.order);
    }
    if let Some(mine) = pinned {
        let before = pin_set(&base.pinned);
        if pin_set(&disk.pinned) != before && pin_set(mine) == before {
            mine.clone_from(&disk.pinned);
        }
    }
    if let Some(mine) = groups {
        let before = grouping(&base.groups, base.note_groups.iter().map(|(n, g)| (n, g)));
        if grouping(&disk.groups, disk.note_groups.iter().map(|(n, g)| (n, g))) != before
            && grouping(&mine.groups, &mine.note_groups) == before
        {
            mine.groups.clone_from(&disk.groups);
            mine.note_groups = disk.note_groups.iter().cloned().collect();
        }
    }
    Ok(())
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

// ---------- 回收站 ----------
// 删掉的页面在 .trash/<笔记本>/<名字>.<秒数>.md(「默认」的直接在 .trash 里),
// 删掉的笔记本是 .trash/<名字>.<秒数> 文件夹;同一秒删了同名的,后面还会多个 " (2)"

/// 回收站里的一项:删掉的页面或笔记本
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct TrashItem {
    /// 在 .trash 里的位置(用 / 分隔),恢复、彻底删除时用它找
    pub id: String,
    /// page 页面 / book 笔记本
    pub kind: String,
    /// 页面原来所在的笔记本(「默认」是空字符串);删掉的笔记本是空的
    pub book: String,
    /// 原来的名字
    pub name: String,
    /// 删除的时间(Unix 秒)
    pub deleted: u64,
    /// 页面开头的一段文字
    pub preview: String,
    /// 删掉的笔记本里有几页
    pub pages: usize,
}

/// 从 "名字.1700000000" 或 "名字.1700000000 (2)" 里取出原来的名字和删除时间
fn split_stamp(stem: &str) -> Option<(&str, u64)> {
    let stem = match stem.rsplit_once(" (") {
        Some((head, tail))
            if tail.ends_with(')')
                && tail.len() > 1
                && tail[..tail.len() - 1].bytes().all(|b| b.is_ascii_digit()) =>
        {
            head
        }
        _ => stem,
    };
    let (name, secs) = stem.rsplit_once('.')?;
    if name.is_empty()
        || !(9..=12).contains(&secs.len())
        || !secs.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    Some((name, secs.parse().ok()?))
}

/// 文件的修改时间(Unix 秒),认不出删除时间时用它
fn modified_secs(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs())
}

/// 页面开头的一段文字(只读前 4KB,空白合成一个空格)
fn page_preview(path: &Path) -> String {
    use std::io::Read;
    let mut buf = Vec::new();
    if let Ok(f) = fs::File::open(path) {
        let _ = f.take(4096).read_to_end(&mut buf);
    }
    let text = decode_text(&buf);
    let words: Vec<&str> = text.split_whitespace().collect();
    words.join(" ").chars().take(120).collect()
}

fn trash_page(path: &Path, id: String, book: &str) -> TrashItem {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let (name, deleted) = match split_stamp(&stem) {
        Some((n, s)) => (n.to_string(), s),
        None => (stem.clone(), modified_secs(path)),
    };
    TrashItem {
        id,
        kind: "page".into(),
        book: book.to_string(),
        name,
        deleted,
        preview: page_preview(path),
        pages: 0,
    }
}

/// WebDAV 回收的图片和元数据也列入普通回收站，保留原来的相对目录。
fn collect_webdav_trash(
    directory: &Path,
    relative: &str,
    depth: usize,
    items: &mut Vec<TrashItem>,
) -> Result<(), String> {
    if depth > 3 {
        return Ok(());
    }
    for entry in fs::read_dir(directory).map_err(|e| format!("读取同步回收站失败：{e}"))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let next = if relative.is_empty() {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };
        if kind.is_dir() {
            collect_webdav_trash(&entry.path(), &next, depth + 1, items)?;
        } else if kind.is_file() {
            let (stem, extension) = name.rsplit_once('.').unwrap_or((&name, ""));
            if let Some((original, deleted)) = split_stamp(stem) {
                let parent = relative;
                let display = if extension.is_empty() {
                    original.to_string()
                } else {
                    format!("{original}.{extension}")
                };
                items.push(TrashItem {
                    id: format!(".webdav/{next}"),
                    kind: "file".into(),
                    book: String::new(),
                    name: if parent.is_empty() {
                        display
                    } else {
                        format!("{parent}/{display}")
                    },
                    deleted,
                    // 冲突时网盘那边的版本和同步替换、删除的本机版本都存成 .minipad.<时间>.json
                    preview: if original == ".minipad" && extension == "json" {
                        "WebDAV 同步留下的笔记本设置备份，不能直接恢复，可在笔记文件夹的 .trash/.webdav 里查看".into()
                    } else {
                        "WebDAV 同步回收的文件".into()
                    },
                    pages: 0,
                });
            }
        }
    }
    Ok(())
}

/// 回收站里的全部东西,最近删的在前
pub fn list_trash(root: &Path) -> Result<Vec<TrashItem>, String> {
    let trash = root.join(TRASH_DIR);
    let entries = match fs::read_dir(&trash) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("读不了回收站:{e}")),
    };
    let mut items = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let file = entry.file_name().to_string_lossy().to_string();
        if file == ".webdav" && path.is_dir() {
            collect_webdav_trash(&path, "", 0, &mut items)?;
        } else if is_note_file(&path) {
            items.push(trash_page(&path, file, ""));
        } else if !path.is_dir() {
            continue;
        } else if let Some((name, deleted)) = split_stamp(&file) {
            items.push(TrashItem {
                id: file.clone(),
                kind: "book".into(),
                book: String::new(),
                name: name.to_string(),
                deleted,
                preview: String::new(),
                pages: list_names(&path).map_or(0, |n| n.len()),
            });
        } else if let Ok(pages) = fs::read_dir(&path) {
            // 其他笔记本删掉的页面
            for p in pages.flatten() {
                let pp = p.path();
                if is_note_file(&pp) {
                    let id = format!("{file}/{}", p.file_name().to_string_lossy());
                    items.push(trash_page(&pp, id, &file));
                }
            }
        }
    }
    items.sort_by(|a, b| b.deleted.cmp(&a.deleted).then_with(|| a.name.cmp(&b.name)));
    Ok(items)
}

/// 回收站里 `id` 对应的文件或文件夹,和它在 .trash 里的位置(一层或两层)
fn trash_path(root: &Path, id: &str) -> Result<(PathBuf, Vec<String>), String> {
    let parts: Vec<String> = id.split('/').map(String::from).collect();
    let special = parts.first().is_some_and(|part| part == ".webdav");
    if parts.is_empty()
        || (special && (parts.len() < 2 || parts.len() > 5))
        || (!special && parts.len() > 2)
        || parts.iter().any(|p| check_name(p).is_err())
    {
        return Err(format!("回收站里没有「{id}」"));
    }
    let mut path = root.join(TRASH_DIR);
    for part in &parts {
        path.push(part);
        if special && fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err("同步回收站路径中包含不允许的符号链接".into());
        }
    }
    if fs::symlink_metadata(&path).is_err() {
        return Err("回收站里已经没有这一项了".into());
    }
    Ok((path, parts))
}

/// 恢复回收站里的一项:页面回到原来的笔记本(笔记本不在了就重新建),笔记本回到笔记文件夹;
/// 重名时加编号。返回恢复后的 (笔记本, 页面名),恢复的是笔记本时页面名是空的
pub fn restore_trash(root: &Path, id: &str) -> Result<(String, String), String> {
    let (path, parts) = trash_path(root, id)?;
    if parts.first().is_some_and(|part| part == ".webdav") {
        if !path.is_file() {
            return Err("同步回收站中的原件已不存在".into());
        }
        let filename = parts.last().unwrap();
        if filename.starts_with(".minipad.") && filename.ends_with(".json") {
            return Err(
                "这是 WebDAV 同步留下的笔记本设置备份，不支持直接恢复，请在笔记文件夹的 .trash/.webdav 里查看"
                    .into(),
            );
        }
        let (stem, extension) = filename.rsplit_once('.').unwrap_or((filename.as_str(), ""));
        let (name, _) = split_stamp(stem).ok_or("同步回收文件名称无效")?;
        let dir = parts[1..parts.len() - 1]
            .iter()
            .fold(root.to_path_buf(), |folder, part| folder.join(part));
        fs::create_dir_all(&dir).map_err(|e| format!("恢复同步文件失败：{e}"))?;
        let suffix = if extension.is_empty() {
            String::new()
        } else {
            format!(".{extension}")
        };
        let destination = free_path(&dir, name, &suffix);
        fs::rename(&path, destination).map_err(|e| format!("恢复同步文件失败：{e}"))?;
        remove_if_empty(&path);
        return Ok((String::new(), String::new()));
    }
    if parts.len() == 1 && path.is_dir() {
        let Some((name, _)) = split_stamp(&parts[0]) else {
            return Err(format!("回收站里没有「{id}」"));
        };
        let name = unique_book_name(root, name, None);
        fs::rename(&path, book_dir(root, &name)?).map_err(|e| format!("恢复失败:{e}"))?;
        return Ok((name, String::new()));
    }
    if !is_note_file(&path) {
        return Err(format!("回收站里没有「{id}」"));
    }
    let book = if parts.len() == 2 {
        parts[0].clone()
    } else {
        String::new()
    };
    let file = parts.last().unwrap();
    let stem = file.strip_suffix(&format!(".{NOTE_EXT}")).unwrap_or(file);
    let orig = split_stamp(stem).map_or(stem, |(n, _)| n);
    let dir = book_dir(root, &book)?;
    fs::create_dir_all(&dir).map_err(|e| format!("恢复失败:{e}"))?;
    let name = unique_name(&dir, orig, None)?;
    fs::rename(&path, note_path(&dir, &name)).map_err(|e| format!("恢复失败:{e}"))?;
    remove_if_empty(&path);
    Ok((book, name))
}

/// 彻底删除回收站里的一项
pub fn purge_trash(root: &Path, id: &str) -> Result<(), String> {
    let (path, _) = trash_path(root, id)?;
    let done = if path.is_dir() {
        fs::remove_dir_all(&path)
    } else {
        fs::remove_file(&path)
    };
    done.map_err(|e| format!("删除失败:{e}"))?;
    remove_if_empty(&path);
    Ok(())
}

/// 清空回收站,返回删掉了几项;删不掉的留着,报第一个错
pub fn empty_trash(root: &Path) -> Result<usize, String> {
    let items = list_trash(root)?;
    let mut first_err = None;
    let mut done = 0;
    for item in &items {
        match purge_trash(root, &item.id) {
            Ok(()) => done += 1,
            Err(e) => {
                first_err.get_or_insert(e);
            }
        }
    }
    match first_err {
        Some(e) => Err(format!("有 {} 项没删掉:{e}", items.len() - done)),
        None => Ok(done),
    }
}

/// 其他笔记本的页面都恢复或删掉以后,.trash 下那个空文件夹也去掉
fn remove_if_empty(item: &Path) {
    if let Some(parent) = item.parent() {
        if parent.file_name().is_some_and(|n| n != TRASH_DIR) {
            let _ = fs::remove_dir(parent);
        }
    }
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
        // 有一项读不出来就算复制失败,不能少复制了还当成功
        for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| format!("读不出「{}」里的内容:{e}", src.display()))?;
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
        // 打开笔记本时这一页照常显示内容,但只读
        let book = load_book(&dir, "").unwrap();
        let page = book.notes.iter().find(|n| n.name == "坏了").unwrap();
        assert!(page.unreadable);
        assert_eq!(page.content, "中文\u{FFFD}笔记的内容");
        assert!(page.reason.as_deref().unwrap().contains("只能查看"));
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
        // 读不出来(这里页面文件是个文件夹):不知道里面是什么,先不保存,错误里有页面名字。
        // 设置成直接覆盖、或者没有上次读到的内容时也一样,根本不去写(报的不是写入失败)
        fs::create_dir(note_path(&root, "坏的")).unwrap();
        for (expected, keep_both) in [(Some("旧的"), true), (Some("旧的"), false), (None, true)]
        {
            let err = save_page(&root, "", "坏的", "新内容", expected, keep_both, "s").unwrap_err();
            assert!(err.contains("读不出「坏的」"), "{err}");
        }
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
    fn trash_items_can_be_listed_restored_and_purged() {
        let root = temp_dir("trash-ui");
        assert!(list_trash(&root).unwrap().is_empty());
        fs::write(note_path(&root, "笔记"), "第一行\n\n  第二行").unwrap();
        create_book(&root, "工作").unwrap();
        fs::write(note_path(&root.join("工作"), "周报"), "本周").unwrap();
        create_book(&root, "旧的").unwrap();
        fs::write(note_path(&root.join("旧的"), "a"), "").unwrap();
        fs::write(note_path(&root.join("旧的"), "b"), "").unwrap();
        move_to_trash(&root, "", "笔记").unwrap();
        move_to_trash(&root, "工作", "周报").unwrap();
        delete_book(&root, "旧的").unwrap();
        // 手动放进来的、认不出时间的页面也列出来
        fs::write(root.join(TRASH_DIR).join("手放的.md"), "x").unwrap();
        fs::write(root.join(TRASH_DIR).join("不是页面.txt"), "x").unwrap();

        let items = list_trash(&root).unwrap();
        let find = |name: &str| items.iter().find(|i| i.name == name).unwrap().clone();
        assert_eq!(items.len(), 4);
        let page = find("笔记");
        assert_eq!((page.kind.as_str(), page.book.as_str()), ("page", ""));
        assert_eq!(page.preview, "第一行 第二行");
        assert!(page.deleted > 1_600_000_000);
        let weekly = find("周报");
        assert_eq!(weekly.book, "工作");
        assert!(weekly.id.starts_with("工作/周报."));
        let book = find("旧的");
        assert_eq!((book.kind.as_str(), book.pages), ("book", 2));
        assert_eq!(find("手放的").kind, "page");

        // 恢复页面:同名的页面已经有了就加编号
        fs::write(note_path(&root, "笔记"), "新的").unwrap();
        assert_eq!(
            restore_trash(&root, &page.id).unwrap(),
            ("".to_string(), "笔记 (2)".to_string())
        );
        assert_eq!(read_note(&root, "笔记 (2)").unwrap(), "第一行\n\n  第二行");
        // 原来的笔记本不在了就重新建;.trash 里空了的文件夹去掉
        fs::remove_dir_all(root.join("工作")).unwrap();
        assert_eq!(
            restore_trash(&root, &weekly.id).unwrap(),
            ("工作".to_string(), "周报".to_string())
        );
        assert_eq!(read_note(&root.join("工作"), "周报").unwrap(), "本周");
        assert!(!root.join(TRASH_DIR).join("工作").exists());
        // 恢复笔记本
        assert_eq!(
            restore_trash(&root, &book.id).unwrap(),
            ("旧的".to_string(), String::new())
        );
        assert_eq!(list_names(&root.join("旧的")).unwrap(), vec!["a", "b"]);
        // 已经不在的、跑到外面去的都不行
        assert!(restore_trash(&root, &page.id).is_err());
        assert!(purge_trash(&root, "../笔记.md").is_err());
        assert!(purge_trash(&root, "a/b/c.md").is_err());
        assert!(purge_trash(&root, "").is_err());

        // 彻底删除、清空
        purge_trash(&root, &find("手放的").id).unwrap();
        delete_book(&root, "旧的").unwrap();
        move_to_trash(&root, "工作", "周报").unwrap();
        assert_eq!(list_trash(&root).unwrap().len(), 2);
        assert_eq!(empty_trash(&root).unwrap(), 2);
        assert!(list_trash(&root).unwrap().is_empty());
        // 不是回收站里的东西不会被清掉
        assert!(root.join(TRASH_DIR).join("不是页面.txt").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn deletion_stamps_are_split_off_trash_names() {
        assert_eq!(
            split_stamp("周报.1700000000"),
            Some(("周报", 1_700_000_000))
        );
        assert_eq!(
            split_stamp("周报.1700000000 (2)"),
            Some(("周报", 1_700_000_000))
        );
        assert_eq!(
            split_stamp("v1.2.1700000000"),
            Some(("v1.2", 1_700_000_000))
        );
        assert_eq!(split_stamp("周报"), None);
        assert_eq!(split_stamp("v1.2"), None);
        assert_eq!(split_stamp(".1700000000"), None);
        assert_eq!(split_stamp("a.+70000000"), None);
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
    fn pinned_pages_are_saved_with_the_book() {
        let root = temp_dir("pinned");
        for n in ["a", "b", "c"] {
            fs::write(note_path(&root, n), n).unwrap();
        }
        let order = vec!["b".to_string(), "a".to_string(), "c".to_string()];
        let pinned = vec!["b".into(), "没有这页".into(), "b".into(), "a".into()];
        save_book_meta(
            &root,
            "",
            order.clone(),
            "a".into(),
            HashMap::new(),
            None,
            Some(pinned),
        )
        .unwrap();
        assert_eq!(read_meta(&root).pinned, ["b", "a"]);
        let book = load_book(&root, "").unwrap();
        let flags: Vec<(&str, bool)> = book
            .notes
            .iter()
            .map(|n| (n.name.as_str(), n.pinned))
            .collect();
        assert_eq!(flags, [("b", true), ("a", true), ("c", false)]);
        // 没带 pinned 时不改
        save_book_meta(
            &root,
            "",
            order.clone(),
            "a".into(),
            HashMap::new(),
            None,
            None,
        )
        .unwrap();
        assert_eq!(read_meta(&root).pinned, ["b", "a"]);
        save_book_meta(
            &root,
            "",
            order,
            "a".into(),
            HashMap::new(),
            None,
            Some(vec![]),
        )
        .unwrap();
        assert!(read_meta(&root).pinned.is_empty());
        assert!(!fs::read_to_string(root.join(META_FILE))
            .unwrap()
            .contains("pinned"));
        fs::remove_dir_all(&root).unwrap();
    }

    /// 三页 a、b、c,磁盘上先是前端读到的样子,再被「同步」换成 c、a、b,c 固定,b 在分组 g1
    fn synced_book(tag: &str) -> (PathBuf, SharedMeta, TabGroup) {
        let root = temp_dir(tag);
        for n in ["a", "b", "c"] {
            fs::write(note_path(&root, n), n).unwrap();
        }
        let names = |list: &[&str]| list.iter().map(|n| n.to_string()).collect::<Vec<_>>();
        save_book_meta(
            &root,
            "",
            names(&["a", "b", "c"]),
            "a".into(),
            HashMap::new(),
            None,
            None,
        )
        .unwrap();
        let base = SharedMeta::on_disk(&root, &read_meta(&root)).unwrap();
        let group = TabGroup {
            id: "g1".into(),
            name: "工作".into(),
            color: "#4c8bf5".into(),
            collapsed: false,
        };
        save_book_meta(
            &root,
            "",
            names(&["c", "a", "b"]),
            "a".into(),
            HashMap::new(),
            Some(Groups {
                groups: vec![group.clone()],
                note_groups: HashMap::from([("b".into(), "g1".into())]),
            }),
            Some(names(&["c"])),
        )
        .unwrap();
        (root, base, group)
    }

    #[test]
    fn book_meta_synced_after_the_frontend_read_is_not_written_back() {
        let (root, base, group) = synced_book("keep-synced-meta");
        // 前端还拿着旧的样子,只是换了当前页
        let mut order = base.order.clone();
        let mut pinned = Some(vec![]);
        let mut groups = Some(Groups {
            groups: vec![],
            note_groups: HashMap::new(),
        });
        keep_disk_changes(&root, "", &base, &mut order, &mut pinned, &mut groups).unwrap();
        save_book_meta(&root, "", order, "b".into(), HashMap::new(), groups, pinned).unwrap();
        let meta = read_meta(&root);
        assert_eq!(meta.order, ["c", "a", "b"]);
        assert_eq!(meta.active, "b");
        assert_eq!(meta.pinned, ["c"]);
        assert_eq!(meta.groups, [group]);
        assert_eq!(
            meta.note_groups,
            HashMap::from([("b".to_string(), "g1".to_string())])
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn book_meta_changed_here_wins_field_by_field() {
        let (root, base, group) = synced_book("local-meta-wins");
        // 这里把 b 拖到了最前面、新建了分组,固定没动
        let mut order = vec!["b".to_string(), "a".into(), "c".into()];
        let mut pinned = Some(vec![]);
        let mine = TabGroup {
            id: "g2".into(),
            ..group.clone()
        };
        let mut groups = Some(Groups {
            groups: vec![mine.clone()],
            note_groups: HashMap::from([("a".into(), "g2".into())]),
        });
        keep_disk_changes(&root, "", &base, &mut order, &mut pinned, &mut groups).unwrap();
        assert_eq!(order, ["b", "a", "c"]);
        assert_eq!(pinned, Some(vec!["c".to_string()]));
        let groups = groups.unwrap();
        assert_eq!(groups.groups, [mine]);
        assert_eq!(
            groups.note_groups,
            HashMap::from([("a".to_string(), "g2".to_string())])
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn book_meta_unchanged_on_disk_is_written_as_the_frontend_has_it() {
        let root = temp_dir("meta-unchanged-on-disk");
        for n in ["a", "b", "c"] {
            fs::write(note_path(&root, n), n).unwrap();
        }
        save_book_meta(
            &root,
            "",
            vec!["a".into(), "b".into(), "c".into()],
            "a".into(),
            HashMap::new(),
            None,
            Some(vec!["c".into(), "a".into()]),
        )
        .unwrap();
        let mut base = SharedMeta::on_disk(&root, &read_meta(&root)).unwrap();
        // 固定只看有哪些:前端记的先后不一样也算没改
        base.pinned.reverse();
        let mut order = vec!["c".to_string(), "b".into(), "a".into()];
        let mut pinned = Some(vec![]);
        keep_disk_changes(&root, "", &base, &mut order, &mut pinned, &mut None).unwrap();
        assert_eq!(order, ["c", "b", "a"]);
        assert_eq!(pinned, Some(vec![]));
        // 没有 .minipad.json 时没得比,照前端的写
        fs::remove_file(root.join(META_FILE)).unwrap();
        let mut order = base.order.clone();
        keep_disk_changes(&root, "", &base, &mut order, &mut None, &mut None).unwrap();
        assert_eq!(order, base.order);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn shared_meta_on_disk_matches_what_the_frontend_reads() {
        let root = temp_dir("shared-meta-view");
        for n in ["a", "b", "c", "d"] {
            fs::write(note_path(&root, n), n).unwrap();
        }
        let group = |id: &str| TabGroup {
            id: id.into(),
            ..TabGroup::default()
        };
        write_meta(
            &root,
            &Meta {
                order: vec!["c".into(), "没有这页".into(), "a".into()],
                pinned: vec!["a".into(), "没有这页".into()],
                groups: vec![group("g1"), group("空的")],
                note_groups: HashMap::from([
                    ("c".into(), "g1".into()),
                    ("d".into(), "不存在的分组".into()),
                ]),
                ..Meta::default()
            },
        )
        .unwrap();
        let book = load_book(&root, "").unwrap();
        let read = SharedMeta {
            order: book.notes.iter().map(|n| n.name.clone()).collect(),
            pinned: book
                .notes
                .iter()
                .filter(|n| n.pinned)
                .map(|n| n.name.clone())
                .collect(),
            note_groups: book
                .notes
                .iter()
                .filter(|n| !n.group.is_empty())
                .map(|n| (n.name.clone(), n.group.clone()))
                .collect(),
            groups: book.groups.clone(),
        };
        assert_eq!(read.order, ["c", "a", "b", "d"]);
        assert_eq!(SharedMeta::on_disk(&root, &read_meta(&root)).unwrap(), read);
        fs::remove_dir_all(&root).unwrap();
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
            None,
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
        assert!(save_book_meta(
            &root,
            "工作",
            vec![],
            String::new(),
            HashMap::new(),
            None,
            None
        )
        .is_err());
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
    fn the_mobile_index_lists_the_same_pages_as_load_books_and_pages_are_read_on_demand() {
        let root = temp_dir("mobile-index");
        fs::write(note_path(&root, "欢迎"), "根目录的页面").unwrap();
        fs::create_dir_all(root.join("工作")).unwrap();
        fs::create_dir_all(root.join(".trash")).unwrap();
        fs::write(note_path(&root.join("工作"), "周报"), "本周").unwrap();
        fs::write(note_path(&root.join("工作"), "计划"), "").unwrap();
        fs::write(note_path(&root.join("工作"), "乱码"), [0xD6, 0xD0, 0xFF]).unwrap();
        save_book_meta(
            &root,
            "工作",
            vec!["计划".into(), "周报".into()],
            "周报".into(),
            HashMap::new(),
            None,
            None,
        )
        .unwrap();

        let index = index_books(&root).unwrap();
        let loaded = load_books(&root).unwrap();
        assert_eq!(index.len(), loaded.len());
        for (listed, book) in index.iter().zip(&loaded) {
            assert_eq!(listed.name, book.name);
            assert_eq!(listed.notes, names(book));
        }
        assert_eq!(index[1].notes, vec!["计划", "周报", "乱码"]);

        let page = read_page_body(&root, "工作", "周报").unwrap();
        assert_eq!((page.content.as_str(), page.unreadable), ("本周", false));
        let damaged = read_page_body(&root, "工作", "乱码").unwrap();
        assert!(damaged.unreadable && damaged.reason.is_some());
        let missing = read_page_body(&root, "工作", "不存在").unwrap();
        assert!(missing.unreadable && missing.content.is_empty());
        assert!(read_page_body(&root, "工作", "../欢迎").is_err());
        assert!(read_page_body(&root, "../工作", "周报").is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_default_books_image_folder_is_not_a_notebook_and_its_name_is_reserved() {
        let root = temp_dir("assets-folder");
        fs::create_dir_all(root.join("assets")).unwrap();
        fs::write(root.join("assets").join("img-1.png"), "png").unwrap();
        assert!(list_books(&root).unwrap().is_empty());
        assert_eq!(unique_book_name(&root, "Assets", None), "Assets (2)");
        // 以前建的、里面有页面的 assets 笔记本还在
        fs::write(note_path(&root.join("assets"), "旧页面"), "").unwrap();
        assert_eq!(list_books(&root).unwrap(), vec!["assets"]);
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
        // 导入到一半留下的临时笔记本:旧的删掉,正在写的和别的点开头的文件夹不动
        let stale = root.join(".import-1-0");
        let busy = root.join(".import-1-1");
        for dir in [&stale, &busy, &root.join(TRASH_DIR)] {
            fs::create_dir_all(dir).unwrap();
            fs::write(note_path(dir, "页"), "x").unwrap();
        }
        #[cfg(windows)]
        let handle = {
            use std::os::windows::fs::OpenOptionsExt;
            // FILE_WRITE_ATTRIBUTES,FILE_FLAG_BACKUP_SEMANTICS(才能打开文件夹)
            fs::OpenOptions::new()
                .access_mode(0x100)
                .custom_flags(0x0200_0000)
                .open(&stale)
                .unwrap()
        };
        #[cfg(not(windows))]
        let handle = fs::File::open(&stale).unwrap();
        handle
            .set_times(fs::FileTimes::new().set_modified(past))
            .unwrap();
        drop(handle);
        cleanup_stale_temps(&root);
        assert!(!old.exists());
        assert!(!old_sub.exists());
        assert!(fresh.exists());
        assert!(normal.exists());
        assert!(!stale.exists());
        assert!(busy.exists());
        assert!(root.join(TRASH_DIR).exists());
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
                read_page(dir, name)
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
    fn metadata_conflict_backup_cannot_be_restored_as_unused_settings_file() {
        let root = temp_dir("webdav-settings-backup");
        let folder = root.join(".trash/.webdav/工作");
        fs::create_dir_all(&folder).unwrap();
        let id = ".webdav/工作/.minipad.1760000000.json";
        fs::write(folder.join(".minipad.1760000000.json"), "{}").unwrap();
        let item = list_trash(&root)
            .unwrap()
            .into_iter()
            .find(|item| item.id == id)
            .unwrap();
        assert!(item.preview.contains("笔记本设置备份"));
        assert!(restore_trash(&root, id)
            .unwrap_err()
            .contains("不支持直接恢复"));
        assert!(folder.join(".minipad.1760000000.json").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn webdav_auxiliary_trash_is_visible() {
        let root = temp_dir("webdav-trash-test");
        let archive = root.join(".trash/.webdav/assets");
        fs::create_dir_all(&archive).unwrap();
        fs::write(archive.join("image.1760000000.png"), b"old").unwrap();
        let list = list_trash(&root).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "assets/image.png");
        restore_trash(&root, &list[0].id).unwrap();
        assert_eq!(fs::read(root.join("assets/image.png")).unwrap(), b"old");
        fs::remove_dir_all(root).unwrap();
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
        save_book_meta(
            &root,
            "删掉了",
            vec![],
            String::new(),
            HashMap::new(),
            None,
            None,
        )
        .unwrap();
        assert!(!root.join("删掉了").exists());
        fs::remove_dir_all(&root).unwrap();
    }
}
