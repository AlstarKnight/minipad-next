//! 悬浮图标的纯计算部分(不依赖 Tauri,方便测试):放在哪里、自定义图片怎么交给前端。

use crate::edge::Rect;

/// 图标四周留出的透明边(逻辑像素),给阴影和放大效果留地方
pub const PAD: f64 = 8.0;
/// 自定义图片最大多大(字节)
pub const MAX_IMAGE: u64 = 2 * 1024 * 1024;
/// 自定义图片支持的格式
pub const IMAGE_EXTS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "ico"];

/// 通过文件路径、大小和修改时间缓存图片，避免重复读取并编码。
#[derive(Default)]
pub struct ImageCache {
    entry: Option<(std::path::PathBuf, u64, std::time::SystemTime, String)>,
}

impl ImageCache {
    pub fn get_or_load(
        &mut self,
        path: &std::path::Path,
        size: u64,
        modified: std::time::SystemTime,
        load: impl FnOnce() -> Option<String>,
    ) -> Option<String> {
        if let Some((old_path, old_size, old_modified, data)) = &self.entry {
            if old_path == path && *old_size == size && *old_modified == modified {
                return Some(data.clone());
            }
        }
        self.entry = None;
        let data = load()?;
        self.entry = Some((path.to_path_buf(), size, modified, data.clone()));
        Some(data)
    }

    pub fn clear(&mut self) {
        self.entry = None;
    }
}

/// 悬浮图标放在哪:记住的位置还在某块屏幕上就用它,不然放在主窗口右上角里面一点
pub fn position(saved: Option<[i32; 2]>, size: i32, main: Rect, monitors: &[Rect]) -> (i32, i32) {
    if let Some([x, y]) = saved {
        // 图标中心要在某块屏幕里,免得拔掉副屏以后找不到
        let (cx, cy) = (x + size / 2, y + size / 2);
        if monitors.iter().any(|m| m.contains(cx, cy)) {
            return (x, y);
        }
    }
    (main.x + main.w - size - 12, main.y + 12)
}

/// 图片文件的 MIME 类型,不支持的格式返回 None
pub fn mime_for(ext: &str) -> Option<&'static str> {
    Some(match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        _ => return None,
    })
}

/// 把图片变成 data: 网址,前端直接当图片用
pub fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", base64(bytes))
}

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0xfe, 0x00]), "//4A");
        assert_eq!(data_url("image/png", b"hi"), "data:image/png;base64,aGk=");
    }

    #[test]
    fn image_cache_reuses_and_invalidates_data() {
        use std::path::Path;
        use std::time::{Duration, SystemTime};
        let mut cache = ImageCache::default();
        let mtime = SystemTime::UNIX_EPOCH;
        let a = Path::new("ball-icon.png");
        assert_eq!(
            cache.get_or_load(a, 10, mtime, || Some("first".into())),
            Some("first".into())
        );
        assert_eq!(
            cache.get_or_load(a, 10, mtime, || panic!("缓存命中不应读文件")),
            Some("first".into())
        );
        assert_eq!(
            cache.get_or_load(a, 11, mtime, || Some("larger".into())),
            Some("larger".into())
        );
        assert_eq!(
            cache.get_or_load(a, 11, mtime + Duration::from_secs(1), || Some(
                "changed".into()
            )),
            Some("changed".into())
        );
        assert_eq!(
            cache.get_or_load(Path::new("new.png"), 11, mtime, || Some("new".into())),
            Some("new".into())
        );
        cache.clear();
        assert_eq!(
            cache.get_or_load(Path::new("new.png"), 11, mtime, || Some("refreshed".into())),
            Some("refreshed".into())
        );
    }

    #[test]
    fn mime_only_for_images() {
        assert_eq!(mime_for("PNG"), Some("image/png"));
        assert_eq!(mime_for("jpeg"), Some("image/jpeg"));
        assert_eq!(mime_for("svg"), None);
        assert_eq!(mime_for("exe"), None);
        for ext in IMAGE_EXTS {
            assert!(mime_for(ext).is_some(), "{ext}");
        }
    }

    #[test]
    fn saved_position_is_kept_only_while_it_is_on_a_screen() {
        let main = Rect::new(1000, 200, 440, 540);
        let screens = [Rect::new(0, 0, 1920, 1080)];
        assert_eq!(position(Some([50, 60]), 64, main, &screens), (50, 60));
        // 原来在拔掉的副屏上:回到主窗口右上角
        assert_eq!(
            position(Some([2500, 60]), 64, main, &screens),
            (1000 + 440 - 64 - 12, 212)
        );
        assert_eq!(position(None, 64, main, &screens), (1364, 212));
    }
}
