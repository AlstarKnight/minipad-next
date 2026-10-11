//! 笔记文件的读写:文件名清理、去重、编码识别、页面顺序。
//! 这里的函数不依赖 Tauri,方便单独测试。

use encoding_rs::{Encoding, GB18030};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

pub const NOTE_EXT: &str = "md";
const META_FILE: &str = ".minipad.json";
const TRASH_DIR: &str = ".trash";

/// 页面顺序、当前页面、每页的编辑/阅读模式,存在笔记文件夹的 .minipad.json
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct Meta {
    pub order: Vec<String>,
    pub active: String,
    pub modes: HashMap<String, String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct NoteFile {
    pub name: String,
    pub content: String,
}

pub fn write_atomic(path: &Path, data: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp~");
    fs::write(&tmp, data).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// 把页面名变成合法的 Windows 文件名
pub fn sanitize_name(name: &str) -> String {
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

pub fn note_path(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{name}.{NOTE_EXT}"))
}

fn is_note_file(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|x| x.to_str())
            .is_some_and(|x| x.eq_ignore_ascii_case(NOTE_EXT))
}

/// 笔记文件夹里所有页面的名字(按名字排序)
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

/// 生成一个不和已有页面重名的名字;`except` 是重命名时的原名,不算冲突
pub fn unique_name(dir: &Path, base: &str, except: Option<&str>) -> String {
    let base = sanitize_name(base);
    // Windows 文件名不区分大小写,这里也按不区分处理
    let except = except.map(|e| e.to_lowercase());
    let existing: Vec<String> = list_names(dir)
        .unwrap_or_default()
        .into_iter()
        .map(|n| n.to_lowercase())
        .collect();
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

pub fn read_note(dir: &Path, name: &str) -> String {
    fs::read(note_path(dir, name))
        .map(|b| decode_text(&b))
        .unwrap_or_default()
}

pub fn read_all(dir: &Path) -> Result<Vec<NoteFile>, String> {
    Ok(list_names(dir)?
        .into_iter()
        .map(|name| NoteFile {
            content: read_note(dir, &name),
            name,
        })
        .collect())
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

/// 删除页面:移到笔记文件夹的 .trash 里,文件名加上时间戳
pub fn move_to_trash(dir: &Path, name: &str) -> Result<(), String> {
    let src = note_path(dir, name);
    if !src.exists() {
        return Ok(());
    }
    let trash = dir.join(TRASH_DIR);
    fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    fs::rename(&src, trash.join(format!("{name}.{stamp}.{NOTE_EXT}"))).map_err(|e| e.to_string())
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个测试用自己的临时文件夹
    fn temp_dir(tag: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("minipad-test-{tag}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn sanitize_replaces_illegal_characters() {
        assert_eq!(sanitize_name("a/b\\c:d*e?f\"g<h>i|j"), "a_b_c_d_e_f_g_h_i_j");
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
        let dir = temp_dir("trash");
        fs::write(note_path(&dir, "要删的"), "内容").unwrap();
        move_to_trash(&dir, "要删的").unwrap();
        assert!(!note_path(&dir, "要删的").exists());
        let trashed: Vec<_> = fs::read_dir(dir.join(TRASH_DIR)).unwrap().flatten().collect();
        assert_eq!(trashed.len(), 1);
        assert_eq!(fs::read_to_string(trashed[0].path()).unwrap(), "内容");
        // 不存在的页面直接忽略
        move_to_trash(&dir, "没有这个").unwrap();
        fs::remove_dir_all(&dir).unwrap();
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
        };
        write_meta(&dir, &meta).unwrap();
        assert_eq!(read_meta(&dir), meta);
        fs::remove_dir_all(&dir).unwrap();
    }
}
