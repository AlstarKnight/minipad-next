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

/// 只允许在真正绘制的线段（或中央箭头、悬浮按钮）范围内唤醒窗口。
/// 坐标、窗口大小和显示器边界均为物理像素。
pub fn indicator_contains(
    edge: Edge,
    win: Rect,
    mon: Rect,
    px: i32,
    py: i32,
    style: &str,
    length_percent: u32,
    peeking: bool,
    scale: f64,
) -> bool {
    let (along, start, span, across) = match edge {
        Edge::Top => (px, win.x, win.w, py >= mon.y && py < win.y + win.h),
        Edge::Left => (py, win.y, win.h, px >= mon.x && px < win.x + win.w),
        Edge::Right => (
            py,
            win.y,
            win.h,
            px >= win.x && px < mon.x + mon.w,
        ),
    };
    if !across || span <= 0 {
        return false;
    }
    let pct = length_percent.clamp(10, 100) as i64;
    let line_len = (i64::from(span) * pct / 100) as i32;
    // 箭头和悬浮按钮保留居中的独立点击范围，不影响短线两端的空白。
    let arrow_len = (36.0 * scale).round() as i32;
    let hover_len = (56.0 * scale).round() as i32;
    let len = match (style, peeking) {
        ("arrow-only", _) => arrow_len,
        ("arrow", _) => line_len.max(arrow_len),
        ("hover", true) => line_len.max(hover_len),
        _ => line_len,
    }
    .clamp(1, span);
    let from = start + (span - len) / 2;
    along >= from && along < from + len
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

/// 窗口贴着显示器 `mon` 的哪条边。只认外侧的边:那条边外面如果还接着另一块显示器,
/// 窗口缩过去会露在那块屏幕上,所以不算。
pub fn docked_edge(win: Rect, mon: Rect, monitors: &[Rect]) -> Option<Edge> {
    let free = |px: i32, py: i32| !monitors.iter().any(|m| m.contains(px, py));
    if win.y <= mon.y + SNAP && free(win.x + win.w / 2, mon.y - 1) {
        Some(Edge::Top)
    } else if win.x <= mon.x + SNAP && free(mon.x - 1, win.y + win.h / 2) {
        Some(Edge::Left)
    } else if win.x + win.w >= mon.x + mon.w - SNAP && free(mon.x + mon.w, win.y + win.h / 2) {
        Some(Edge::Right)
    } else {
        None
    }
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
        let win_top = Rect::new(300, -498, 400, 500);
        // 40% of 400 = 160 pixels, centered from x=420 to x=580.
        assert!(!indicator_contains(Edge::Top, win_top, SCREEN, 320, 0, "line", 40, false, 1.0));
        assert!(indicator_contains(Edge::Top, win_top, SCREEN, 500, 1, "line", 40, false, 1.0));
        assert!(!indicator_contains(Edge::Top, win_top, SCREEN, 580, 1, "line", 40, false, 1.0));
        assert!(!indicator_contains(Edge::Top, win_top, SCREEN, 500, 3, "line", 40, false, 1.0));

        let win_left = Rect::new(-398, 100, 400, 500);
        // 20% of 500 = 100 pixels, centered from y=300 to y=400.
        assert!(!indicator_contains(Edge::Left, win_left, SCREEN, 0, 125, "line", 20, false, 1.0));
        assert!(indicator_contains(Edge::Left, win_left, SCREEN, 1, 350, "line", 20, false, 1.0));
        assert!(!indicator_contains(Edge::Left, win_left, SCREEN, 2, 350, "line", 20, false, 1.0));
        let win_right = Rect::new(1918, 100, 400, 500);
        assert!(indicator_contains(Edge::Right, win_right, SCREEN, 1919, 350, "line", 20, false, 1.0));
        assert!(!indicator_contains(Edge::Right, win_right, SCREEN, 1919, 450, "line", 20, false, 1.0));
    }

    #[test]
    fn arrow_and_hover_targets_are_centered_and_scale_for_dpi() {
        let win = Rect::new(300, -482, 400, 500);
        assert!(indicator_contains(Edge::Top, win, SCREEN, 500, 4, "arrow-only", 10, false, 1.0));
        assert!(!indicator_contains(Edge::Top, win, SCREEN, 475, 4, "arrow-only", 10, false, 1.0));
        assert!(indicator_contains(Edge::Top, win, SCREEN, 470, 4, "arrow-only", 10, false, 2.0));
        assert!(indicator_contains(Edge::Top, win, SCREEN, 480, 4, "arrow", 10, false, 1.0));
        let hover = Rect::new(-368, 100, 400, 500);
        assert!(indicator_contains(Edge::Left, hover, SCREEN, 0, 350, "hover", 10, true, 1.0));
        assert!(!indicator_contains(Edge::Left, hover, SCREEN, 0, 270, "hover", 10, true, 1.0));
        assert!(indicator_contains(Edge::Left, hover, SCREEN, 0, 350, "hover", 10, false, 1.0));
    }

    #[test]
    fn margin_check() {
        let r = Rect::new(10, 10, 100, 100);
        assert!(!r.contains(8, 50));
        assert!(r.contains_with_margin(8, 50, 2));
        assert!(!r.contains_with_margin(7, 50, 2));
    }
}
