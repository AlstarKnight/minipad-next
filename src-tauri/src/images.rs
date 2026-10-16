// ---------- 图片:粘贴、拖进来的图片存进笔记本文件夹里的 assets ----------
// 页面里写的是相对路径 assets/img-….png,别的 Markdown 软件打开也能看到图片。
// 这里只放不碰窗口的部分:存图片、把页面里的相对路径找回文件、移动页面时带上图片。

use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

/// 图片放在笔记本文件夹里的这个子文件夹
pub const DIR: &str = "assets";
/// 一张图片最大多少字节
pub const MAX_BYTES: usize = 50 * 1024 * 1024;

pub fn mime_for(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

/// 把图片存进 book_dir/assets,名字是 img-日期-时间.扩展名(重名加编号),返回页面里写的相对路径
pub fn save(book_dir: &Path, bytes: &[u8], ext: &str, stamp: &str) -> Result<String, String> {
    let ext = ext.to_ascii_lowercase();
    if mime_for(&ext).is_none() {
        return Err(format!("不支持这种图片:{ext}"));
    }
    if bytes.is_empty() {
        return Err("图片是空的".into());
    }
    if bytes.len() > MAX_BYTES {
        return Err(format!("图片太大了(超过 {} MB)", MAX_BYTES / 1024 / 1024));
    }
    let dir = book_dir.join(DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("无法建立图片文件夹:{e}"))?;
    for n in 1..1000 {
        let name = if n == 1 {
            format!("img-{stamp}.{ext}")
        } else {
            format!("img-{stamp}-{n}.{ext}")
        };
        let path = dir.join(&name);
        // 只建新文件,不会盖掉已有的图片
        let mut file = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("无法保存图片:{e}")),
        };
        if let Err(e) = file.write_all(bytes).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(format!("无法保存图片:{e}"));
        }
        return Ok(format!("{DIR}/{name}"));
    }
    Err("图片太多重名了,请稍后再试".into())
}

/// 页面里写的相对路径(assets/…)对应的文件;不在 assets 里、带 .. 或不是图片的都不给
pub fn resolve(book_dir: &Path, rel: &str) -> Option<PathBuf> {
    let rel = rel.replace('\\', "/");
    let rel = rel.strip_prefix("./").unwrap_or(&rel);
    let path = Path::new(rel);
    let mut parts = path.components();
    if parts.next() != Some(Component::Normal(DIR.as_ref())) {
        return None;
    }
    let mut count = 0;
    for c in parts {
        match c {
            Component::Normal(s) if !s.to_string_lossy().starts_with('.') => count += 1,
            _ => return None,
        }
    }
    mime_for(path.extension()?.to_str()?)?;
    (count > 0).then(|| book_dir.join(path))
}

/// 页面内容里用到的 assets 图片(![](assets/…) 写法)
pub fn referenced(content: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (i, _) in content.match_indices("](") {
        let rest = &content[i + 2..];
        let rest = rest.strip_prefix('<').unwrap_or(rest);
        let end = rest
            .find(|c: char| c == ')' || c == '>' || c.is_whitespace())
            .unwrap_or(rest.len());
        let link = &rest[..end];
        let link = link.strip_prefix("./").unwrap_or(link);
        if link.starts_with("assets/") && !out.iter().any(|x| x == link) {
            out.push(link.to_string());
        }
    }
    out
}

/// 页面移到别的笔记本:把它用到的图片也复制过去(原来的留着,别的页面可能也在用;那边已有同名文件就不动)
pub fn copy_referenced(from_dir: &Path, to_dir: &Path, content: &str) -> Vec<String> {
    let mut failed = Vec::new();
    for rel in referenced(content) {
        let (Some(src), Some(dst)) = (resolve(from_dir, &rel), resolve(to_dir, &rel)) else {
            continue;
        };
        if !src.is_file() || dst.exists() {
            continue;
        }
        let copied = dst
            .parent()
            .map_or(Ok(()), fs::create_dir_all)
            .and_then(|_| fs::copy(&src, &dst).map(|_| ()));
        if copied.is_err() {
            failed.push(rel);
        }
    }
    failed
}

/// %E4%B8%AD 这样的写法换回文字(encodeURIComponent 的反过程)
pub fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// 网址查询部分(a=1&b=2)里某一项的值
pub fn query_value(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then(|| percent_decode(v)).flatten()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("minipad-images-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn saving_never_overwrites_and_checks_type_and_size() {
        let dir = temp("save");
        let a = save(&dir, b"one", "PNG", "20261016-101500").unwrap();
        let b = save(&dir, b"two", "png", "20261016-101500").unwrap();
        assert_eq!(a, "assets/img-20261016-101500.png");
        assert_eq!(b, "assets/img-20261016-101500-2.png");
        assert_eq!(fs::read(dir.join(&a)).unwrap(), b"one");
        assert!(save(&dir, b"x", "exe", "s").is_err());
        assert!(save(&dir, b"", "png", "s").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_images_inside_assets_resolve() {
        let dir = Path::new("C:/notes/书");
        assert_eq!(
            resolve(dir, "assets/img-1.png"),
            Some(dir.join("assets/img-1.png"))
        );
        assert!(resolve(dir, "./assets/sub/a.JPG").is_some());
        assert!(resolve(dir, "assets\\a.gif").is_some());
        for bad in [
            "assets/../a.md",
            "../assets/a.png",
            "assets/a.md",
            "other/a.png",
            "assets",
            "/assets/a.png",
            "assets/.x/a.png",
            "C:/assets/a.png",
        ] {
            assert!(resolve(dir, bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn moving_a_page_copies_the_images_it_uses() {
        let from = temp("from");
        let to = temp("to");
        let a = save(&from, b"a", "png", "1").unwrap();
        let content =
            format!("![](<{a}>) 和 ![图](assets/missing.png) 还有 [链接](https://x.y) ![]({a})");
        assert_eq!(
            referenced(&content),
            [a.clone(), "assets/missing.png".into()]
        );
        assert!(copy_referenced(&from, &to, &content).is_empty());
        assert_eq!(fs::read(to.join(&a)).unwrap(), b"a");
        assert!(from.join(&a).is_file(), "the original stays");
        let _ = fs::remove_dir_all(&from);
        let _ = fs::remove_dir_all(&to);
    }

    #[test]
    fn query_values_are_decoded() {
        let q = "book=%E7%AC%94%E8%AE%B0&path=assets%2Fimg-1.png";
        assert_eq!(query_value(q, "book").as_deref(), Some("笔记"));
        assert_eq!(query_value(q, "path").as_deref(), Some("assets/img-1.png"));
        assert_eq!(query_value("book=", "book").as_deref(), Some(""));
        assert_eq!(query_value(q, "x"), None);
        assert_eq!(percent_decode("%zz"), None);
    }
}
