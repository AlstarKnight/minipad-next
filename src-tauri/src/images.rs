// ---------- 图片和附件:粘贴、拖进来、手机分享来的文件存进笔记本文件夹里的 assets ----------
// 页面里写的是相对路径 assets/img-….png、assets/报告.pdf,别的 Markdown 软件打开也能看到。
// 这里只放不碰窗口的部分:存文件、把页面里的相对路径找回文件、移动页面时带上用到的文件。

use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// 图片和附件放在笔记本文件夹里的这个子文件夹
pub const DIR: &str = "assets";
/// 一张图片最大多少字节
pub const MAX_BYTES: usize = 50 * 1024 * 1024;
/// 一个附件最大多少字节(手机设置里的「单个文件大小上限」最多选到 200 MB)
#[cfg_attr(not(mobile), allow(dead_code))]
pub const MAX_ATTACHMENT_BYTES: u64 = 200 * 1024 * 1024;

pub fn mime_for(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        // 0.5.6:手机分享来的 svg、avif 也当图片显示(svg 放在 <img> 里,里面的脚本不会运行)
        "svg" => Some("image/svg+xml"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

/// 能直接在页面里显示的图片存成什么扩展名(jpeg 写成 jpg):先看文件名,文件名没有扩展名时看 MIME。
/// 别的文件(heic 照片也是,WebView 显示不了)返回 None,存成附件。手机分享来的文件用
#[cfg_attr(not(mobile), allow(dead_code))]
pub fn image_ext(name: &str, mime: &str) -> Option<&'static str> {
    const EXTS: [&str; 8] = ["jpg", "png", "gif", "webp", "bmp", "svg", "avif", "jpeg"];
    let ext = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => ext.to_ascii_lowercase(),
        _ => match mime.to_ascii_lowercase().as_str() {
            "image/jpeg" | "image/jpg" => "jpg".into(),
            "image/svg+xml" => "svg".into(),
            other => other.strip_prefix("image/").unwrap_or_default().to_string(),
        },
    };
    let ext = EXTS.into_iter().find(|e| *e == ext)?;
    Some(if ext == "jpeg" { "jpg" } else { ext })
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

/// 页面里写的相对路径(assets/…)对应的文件,什么类型的都算;不在 assets 里、带 .. 、隐藏的(点开头)都不给
pub fn resolve_asset(book_dir: &Path, rel: &str) -> Option<PathBuf> {
    let rel = rel.replace('\\', "/");
    let rel = rel.strip_prefix("./").unwrap_or(&rel);
    let mut parts = rel.split('/');
    if parts.next() != Some(DIR) {
        return None;
    }
    // 一段一段接上(Windows 上都是 \),盘符和备用数据流(带 :)也不行
    let mut path = book_dir.join(DIR);
    let mut count = 0;
    for part in parts {
        if part.is_empty() || part.starts_with('.') || part.contains(':') {
            return None;
        }
        path.push(part);
        count += 1;
    }
    (count > 0).then_some(path)
}

/// 同上,只认图片(note 协议只给图片)
pub fn resolve(book_dir: &Path, rel: &str) -> Option<PathBuf> {
    let path = resolve_asset(book_dir, rel)?;
    mime_for(path.extension()?.to_str()?)?;
    Some(path)
}

/// 页面里写的 assets/… 对应的、确实存在的文件。地址可能是 %20 这样编码过的(别的软件写的、手写的):
/// 原样找不到时再按解码后的找。返回找到时用的相对路径和文件
pub fn find_asset(book_dir: &Path, rel: &str) -> Option<(String, PathBuf)> {
    let found = |rel: String| {
        resolve_asset(book_dir, &rel)
            .filter(|p| p.is_file())
            .map(|p| (rel, p))
    };
    found(rel.to_string()).or_else(|| {
        rel.contains('%')
            .then(|| percent_decode(rel))
            .flatten()
            .and_then(found)
    })
}

/// 页面内容里链到 assets 的文件:图片 ![](assets/…) 和附件 [📎 …](assets/…) 都算,去掉重复的,按出现的顺序
pub fn referenced(content: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (i, _) in content.match_indices("](") {
        let rest = &content[i + 2..];
        let link = match rest.strip_prefix('<') {
            Some(inner) => destination(inner, true),
            None => destination(rest, false),
        };
        let link = link.strip_prefix("./").unwrap_or(&link);
        if link.starts_with("assets/") && !out.iter().any(|x| x == link) {
            out.push(link.to_string());
        }
    }
    out
}

/// 链接地址:写在 <> 里的到 > 为止(可以有空格,文件名有空格时编辑器就这么写);
/// 没有 <> 的到空白或者没配对的 ) 为止。\( 这样转义过的字符还原
fn destination(s: &str, angled: bool) -> String {
    let mut out = String::new();
    let mut depth = 0;
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => match chars.next() {
                Some(n) if n.is_ascii_punctuation() => out.push(n),
                Some(n) => {
                    out.push('\\');
                    out.push(n);
                }
                None => break,
            },
            '\n' | '\r' => break,
            '>' if angled => break,
            '(' if !angled => {
                depth += 1;
                out.push(c);
            }
            ')' if !angled => {
                if depth == 0 {
                    break;
                }
                depth -= 1;
                out.push(c);
            }
            c if !angled && c.is_whitespace() => break,
            c => out.push(c),
        }
    }
    out
}

/// 页面移到别的笔记本:把它用到的图片和附件也复制过去(原来的留着,别的页面可能也在用;那边已有同名文件就不动)
pub fn copy_referenced(from_dir: &Path, to_dir: &Path, content: &str) -> Vec<String> {
    let mut failed = Vec::new();
    for rel in referenced(content) {
        let Some((rel, src)) = find_asset(from_dir, &rel) else {
            continue;
        };
        let Some(dst) = resolve_asset(to_dir, &rel) else {
            continue;
        };
        if dst.exists() {
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

/// 附件存进 assets 时的名字:保留原来的名字,系统不允许的字符换成 _(和页面名的规矩一样,
/// 也不能点开头);扩展名留着,名字太长时截短的是前面那部分。清理完是空的就叫「附件」
pub fn attachment_name(name: &str) -> String {
    // 只要最后一段(有的应用给的名字带着路径)
    let name = name.rsplit(['/', '\\']).next().unwrap_or(name).trim();
    match name.rsplit_once('.') {
        Some((stem, ext))
            if !stem.trim().is_empty()
                && !ext.is_empty()
                && ext.len() <= 12
                && ext.chars().all(|c| c.is_ascii_alphanumeric()) =>
        {
            let stem = crate::notes::clean_name_within(stem, "附件", 80 - ext.len() - 1);
            format!("{stem}.{ext}")
        }
        _ => crate::notes::clean_name_within(name, "附件", 80),
    }
}

/// 把 temp 放进 book_dir/assets,叫 name(已经有了就叫 name-2、name-3……,不分大小写,不会盖掉已有的文件),
/// 返回页面里写的相对路径。temp 和 assets 在同一个磁盘上时直接改名,不在时复制一份再删掉 temp
pub fn place(book_dir: &Path, temp: &Path, name: &str) -> Result<String, String> {
    let dir = book_dir.join(DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("无法建立附件文件夹:{e}"))?;
    let taken: HashSet<String> = fs::read_dir(&dir)
        .map_err(|e| format!("无法读取附件文件夹:{e}"))?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_lowercase())
        .collect();
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, format!(".{ext}")),
        _ => (name, String::new()),
    };
    for n in 1..1000 {
        let candidate = if n == 1 {
            name.to_string()
        } else {
            format!("{stem}-{n}{ext}")
        };
        if taken.contains(&candidate.to_lowercase()) {
            continue;
        }
        let path = dir.join(&candidate);
        // 先建一个空文件占住名字(别的地方刚好建了同名的就换下一个),再把 temp 换上去
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => drop(file),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("无法保存附件:{e}")),
        }
        let moved = fs::rename(temp, &path).or_else(|_| {
            fs::copy(temp, &path).map(|_| {
                let _ = fs::remove_file(temp);
            })
        });
        if let Err(e) = moved {
            let _ = fs::remove_file(&path);
            return Err(format!("无法保存附件:{e}"));
        }
        return Ok(format!("{DIR}/{candidate}"));
    }
    Err("同名的附件太多了,请换个名字".into())
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

/// note 协议(电脑和手机共用):…/img?book=…&path=assets/… 读这个笔记本 assets 里的图片。
/// 图片由 WebView 按地址直接读,不经 IPC;路径按 resolve 的规则检查,读不到就 404
pub fn protocol_response(root: &Path, uri: &tauri::http::Uri) -> tauri::http::Response<Vec<u8>> {
    let not_found = || {
        tauri::http::Response::builder()
            .status(404)
            .body(Vec::new())
            .unwrap()
    };
    let query = uri.query().unwrap_or_default();
    let (Some(book), Some(rel)) = (query_value(query, "book"), query_value(query, "path")) else {
        return not_found();
    };
    let Some(path) = crate::notes::book_dir(root, &book)
        .ok()
        .and_then(|dir| resolve(&dir, &rel))
    else {
        return not_found();
    };
    let mime = path
        .extension()
        .and_then(|x| x.to_str())
        .and_then(mime_for)
        .unwrap_or("application/octet-stream");
    match fs::read(&path) {
        Ok(bytes) => tauri::http::Response::builder()
            .header("Content-Type", mime)
            .header("Cache-Control", "no-cache")
            .body(bytes)
            .unwrap_or_else(|_| not_found()),
        Err(_) => not_found(),
    }
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
    fn any_file_inside_assets_resolves_but_nothing_outside() {
        let dir = Path::new("C:/notes/书");
        assert_eq!(
            resolve_asset(dir, "assets/季度 报告.pdf"),
            Some(dir.join("assets").join("季度 报告.pdf"))
        );
        assert!(resolve_asset(dir, "./assets/sub/a.exe").is_some());
        assert!(
            resolve(dir, "assets/a.pdf").is_none(),
            "only images for the protocol"
        );
        assert!(resolve(dir, "assets/a.svg").is_some() && resolve(dir, "assets/a.AVIF").is_some());
        for bad in [
            "assets/../a.md",
            "assets/./a.pdf",
            "assets//a.pdf",
            "assets/",
            "assets/.hidden.pdf",
            "assets/a:b.pdf",
            "assets/C:/a.pdf",
            "../assets/a.pdf",
            "/assets/a.pdf",
            "other/a.pdf",
        ] {
            assert!(resolve_asset(dir, bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn links_to_assets_are_found_with_spaces_parens_and_escapes() {
        let content = "[📎 季度 报告.pdf（1.2 MB）](<assets/季度 报告.pdf>)\n\
            [x](assets/a(1).pdf \"标题\") [y](assets/b\\_c.zip) [z](./assets/d.txt)\n\
            ![](assets/img-1.png) [网页](https://x.y/assets/n.pdf) [代码](assets/e.pdf";
        assert_eq!(
            referenced(content),
            [
                "assets/季度 报告.pdf",
                "assets/a(1).pdf",
                "assets/b_c.zip",
                "assets/d.txt",
                "assets/img-1.png",
                "assets/e.pdf",
            ]
        );
    }

    #[test]
    fn moving_a_page_copies_its_attachments_even_with_encoded_links() {
        let from = temp("attach-from");
        let to = temp("attach-to");
        fs::create_dir_all(from.join(DIR)).unwrap();
        fs::write(from.join(DIR).join("季度 报告.pdf"), b"pdf").unwrap();
        fs::write(from.join(DIR).join("图片 #1%.png"), b"png").unwrap();
        let content = "[📎 季度 报告.pdf](<assets/季度 报告.pdf>) ![](assets/图片%20%231%25.png)";
        assert!(copy_referenced(&from, &to, content).is_empty());
        assert_eq!(
            fs::read(to.join(DIR).join("季度 报告.pdf")).unwrap(),
            b"pdf"
        );
        assert_eq!(fs::read(to.join(DIR).join("图片 #1%.png")).unwrap(), b"png");
        assert_eq!(
            find_asset(&from, "assets/图片%20%231%25.png").map(|(rel, _)| rel),
            Some("assets/图片 #1%.png".into())
        );
        assert!(find_asset(&from, "assets/missing.pdf").is_none());
        let _ = fs::remove_dir_all(&from);
        let _ = fs::remove_dir_all(&to);
    }

    #[test]
    fn attachment_names_keep_the_name_and_the_extension() {
        assert_eq!(attachment_name("季度报告.pdf"), "季度报告.pdf");
        assert_eq!(attachment_name("a:b?.PDF"), "a_b_.PDF");
        assert_eq!(attachment_name("con.txt"), "con_.txt");
        assert_eq!(attachment_name(".env"), "_env");
        assert_eq!(attachment_name("  "), "附件");
        assert_eq!(attachment_name("/storage/emulated/0/x.pdf"), "x.pdf");
        assert_eq!(attachment_name("C:\\Users\\me\\y.docx"), "y.docx");
        assert_eq!(attachment_name("archive.tar.gz"), "archive.tar.gz");
        let long = format!("{}.pdf", "长".repeat(100));
        let cut = attachment_name(&long);
        assert!(cut.ends_with(".pdf") && cut.chars().count() == 80, "{cut}");
    }

    #[test]
    fn image_types_come_from_the_name_then_the_mime_type() {
        assert_eq!(image_ext("a.JPEG", ""), Some("jpg"));
        assert_eq!(image_ext("a.svg", "text/plain"), Some("svg"));
        assert_eq!(image_ext("IMG_1", "image/webp"), Some("webp"));
        assert_eq!(image_ext("IMG_1", "image/jpeg"), Some("jpg"));
        assert_eq!(image_ext("IMG_1", "image/svg+xml"), Some("svg"));
        assert_eq!(image_ext("a.heic", "image/heic"), None);
        assert_eq!(image_ext("a.pdf", "image/png"), None);
        assert_eq!(image_ext("a", "application/pdf"), None);
    }

    #[test]
    fn placing_files_never_overwrites_and_ignores_case() {
        let dir = temp("place");
        let put = |content: &[u8], name: &str| {
            let tmp = dir.join(format!(".part-{}", content.len()));
            fs::write(&tmp, content).unwrap();
            let rel = place(&dir, &tmp, name).unwrap();
            assert!(!tmp.exists(), "the temp file is moved");
            rel
        };
        assert_eq!(put(b"1", "报告.pdf"), "assets/报告.pdf");
        assert_eq!(put(b"22", "报告.pdf"), "assets/报告-2.pdf");
        assert_eq!(put(b"333", "报告.PDF"), "assets/报告-3.PDF");
        assert_eq!(put(b"4444", "README"), "assets/README");
        assert_eq!(fs::read(dir.join("assets/报告.pdf")).unwrap(), b"1");
        assert_eq!(fs::read(dir.join("assets/报告-2.pdf")).unwrap(), b"22");
        assert!(place(&dir, &dir.join("missing"), "x.pdf").is_err());
        assert!(
            !dir.join("assets/x.pdf").exists(),
            "no empty file is left behind"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_note_protocol_serves_only_images_inside_assets() {
        let root = temp("protocol");
        let book = root.join("笔记");
        let rel = save(&book, b"\x89PNG\r\n\x1a\nimage", "png", "1").unwrap();
        fs::write(book.join("页面.md"), "# 页面").unwrap();
        let get = |query: &str| {
            let uri: tauri::http::Uri = format!("http://note.localhost/img?{query}")
                .parse()
                .unwrap();
            protocol_response(&root, &uri)
        };
        let ok = get(&format!(
            "book=%E7%AC%94%E8%AE%B0&path={}",
            rel.replace('/', "%2F")
        ));
        assert_eq!(ok.status(), 200);
        assert_eq!(ok.headers()["Content-Type"], "image/png");
        assert_eq!(ok.body(), b"\x89PNG\r\n\x1a\nimage");
        for bad in [
            "book=%E7%AC%94%E8%AE%B0&path=%E9%A1%B5%E9%9D%A2.md",
            "book=%E7%AC%94%E8%AE%B0&path=assets%2F..%2F%E9%A1%B5%E9%9D%A2.md",
            "book=%E7%AC%94%E8%AE%B0&path=assets%2Fmissing.png",
            "book=..&path=assets%2Fimg-1.png",
            "book=.trash&path=assets%2Fimg-1.png",
            "book=%E7%AC%94%E8%AE%B0",
            "path=assets%2Fimg-1.png",
            "",
        ] {
            assert_eq!(get(bad).status(), 404, "{bad}");
        }
        let _ = fs::remove_dir_all(&root);
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
