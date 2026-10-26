//! 贴边隐藏的几何计算(不依赖 Tauri,方便测试)。所有坐标都是物理像素。

/// 有箭头的两种模式都预留 18 逻辑像素，保证箭头始终可点击。
pub const ARROW_STRIP: i32 = 18;
/// 默认细线为 2 逻辑像素，避免在贴边时过于醒目。
pub const LINE_STRIP: i32 = 2;
/// 鼠标靠近时展开悬浮按钮所需的宽度。
pub const PEEK_STRIP: i32 = 32;
/// 开启微光不额外增大窗口露出的厚度，避免出现一大条透明触发区。
pub fn strip_for(style: &str, peeking: bool, line_width: u32, _glow: bool) -> i32 {
    let width = line_width.clamp(1, 12) as i32;
    match (style, peeking) {
        ("arrow" | "arrow-only", _) => ARROW_STRIP,
        ("hover", true) => PEEK_STRIP,
        _ => width,
    }
}

/// 只允许在真正绘制的线段或中央箭头附近唤醒窗口。
/// 所有坐标都是物理像素；命中区域配置与窗口一起传递，避免参数位置混淆。
pub struct IndicatorHotzone<'a> {
    pub edge: Edge,
    pub win: Rect,
    pub mon: Rect,
    pub style: &'a str,
    pub length_percent: u32,
    pub length_unit: &'a str,
    pub length_px: u32,
    pub peeking: bool,
    pub scale: f64,
}

impl IndicatorHotzone<'_> {
    pub fn contains(&self, px: i32, py: i32) -> bool {
        let win = self.win;
        let mon = self.mon;
        let (along, start, span, across) = match self.edge {
            Edge::Top => (px, win.x, win.w, py >= mon.y && py < win.y + win.h),
            Edge::Left => (py, win.y, win.h, px >= mon.x && px < win.x + win.w),
            Edge::Right => (py, win.y, win.h, px >= win.x && px < mon.x + mon.w),
        };
        if !across || span <= 0 {
            return false;
        }
        let line_len = if self.length_unit == "px" {
            (f64::from(self.length_px.clamp(24, 600)) * self.scale).round() as i32
        } else {
            (i64::from(span) * i64::from(self.length_percent.clamp(10, 100)) / 100) as i32
        };
        // 箭头和悬浮按钮保留居中的独立点击范围；短线两侧的空白不可唤出。
        let arrow_len = (36.0 * self.scale).round() as i32;
        let hover_len = (56.0 * self.scale).round() as i32;
        let len = match (self.style, self.peeking) {
            ("arrow-only", _) => arrow_len,
            ("arrow", _) => line_len.max(arrow_len),
            ("hover", true) => line_len.max(hover_len),
            _ => line_len,
        }
        .clamp(1, span);
        let from = start + (span - len) / 2;
        along >= from && along < from + len
    }
}

/// 离屏幕边缘多近算"靠边"
pub const SNAP: i32 = 8;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Edge {
    Top,
    Left,
    Right,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Edge {
    /// 告诉前端缩到了哪条边,好在露出来的那一条上画标识
    pub fn name(self) -> &'static str {
        match self {
            Edge::Top => "top",
            Edge::Left => "left",
            Edge::Right => "right",
        }
    }
}

impl Rect {
    pub fn new(x: i32, y: i32, w: i32, h: i32) -> Self {
        Rect { x, y, w, h }
    }

    pub fn contains(&self, px: i32, py: i32) -> bool {
        px >= self.x && px < self.x + self.w && py >= self.y && py < self.y + self.h
    }

    /// 向外扩 `m` 像素后是否包含这个点
    pub fn contains_with_margin(&self, px: i32, py: i32, m: i32) -> bool {
        Rect::new(self.x - m, self.y - m, self.w + 2 * m, self.h + 2 * m).contains(px, py)
    }
}

/// `mon` 的 `edge` 那条边外面有没有接着另一块显示器。`win` 只用来取沿着边的那个坐标。
/// 那条边外面如果还接着另一块显示器,窗口缩过去会露在那块屏幕上,所以不算。
pub fn edge_is_free(edge: Edge, win: Rect, mon: Rect, monitors: &[Rect]) -> bool {
    let free = |px: i32, py: i32| !monitors.iter().any(|m| m.contains(px, py));
    match edge {
        Edge::Top => free(win.x + win.w / 2, mon.y - 1),
        Edge::Left => free(mon.x - 1, win.y + win.h / 2),
        Edge::Right => free(mon.x + mon.w, win.y + win.h / 2),
    }
}

/// 窗口贴着显示器 `mon` 的哪条边。只认外侧的边:那条边外面如果还接着另一块显示器,
/// 窗口缩过去会露在那块屏幕上,所以不算。
pub fn docked_edge(win: Rect, mon: Rect, monitors: &[Rect]) -> Option<Edge> {
    if win.y <= mon.y + SNAP && edge_is_free(Edge::Top, win, mon, monitors) {
        Some(Edge::Top)
    } else if win.x <= mon.x + SNAP && edge_is_free(Edge::Left, win, mon, monitors) {
        Some(Edge::Left)
    } else if win.x + win.w >= mon.x + mon.w - SNAP
        && edge_is_free(Edge::Right, win, mon, monitors)
    {
        Some(Edge::Right)
    } else {
        None
    }
}

/// 窗口和显示器重叠得最多的那块;一块都不重叠就取中心最近的。
pub fn nearest_monitor(win: Rect, monitors: &[Rect]) -> Option<Rect> {
    let overlap = |m: &Rect| {
        let w = (win.x + win.w).min(m.x + m.w) - win.x.max(m.x);
        let h = (win.y + win.h).min(m.y + m.h) - win.y.max(m.y);
        if w > 0 && h > 0 {
            i64::from(w) * i64::from(h)
        } else {
            0
        }
    };
    let distance = |m: &Rect| {
        let dx = i64::from(win.x + win.w / 2 - (m.x + m.w / 2));
        let dy = i64::from(win.y + win.h / 2 - (m.y + m.h / 2));
        dx * dx + dy * dy
    };
    monitors
        .iter()
        .copied()
        .min_by_key(|m| (std::cmp::Reverse(overlap(m)), distance(m)))
}

/// 缩进去以后窗口的位置:只露出 LINE_STRIP 宽的一条(测试里用;程序里按样式选宽度)
#[cfg(test)]
pub fn hidden_position(edge: Edge, win: Rect, mon: Rect) -> (i32, i32) {
    hidden_position_with_strip(edge, win, mon, LINE_STRIP)
}

pub fn hidden_position_with_strip(edge: Edge, win: Rect, mon: Rect, strip: i32) -> (i32, i32) {
    match edge {
        Edge::Top => (win.x, mon.y - win.h + strip),
        Edge::Left => (mon.x - win.w + strip, win.y),
        Edge::Right => (mon.x + mon.w - strip, win.y),
    }
}

/// 一块显示器:物理范围、缩放比例和系统给它起的名字
#[derive(Clone, Debug, PartialEq)]
pub struct Screen {
    pub rect: Rect,
    pub scale: f64,
    pub name: String,
}

/// 窗口沿着 `edge` 那条边的起点离显示器起点多远,换成逻辑像素,换了分辨率或缩放也能对上
pub fn along_offset(edge: Edge, win: Rect, mon: Rect, scale: f64) -> f64 {
    let (pos, origin) = match edge {
        Edge::Top => (win.x, mon.x),
        Edge::Left | Edge::Right => (win.y, mon.y),
    };
    f64::from(pos - origin) / scale
}

/// 找回藏起来时所在的那块显示器:范围完全一样的优先,其次是大小和名字都一样的,
/// 再次是大小一样且只有一块的(重新接上后位置或名字可能变)。
pub fn find_home(rect: Rect, name: &str, screens: &[Screen]) -> Option<usize> {
    if let Some(i) = screens.iter().position(|s| s.rect == rect) {
        return Some(i);
    }
    let same_size: Vec<usize> = (0..screens.len())
        .filter(|&i| screens[i].rect.w == rect.w && screens[i].rect.h == rect.h)
        .collect();
    same_size
        .iter()
        .copied()
        .find(|&i| screens[i].name == name)
        .or_else(|| (same_size.len() == 1).then(|| same_size[0]))
}

/// 显示器变了(拔掉、重新接上、分辨率或缩放改变)以后,藏起来的窗口该在的位置:
/// 还是贴着原来那条边;沿着边的起点是 `offset`(逻辑像素,离原显示器起点的距离)
/// 按这块屏幕的缩放换算出来的,只有窗口中心跑出屏幕外时才拉回来。
pub fn rehide_position(edge: Edge, win: Rect, mon: Rect, scale: f64, strip: i32, offset: f64) -> (i32, i32) {
    let (x, y) = hidden_position_with_strip(edge, win, mon, strip);
    let pull_back = |pos: i32, len: i32, start: i32, span: i32| {
        if pos + len / 2 >= start && pos + len / 2 < start + span {
            pos
        } else if len >= span {
            start
        } else {
            pos.clamp(start, start + span - len)
        }
    };
    let shift = (offset * scale).round() as i32;
    match edge {
        Edge::Top => (pull_back(mon.x + shift, win.w, mon.x, mon.w), y),
        Edge::Left | Edge::Right => (x, pull_back(mon.y + shift, win.h, mon.y, mon.h)),
    }
}

/// 滑出来以后窗口的位置:正好贴着那条边
pub fn shown_position(edge: Edge, win: Rect, mon: Rect) -> (i32, i32) {
    match edge {
        Edge::Top => (win.x, mon.y),
        Edge::Left => (mon.x, win.y),
        Edge::Right => (mon.x + mon.w - win.w, win.y),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Rect = Rect {
        x: 0,
        y: 0,
        w: 1920,
        h: 1080,
    };

    #[test]
    fn detects_each_edge_of_a_single_screen() {
        let mons = [SCREEN];
        assert_eq!(
            docked_edge(Rect::new(300, 0, 400, 500), SCREEN, &mons),
            Some(Edge::Top)
        );
        assert_eq!(
            docked_edge(Rect::new(300, -20, 400, 500), SCREEN, &mons),
            Some(Edge::Top)
        );
        assert_eq!(
            docked_edge(Rect::new(3, 200, 400, 500), SCREEN, &mons),
            Some(Edge::Left)
        );
        assert_eq!(
            docked_edge(Rect::new(1520, 200, 400, 500), SCREEN, &mons),
            Some(Edge::Right)
        );
        assert_eq!(
            docked_edge(Rect::new(300, 200, 400, 500), SCREEN, &mons),
            None
        );
        // 靠在底边不隐藏
        assert_eq!(
            docked_edge(Rect::new(300, 580, 400, 500), SCREEN, &mons),
            None
        );
    }

    #[test]
    fn ignores_edges_shared_with_another_monitor() {
        let right = Rect::new(1920, 0, 1920, 1080);
        let mons = [SCREEN, right];
        // 左屏的右边挨着右屏,不能往那边缩
        assert_eq!(
            docked_edge(Rect::new(1520, 200, 400, 500), SCREEN, &mons),
            None
        );
        // 右屏的左边同理
        assert_eq!(
            docked_edge(Rect::new(1922, 200, 400, 500), right, &mons),
            None
        );
        // 右屏的右边是外侧,可以
        assert_eq!(
            docked_edge(Rect::new(3440, 200, 400, 500), right, &mons),
            Some(Edge::Right)
        );
        // 上下摆放时,下面那块屏的上边不算
        let below = Rect::new(0, 1080, 1920, 1080);
        assert_eq!(
            docked_edge(Rect::new(300, 1080, 400, 500), below, &[SCREEN, below]),
            None
        );
    }

    #[test]
    fn hide_and_show_positions_round_trip() {
        let win = Rect::new(300, 0, 400, 500);
        let (hx, hy) = hidden_position(Edge::Top, win, SCREEN);
        assert_eq!((hx, hy), (300, -500 + LINE_STRIP));
        let hidden = Rect::new(hx, hy, win.w, win.h);
        // 露出来的那条边能碰到
        assert!(hidden.contains(320, 0));
        assert!(hidden.contains(320, LINE_STRIP - 1));
        assert!(!hidden.contains(320, LINE_STRIP));
        assert_eq!(shown_position(Edge::Top, hidden, SCREEN), (300, 0));

        let win = Rect::new(1520, 100, 400, 500);
        let (hx, hy) = hidden_position(Edge::Right, win, SCREEN);
        assert_eq!((hx, hy), (1920 - LINE_STRIP, 100));
        assert_eq!(
            shown_position(Edge::Right, Rect::new(hx, hy, 400, 500), SCREEN),
            (1520, 100)
        );

        let win = Rect::new(0, 100, 400, 500);
        let (hx, hy) = hidden_position(Edge::Left, win, SCREEN);
        assert_eq!((hx, hy), (-400 + LINE_STRIP, 100));
        assert!(Rect::new(hx, hy, 400, 500).contains(0, 300));
        assert_eq!(
            shown_position(Edge::Left, Rect::new(hx, hy, 400, 500), SCREEN),
            (0, 100)
        );
    }

    #[test]
    fn each_style_leaves_its_own_strip_on_all_edges() {
        assert_eq!(strip_for("line", false, 2, false), LINE_STRIP);
        assert_eq!(strip_for("line", true, 2, false), LINE_STRIP);
        assert_eq!(strip_for("arrow", false, 2, false), ARROW_STRIP);
        assert_eq!(strip_for("arrow-only", false, 2, false), ARROW_STRIP);
        assert_eq!(strip_for("hover", false, 2, false), LINE_STRIP);
        assert_eq!(strip_for("hover", true, 2, false), PEEK_STRIP);
        let win = Rect::new(300, 0, 400, 500);
        let s = strip_for("hover", true, 2, false);
        assert_eq!(
            hidden_position_with_strip(Edge::Top, win, SCREEN, s),
            (300, -500 + s)
        );
        assert_eq!(
            hidden_position_with_strip(Edge::Left, win, SCREEN, s),
            (-400 + s, 0)
        );
        assert_eq!(
            hidden_position_with_strip(Edge::Right, win, SCREEN, s),
            (1920 - s, 0)
        );
    }

    #[test]
    fn configurable_thickness_changes_exposed_width_without_affecting_arrow_modes() {
        for width in [1, 4, 8, 12] {
            assert_eq!(strip_for("line", false, width, false), width as i32);
            assert_eq!(strip_for("hover", false, width, false), width as i32);
            assert_eq!(strip_for("hover", true, width, false), PEEK_STRIP);
            assert_eq!(strip_for("arrow", false, width, false), ARROW_STRIP);
            assert_eq!(strip_for("arrow-only", false, width, false), ARROW_STRIP);
        }
        assert_eq!(strip_for("line", false, 0, false), 1);
        assert_eq!(strip_for("line", false, 100, false), 12);
        let win = Rect::new(300, 0, 400, 500);
        assert_eq!(
            hidden_position_with_strip(Edge::Top, win, SCREEN, strip_for("line", false, 8, false)),
            (300, -492)
        );
        assert_eq!(
            hidden_position_with_strip(Edge::Left, win, SCREEN, strip_for("line", false, 8, false)),
            (-392, 0)
        );
        assert_eq!(
            hidden_position_with_strip(
                Edge::Right,
                win,
                SCREEN,
                strip_for("line", false, 8, false)
            ),
            (1912, 0)
        );
    }

    #[test]
    fn glow_keeps_original_hit_strip_thickness() {
        for width in [1, 2, 3, 7, 12] {
            assert_eq!(strip_for("line", false, width, true), width as i32);
            assert_eq!(strip_for("hover", false, width, true), width as i32);
        }
        assert_eq!(strip_for("hover", true, 2, true), PEEK_STRIP);
        assert_eq!(strip_for("arrow", false, 2, true), ARROW_STRIP);
        assert_eq!(strip_for("arrow-only", false, 2, true), ARROW_STRIP);
    }

    #[test]
    fn short_line_is_only_interactive_where_it_is_drawn_on_each_edge() {
        let top = IndicatorHotzone {
            edge: Edge::Top,
            win: Rect::new(300, -498, 400, 500),
            mon: SCREEN,
            style: "line",
            length_percent: 40,
            length_unit: "percent",
            length_px: 120,
            peeking: false,
            scale: 1.0,
        };
        // 40% of 400 = 160, centered from x=420 to x=580.
        assert!(!top.contains(320, 0));
        assert!(top.contains(500, 1));
        assert!(!top.contains(580, 1));
        assert!(!top.contains(500, 3));

        let left = IndicatorHotzone {
            edge: Edge::Left,
            win: Rect::new(-398, 100, 400, 500),
            length_percent: 20,
            ..top
        };
        // 20% of 500 = 100, centered from y=300 to y=400.
        assert!(!left.contains(0, 125));
        assert!(left.contains(1, 350));
        assert!(!left.contains(2, 350));
        let right = IndicatorHotzone {
            edge: Edge::Right,
            win: Rect::new(1918, 100, 400, 500),
            ..left
        };
        assert!(right.contains(1919, 350));
        assert!(!right.contains(1919, 450));
    }

    #[test]
    fn fixed_pixel_hit_area_stays_constant_when_window_changes_size() {
        let base = IndicatorHotzone {
            edge: Edge::Top,
            win: Rect::new(300, -498, 400, 500),
            mon: SCREEN,
            style: "line",
            length_percent: 40,
            length_unit: "px",
            length_px: 100,
            peeking: false,
            scale: 1.0,
        };
        assert!(base.contains(451, 1));
        assert!(base.contains(549, 1));
        assert!(!base.contains(449, 1));
        let wider = IndicatorHotzone {
            win: Rect::new(300, -498, 600, 500),
            ..base
        };
        assert!(wider.contains(551, 1));
        assert!(!wider.contains(549, 1));
        assert!(!wider.contains(651, 1));
        let hidpi = IndicatorHotzone {
            win: Rect::new(300, -497, 600, 500),
            length_px: 100,
            scale: 1.5,
            ..base
        };
        assert!(hidpi.contains(525, 1));
        assert!(!hidpi.contains(525, 4));
        let left = IndicatorHotzone {
            edge: Edge::Left,
            win: Rect::new(-398, 100, 400, 500),
            ..base
        };
        assert!(left.contains(1, 350));
        assert!(!left.contains(1, 290));
        let right = IndicatorHotzone {
            edge: Edge::Right,
            win: Rect::new(1918, 100, 400, 500),
            ..base
        };
        assert!(right.contains(1919, 350));
        assert!(!right.contains(1919, 290));
    }

    #[test]
    fn arrow_and_hover_targets_are_centered_and_scale_for_dpi() {
        let arrow = IndicatorHotzone {
            edge: Edge::Top,
            win: Rect::new(300, -482, 400, 500),
            mon: SCREEN,
            style: "arrow-only",
            length_percent: 10,
            length_unit: "percent",
            length_px: 120,
            peeking: false,
            scale: 1.0,
        };
        assert!(arrow.contains(500, 4));
        assert!(!arrow.contains(475, 4));
        let high_dpi = IndicatorHotzone {
            scale: 2.0,
            ..arrow
        };
        assert!(high_dpi.contains(470, 4));
        let with_line = IndicatorHotzone {
            style: "arrow",
            ..arrow
        };
        assert!(with_line.contains(480, 4));
        let hover = IndicatorHotzone {
            edge: Edge::Left,
            win: Rect::new(-368, 100, 400, 500),
            style: "hover",
            peeking: true,
            ..arrow
        };
        assert!(hover.contains(0, 350));
        assert!(!hover.contains(0, 270));
        let resting = IndicatorHotzone {
            peeking: false,
            ..hover
        };
        assert!(resting.contains(0, 350));
    }

    #[test]
    fn nearest_monitor_prefers_overlap_then_distance() {
        let right = Rect::new(1920, 0, 1920, 1080);
        let mons = [SCREEN, right];
        assert_eq!(
            nearest_monitor(Rect::new(1700, 100, 400, 500), &mons),
            Some(SCREEN)
        );
        assert_eq!(
            nearest_monitor(Rect::new(1900, 100, 400, 500), &mons),
            Some(right)
        );
        // 完全在所有屏幕外面:取中心最近的
        assert_eq!(
            nearest_monitor(Rect::new(-1000, 100, 400, 500), &mons),
            Some(SCREEN)
        );
        assert_eq!(nearest_monitor(SCREEN, &[]), None);
    }

    #[test]
    fn edge_is_free_only_on_outer_sides() {
        let right = Rect::new(1920, 0, 1920, 1080);
        let mons = [SCREEN, right];
        let win = Rect::new(300, 200, 400, 500);
        assert!(edge_is_free(Edge::Top, win, SCREEN, &mons));
        assert!(edge_is_free(Edge::Left, win, SCREEN, &mons));
        assert!(!edge_is_free(Edge::Right, win, SCREEN, &mons));
        assert!(edge_is_free(Edge::Right, win, SCREEN, &[SCREEN]));
    }

    #[test]
    fn rehide_keeps_the_edge_and_pulls_back_only_when_off_screen() {
        let win = Rect::new(300, 100, 400, 500);
        // 位置本来就对:不动
        assert_eq!(
            rehide_position(Edge::Right, win, SCREEN, 1.0, 2, 100.0),
            hidden_position_with_strip(Edge::Right, win, SCREEN, 2)
        );
        // 分辨率变小后窗口跑到屏幕下面:拉回来,仍然贴右边
        let small = Rect::new(0, 0, 1280, 720);
        let lost = Rect::new(900, 1000, 400, 500);
        assert_eq!(
            rehide_position(Edge::Right, lost, small, 1.0, 2, 1000.0),
            (1278, 220)
        );
        // 窗口比屏幕还高:顶着上沿
        let tall = Rect::new(900, 1000, 400, 900);
        assert_eq!(
            rehide_position(Edge::Left, tall, small, 1.0, 2, 1000.0),
            (-398, 0)
        );
        // 贴上边时横向半个窗口还在屏幕内:保持原来的横向位置
        let overhang = Rect::new(-100, -498, 400, 500);
        assert_eq!(
            rehide_position(Edge::Top, overhang, SCREEN, 1.0, 2, -100.0),
            (-100, -498)
        );
        // 横向完全跑到屏幕外:拉回来
        let gone = Rect::new(2500, -498, 400, 500);
        assert_eq!(
            rehide_position(Edge::Top, gone, SCREEN, 1.0, 2, 2500.0),
            (1520, -498)
        );
    }

    #[test]
    fn position_along_the_edge_follows_the_original_monitor_in_logical_units() {
        // 4K 外接屏(缩放 2.0,逻辑 1920x1080)在右,2K 笔记本屏(缩放 1.5)在左
        let laptop = Rect::new(0, 0, 2560, 1440);
        let external = Rect::new(2560, 0, 3840, 2160);
        // 窗口藏在外接屏右边,沿边起点在屏幕上方 600 物理像素处 = 逻辑 300
        let win = Rect::new(2560 + 3840 - 2, 600, 800, 1000);
        let offset = along_offset(Edge::Right, win, external, 2.0);
        assert_eq!(offset, 300.0);
        // 外接屏关掉后窗口停在笔记本屏右边,同样的逻辑偏移
        let parked = Rect::new(2558, 0, 600, 750);
        assert_eq!(
            rehide_position(Edge::Right, parked, laptop, 1.5, 2, offset),
            (2558, 450)
        );
        // 外接屏回来后回到原来的物理位置
        let moved = Rect::new(2558, 450, 800, 1000);
        assert_eq!(
            rehide_position(Edge::Right, moved, external, 2.0, 4, offset),
            (2560 + 3840 - 4, 600)
        );
        // 上边:横向偏移同样按逻辑像素
        let top = Rect::new(2560 + 400, -998, 800, 1000);
        let offset = along_offset(Edge::Top, top, external, 2.0);
        assert_eq!(offset, 200.0);
        assert_eq!(
            rehide_position(Edge::Top, Rect::new(0, -748, 600, 750), laptop, 1.5, 3, offset),
            (300, -747)
        );
    }

    #[test]
    fn find_home_matches_range_then_size_and_name() {
        let screen = |x, y, w, h, name: &str| Screen {
            rect: Rect::new(x, y, w, h),
            scale: 1.0,
            name: name.into(),
        };
        let laptop = screen(0, 0, 2560, 1440, "DISPLAY1");
        let external = screen(2560, 0, 3840, 2160, "DISPLAY2");
        let both = [laptop.clone(), external.clone()];
        // 范围完全一样
        assert_eq!(find_home(external.rect, "DISPLAY2", &both), Some(1));
        // 接回来后位置变了,只有一块一样大
        let moved = [laptop.clone(), screen(-3840, 0, 3840, 2160, "DISPLAY3")];
        assert_eq!(find_home(external.rect, "DISPLAY2", &moved), Some(1));
        // 外接屏没回来
        assert_eq!(find_home(external.rect, "DISPLAY2", &[laptop.clone()]), None);
        // 两块一样大:认名字
        let twins = [
            screen(0, 0, 1920, 1080, "A"),
            screen(1920, 0, 1920, 1080, "B"),
        ];
        assert_eq!(find_home(Rect::new(5000, 0, 1920, 1080), "B", &twins), Some(1));
        assert_eq!(find_home(Rect::new(5000, 0, 1920, 1080), "C", &twins), None);
    }

    #[test]
    fn margin_check() {
        let r = Rect::new(10, 10, 100, 100);
        assert!(!r.contains(8, 50));
        assert!(r.contains_with_margin(8, 50, 2));
        assert!(!r.contains_with_margin(7, 50, 2));
    }
}
