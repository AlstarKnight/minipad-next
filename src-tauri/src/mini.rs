// ---------- 小窗:把一页放进单独的小窗口 ----------
// 这里只放不碰窗口的部分:每页小窗记住的位置、大小、置顶和不透明度。

use serde::{Deserialize, Serialize};

/// 最多记住多少页的小窗位置(先丢掉最早关掉的)
pub const KEEP: usize = 50;
/// 小窗不透明度的范围(百分比)
pub const MIN_OPACITY: u32 = 40;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct MiniWin {
    pub book: String,
    pub name: String,
    /// 位置和大小(物理像素)
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub top: bool,
    pub opacity: u32,
    /// 退出程序时还开着,下次启动时恢复
    pub open: bool,
}

pub fn clamp_opacity(v: u32) -> u32 {
    v.clamp(MIN_OPACITY, 100)
}

pub fn find<'a>(list: &'a mut [MiniWin], book: &str, name: &str) -> Option<&'a mut MiniWin> {
    list.iter_mut().find(|m| m.book == book && m.name == name)
}

/// 记下(或更新)一页的小窗,最近用的放在最后
pub fn remember(list: &mut Vec<MiniWin>, entry: MiniWin) {
    list.retain(|m| !(m.book == entry.book && m.name == entry.name));
    list.push(entry);
    tidy(list);
}

/// 去掉重复的页面、不透明度限制在范围里、最多记 KEEP 个(开着的不丢)
pub fn tidy(list: &mut Vec<MiniWin>) {
    let mut seen = std::collections::HashSet::new();
    let mut kept: Vec<MiniWin> = Vec::new();
    for m in list.iter().rev() {
        if m.name.trim().is_empty() || !seen.insert((m.book.clone(), m.name.clone())) {
            continue;
        }
        let mut m = m.clone();
        m.opacity = clamp_opacity(m.opacity);
        kept.push(m);
    }
    kept.reverse();
    while kept.len() > KEEP {
        match kept.iter().position(|m| !m.open) {
            Some(i) => {
                kept.remove(i);
            }
            None => {
                kept.remove(0);
            }
        }
    }
    *list = kept;
}

/// 快速记录的小窗(0.5.1)放在哪:cursor 放在鼠标右下方一点,其余放在屏幕(area = x, y, 宽, 高,
/// 不算任务栏)中间;超出屏幕就往回挪,比屏幕还大时靠左上。都是物理像素
pub fn capture_at(
    how: &str,
    area: (i32, i32, i32, i32),
    size: (i32, i32),
    cursor: (i32, i32),
) -> (i32, i32) {
    let (ax, ay, aw, ah) = area;
    let (w, h) = size;
    let (x, y) = if how == "cursor" {
        (cursor.0 + 12, cursor.1 + 12)
    } else {
        (ax + (aw - w) / 2, ay + (ah - h) / 2)
    };
    (x.min(ax + aw - w).max(ax), y.min(ay + ah - h).max(ay))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_window_sits_in_the_middle_or_by_the_mouse_and_stays_on_screen() {
        let area = (1920, 0, 1920, 1040);
        assert_eq!(capture_at("center", area, (420, 300), (0, 0)), (2670, 370));
        assert_eq!(
            capture_at("remember", area, (420, 300), (0, 0)),
            (2670, 370)
        );
        assert_eq!(
            capture_at("cursor", area, (420, 300), (2000, 100)),
            (2012, 112)
        );
        // 鼠标在右下角:往回挪到屏幕里
        assert_eq!(
            capture_at("cursor", area, (420, 300), (3830, 1030)),
            (3420, 740)
        );
        // 窗口比屏幕还大:靠左上
        assert_eq!(
            capture_at("cursor", area, (2000, 1200), (2000, 100)),
            (1920, 0)
        );
    }

    fn page(name: &str, open: bool) -> MiniWin {
        MiniWin {
            name: name.into(),
            w: 320,
            h: 360,
            top: true,
            opacity: 100,
            open,
            ..Default::default()
        }
    }

    #[test]
    fn remember_replaces_the_same_page_and_keeps_the_newest_last() {
        let mut list = vec![page("a", false), page("b", false)];
        let mut a = page("a", true);
        a.x = 99;
        remember(&mut list, a);
        assert_eq!(
            list.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(),
            ["b", "a"]
        );
        assert_eq!(list[1].x, 99);
        assert!(list[1].open);
    }

    #[test]
    fn tidy_limits_opacity_drops_duplicates_and_forgets_closed_pages_first() {
        let mut list = vec![page("a", true)];
        for i in 0..KEEP + 5 {
            list.push(page(&format!("p{i}"), false));
        }
        list.push(MiniWin {
            opacity: 5,
            ..page("p3", false)
        });
        list.push(page("", false));
        tidy(&mut list);
        assert_eq!(list.len(), KEEP);
        assert_eq!(list[0].name, "a", "an open small window is never forgotten");
        let p3: Vec<_> = list.iter().filter(|m| m.name == "p3").collect();
        assert_eq!(p3.len(), 1);
        assert_eq!(p3[0].opacity, MIN_OPACITY);
        assert!(list.iter().all(|m| !m.name.is_empty()));
    }
}
