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

#[cfg(test)]
mod tests {
    use super::*;

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
