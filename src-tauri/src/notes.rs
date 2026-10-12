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
use std::path::{Path, PathBuf};

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
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Note {
    pub name: String,
    pub content: String,
    pub mode: String,
}

/// 一个笔记本和它的全部页面(按保存过的顺序)
#[derive(Serialize, Clone, Debug)]
pub struct Book {
    pub name: String,
    pub notes: Vec<Note>,
    pub active: String,
}

pub fn write_atomic(path: &Path, data: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp~");
    fs::write(&tmp, data).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// 把名字变成合法的 Windows 文件名,清理完是空的就用 `fallback`
fn clean_name(name: &str, fallback: &str) -> String {
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
        s = fallback.into();
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

/// 生成一个不和已有页面重名的名字;`except` 是重命名时的原名,不算冲突
pub fn unique_name(dir: &Path, base: &str, except: Option<&str>) -> String {
    // Windows 文件名不区分大小写,这里也按不区分处理
    let except = except.map(|e| e.to_lowercase());
    let existing: Vec<String> = list_names(dir)
        .unwrap_or_default()
        .into_iter()
        .map(|n| n.to_lowercase())
        .collect();
    first_free(sanitize_name(base), |n| {
        let n = n.to_lowercase();
        Some(&n) != except.as_ref() && existing.contains(&n)
    })
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
/// 这样从老软件里拷过来的中文 txt 也不会乱码。换行统一成 \n。
pub fn decode_text(bytes: &[u8]) -> String {
    let text = if let Some((encoding, bom_len)) = Encoding::for_bom(bytes) {
        encoding
            .decode_without_bom_handling(&bytes[bom_len..])
            .0
            .into_owned()
    } else {
        match std::str::from_utf8(bytes) {
            Ok(s) => s.to_owned(),
            Err(_) => GB18030.decode_without_bom_handling(bytes).0.into_owned(),
        }
    };
    text.replace("\r\n", "\n")
}

pub fn read_note(dir: &Path, name: &str) -> Result<String, String> {
    fs::read(note_path(dir, name))
        .map(|b| decode_text(&b))
        .map_err(|e| format!("无法读取笔记「{name}」: {e}"))
}

pub fn read_meta(dir: &Path) -> Meta {
    fs::read(dir.join(META_FILE))
        .ok()
        .and_then(|b| serde_json::from_str(&decode_text(&b)).ok())
        .unwrap_or_default()
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

/// 读出一个笔记本的全部页面,带上保存过的顺序、当前页面和模式
pub fn load_book(root: &Path, book: &str) -> Result<Book, String> {
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
            Ok(Note {
                content: read_note(&dir, &name)?,
                mode: meta
                    .modes
                    .get(&name)
                    .cloned()
                    .unwrap_or_else(|| "edit".into()),
                name,
            })
        })
        .collect::<Result<_, String>>()?;
    Ok(Book {
        name: book.to_string(),
        notes,
        active,
    })
}

/// 所有笔记本:「默认」在最前,后面是各个子文件夹(读不了的跳过)
pub fn load_books(root: &Path) -> Result<Vec<Book>, String> {
    let mut books = vec![load_book(root, "")?];
    for name in list_books(root)? {
        books.push(load_book(root, &name)?);
    }
    Ok(books)
}

/// 保存一个笔记本的页面顺序、当前页面和模式。笔记本已经不在了就不写,免得把删掉的文件夹又建出来。
pub fn save_book_meta(
    root: &Path,
    book: &str,
    order: Vec<String>,
    active: String,
    modes: HashMap<String, String>,
) -> Result<(), String> {
    let dir = book_dir(root, book)?;
    if !dir.is_dir() {
        return Ok(());
    }
    let mut meta = read_meta(&dir);
    meta.order = order;
    meta.active = active;
    meta.modes = modes;
    write_meta(&dir, &meta)
}

/// 记住当前打开的笔记本
pub fn set_current_book(root: &Path, book: &str) -> Result<(), String> {
    let mut meta = read_meta(root);
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
    let new = unique_name(&dir, name, None);
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
    copy_recursive(old, new)?;
    Ok(true)
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
    fn unique_name_avoids_existing_pages_case_insensitively() {
        let dir = temp_dir("unique");
        fs::write(note_path(&dir, "笔记"), "").unwrap();
        fs::write(note_path(&dir, "Todo"), "").unwrap();
        assert_eq!(unique_name(&dir, "新页面", None), "新页面");
        assert_eq!(unique_name(&dir, "笔记", None), "笔记 (2)");
        assert_eq!(unique_name(&dir, "todo", None), "todo (2)");
        // 重命名时只改大小写,不算和自己冲突
        assert_eq!(unique_name(&dir, "TODO", Some("Todo")), "TODO");
        fs::remove_dir_all(&dir).unwrap();
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
        save_book_meta(&root, "", vec!["a".into()], "a".into(), HashMap::new()).unwrap();
        save_book_meta(&root, "工作", vec!["b".into()], "b".into(), HashMap::new()).unwrap();
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
        save_book_meta(&root, "删掉了", vec![], String::new(), HashMap::new()).unwrap();
        assert!(!root.join("删掉了").exists());
        fs::remove_dir_all(&root).unwrap();
    }
}
