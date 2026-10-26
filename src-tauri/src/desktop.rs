mod backup;
mod ball;
mod edge;
mod images;
mod mini;
mod minipad2;
mod notes;

use edge::{Edge, Rect};
use notes::Book;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// 0.1.x 用的应用标识符。0.2.0 换了标识符,启动时把旧位置的设置和笔记搬过来。
const OLD_IDENTIFIER: &str = "com.minipadnext.app";

/// F5 插入日期时间的默认格式,和中文 Windows 记事本一样,比如 13:45 2026/10/11
const DEFAULT_DATE_FORMAT: &str = "H:mm yyyy/M/d";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Geom {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
}

impl Default for Geom {
    fn default() -> Self {
        Geom {
            x: 0,
            y: 0,
            w: 440,
            h: 540,
        }
    }
}

/// 片段(0.5.1):打 trigger 再按 Tab(或空格)换成 text
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Snippet {
    trigger: String,
    text: String,
}

fn default_snippets() -> Vec<Snippet> {
    [
        (";rq", "{{日期}}"),
        (";sj", "{{时间}}"),
        (";xq", "{{星期}}"),
    ]
    .map(|(trigger, text)| Snippet {
        trigger: trigger.into(),
        text: text.into(),
    })
    .to_vec()
}

const DEFAULT_CAPTURE_PAGE: &str = "收集箱";
const DEFAULT_CAPTURE_NAME: &str = "快速记录 {{日期}} {{时间:HH.mm}}";
const DEFAULT_TEMPLATE_BOOK: &str = "模板";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Settings {
    hotkey: String,
    always_on_top: bool,
    /// 启动时检查 GitHub 上有没有新版本,有就在状态栏提示
    update_check: bool,
    edge_hide: bool,
    /// arrow 细线+箭头 / arrow-only 只有箭头 / line 仅细线 / hover 悬浮按钮
    edge_style: String,
    /// 细线粗细，逻辑像素，1..=12
    edge_line_width: u32,
    /// 细线占所在窗口边长的百分比，10..=100
    edge_line_length: u32,
    /// percent 沿用旧值；px 为固定的逻辑像素长度。
    edge_line_length_unit: String,
    edge_line_length_px: u32,
    /// 细线微光效果（默认关闭）
    edge_line_glow: bool,
    /// 顶栏显示「贴边隐藏 / 一直显示」的切换按钮
    edge_button: bool,
    /// 贴边标识的颜色,写法同 accent;空着跟随强调色
    edge_color: String,
    show_in_taskbar: bool,
    autostart: bool,
    theme: String,
    /// 界面风格(0.4.4):starry 星空渐变 / material / paper 语雀纸感 / classic 原来的样子
    ui_style: String,
    /// 语雀纸感的目录侧栏
    ui_tree: bool,
    /// 星空渐变的笔记本侧栏
    ui_rail: bool,
    /// 星空渐变深色时顶栏的星光
    ui_stars: bool,
    /// 强调色:空着跟随界面风格,"#3b82f6" 是纯色,"linear-gradient(135deg, #a, #b)" 是渐变色
    accent: String,
    /// 只读取旧配置供首次迁移，不再写回 settings.json。
    #[serde(skip_serializing)]
    book_color_presets: Vec<String>,
    /// 全局共享预设，保留以迁移 0.3.4 设置。
    color_presets: Option<Vec<String>>,
    /// 0.3.5 可编辑的全局颜色库，None 表示沿用内置和旧预设；Some([]) 表示用户已全部删除。
    color_library: Option<Vec<String>>,
    /// 0.3.10 及以前的快捷色个数（颜色库的前几个）；只在还没有 quick_colors 时使用。
    quick_color_count: u32,
    /// 0.3.11 起单独保存的快捷色（颜色库里的颜色，按显示顺序）；None 表示沿用 quick_color_count。
    quick_colors: Option<Vec<String>>,
    /// 颜色库已经补过的内置颜色版本，新版本加的预设只补一次。
    color_library_rev: u32,
    /// 纯色快捷色上限，0 表示不限；在设置里改，拖动不会改它。
    quick_color_limit: u32,
    /// 渐变快捷色上限，0 表示不限。
    quick_gradient_limit: u32,
    /// 0.3.11 材质色库（金属、珠光等，也是渐变写法，所以和 color_library 分开存）；None 表示用内置的。
    material_library: Option<Vec<String>>,
    /// 材质快捷色上限，0 表示不限。
    quick_material_limit: u32,
    /// 颜色弹窗里纯色和渐变怎么摆:tabs 顶部切换,rows 两行同时显示
    color_layout: String,
    /// 打开颜色库时显示哪一类:remember 每个入口上次的、solid、gradient、follow 跟随当前颜色
    color_open_tab: String,
    /// 渐变色块形状:square 方块、bar 长条、round 圆形
    gradient_shape: String,
    /// 鼠标停在渐变色块上时显示它的名字
    gradient_names: bool,
    /// 活跃标签的高亮:line 顶部线条、fill 整个标签、border 整圈边框
    tab_style: String,
    font_size: u32,
    notes_dir: String,
    /// 编辑区显示行号
    line_numbers: bool,
    /// 按 F5 插入的日期时间格式,写法和 Windows 一样,比如 H:mm yyyy/M/d
    date_format: String,
    /// 代码块显示行号
    code_line_numbers: bool,
    /// 点代码块的语言时列出常用语言
    code_lang_menu: bool,
    /// 代码块标题旁显示选颜色的色块
    code_title_color: bool,
    /// 自动把裸邮箱识别为 mailto 链接；默认关闭，手动链接始终保留。
    email_auto_link: bool,
    /// 块管理手柄与块操作菜单的开关。
    block_enabled: bool,
    /// system / block，选中文字仍使用系统右键菜单。
    block_context_menu: String,
    /// blank3 / blank2 / ctrl
    code_exit_mode: String,
    /// 是否将折叠状态写入 Markdown；关闭时只调整界面显示。
    fold_save_state: bool,
    /// 标签下面显示格式栏
    format_bar: bool,
    /// 格式栏里不显示的按钮
    format_bar_hidden: Vec<String>,
    /// 格式栏按钮的顺序(按钮的名字,竖线分隔是 sep1、sep2…),空着就是默认顺序
    format_bar_order: Vec<String>,
    /// 每天第一次保存时把笔记文件夹打包备份
    backup_enabled: bool,
    /// 保留最近几份备份
    backup_keep: u32,
    /// 备份放在哪里,空着就用程序数据目录下的 backups
    backup_dir: String,
    /// 悬浮图标:开着时顶栏有个按钮,点了窗口缩成一个可以拖动的小图标
    ball_enabled: bool,
    /// 悬浮图标的大小(逻辑像素)
    ball_size: u32,
    /// 悬浮图标用什么图:app 应用图标 / custom 自己选的图片
    ball_icon: String,
    /// 给悬浮图标上色,写法同 accent;空着是原色
    ball_color: String,
    /// 悬浮图标的不透明度(百分比)
    ball_opacity: u32,
    /// 怎样打开:click 单击 / dblclick 双击
    ball_open: String,
    /// 悬浮图标上次的位置(物理像素)
    ball_pos: Option<[i32; 2]>,
    /// Ctrl+F 的作用:page 在当前页面里查找 / all 搜索全部页面
    ctrl_f: String,
    /// 查找栏放在哪:top 编辑区上方 / bottom 编辑区下方
    find_bar_pos: String,
    /// 查找结果的高亮颜色,写法同 accent;空着跟随强调色
    find_color: String,
    /// 同一页在这里和别处(网盘同步)都改过:copy 把那边的版本另存为冲突副本 / overwrite 用这边的覆盖
    conflict_mode: String,
    /// WebDAV 同步默认关闭，只有用户完成账号设置后才可运行。
    webdav_enabled: bool,
    webdav_server: String,
    webdav_user: String,
    webdav_folder: String,
    webdav_allow_http: bool,
    webdav_first_mode: String,
    webdav_images: bool,
    webdav_on_start: bool,
    webdav_after_save: bool,
    webdav_delay_seconds: u32,
    webdav_interval_minutes: u32,
    webdav_on_hide: bool,
    webdav_status_style: String,
    webdav_status_color: String,
    webdav_delete_limit: usize,
    webdav_delete_divisor: usize,
    /// 正文中识别 Windows 本地文件路径。
    local_path_enabled: bool,
    /// ctrl 按 Ctrl 点击 / click 单击。
    local_path_click: String,
    /// 路径文字颜色；空着跟随链接颜色。
    local_path_color: String,
    /// solid / dashed / none。
    local_path_underline: String,
    /// 对不存在的路径显示灰色删除线。
    local_path_missing: bool,
    /// 运行可执行文件或脚本之前进行确认。
    local_path_confirm: bool,
    /// 用户逐个允许跳过确认的本地路径。
    local_path_trusted: Vec<String>,
    /// 0.5.0 页面链接 [[页面名]]:显示成链接,点了打开那一页
    page_links: bool,
    /// ctrl 按 Ctrl 点击打开 / click 单击就打开
    page_link_click: String,
    /// 补全:brackets 打 [[ 就列出页面 / typing 打了 [[ 再打字才列 / off 不列
    page_link_suggest: String,
    /// 中文输入法打的 【【 换成 [[,链接里的 】】 换成 ]]
    page_link_cn_brackets: bool,
    /// 页面改名、移动以后别的页面里指向它的链接:ask 改 2 个以上页面时先问 / auto 直接改 / off 不改
    page_link_rename: String,
    /// 链接的颜色,写法同 accent;空着跟随强调色
    page_link_color: String,
    /// 还没有的页面的链接颜色,写法同 accent;空着是灰色
    page_link_broken_color: String,
    /// 两边的方括号:faint 淡一点 / show 照常显示 / hide 光标在链接上才显示
    page_link_brackets: String,
    /// 下划线:hover 鼠标移上去才有 / solid 实线 / dashed 虚线 / none 不要
    page_link_underline: String,
    /// 设置页面的分类放在哪:left 左边一列 / top 上面一排
    settings_nav: String,
    /// 悬浮目录:列出这一页的标题,点了跳过去
    outline_enabled: bool,
    /// hover 平时收起成短线、鼠标移上去展开 / pinned 一直展开在编辑区旁边
    outline_mode: String,
    /// 目录放在编辑区的 right 右边 / left 左边
    outline_side: String,
    /// 显示到几级标题(1–6)
    outline_depth: u32,
    /// 展开时的宽度(像素)
    outline_width: u32,
    /// 展开时背景的不透明度(百分比)
    outline_opacity: u32,
    /// 当前标题的颜色,写法同 accent;空着跟随强调色
    outline_color: String,
    /// 标签放不下时:scroll 一排滚动 / wrap 点按钮展开成多行 / drawer 收进侧拉的页面列表
    tab_overflow: String,
    /// 一排滚动时,还有标签藏着的那一端淡出去
    tab_fade: bool,
    /// 一排滚动时,放不下就在标签后面显示"全部页面"按钮
    tab_list_button: bool,
    /// 点开多行时最多显示几行(再多在里面上下滚)
    tab_rows: u32,
    /// 侧拉的页面列表从 left 左边 / right 右边拉出来
    tab_drawer_side: String,
    /// 侧拉列表的宽度(像素)
    tab_drawer_width: u32,
    /// 鼠标移到窗口那一边的边缘也拉出页面列表
    tab_drawer_hover: bool,
    /// 页面列表钉住,一直开在编辑区旁边
    tab_drawer_pinned: bool,
    /// 标签分组(像 Edge 那样有名字、颜色、能折叠)
    tab_groups: bool,
    /// 组里的标签怎么标出来:line 下面一条组的颜色 / tint 整个标签淡淡染上组的颜色
    tab_group_style: String,
    /// 固定的标签怎么标出来:icon 名字前面一个图钉 / tint 淡淡染上强调色 / none 不标(都排在最前面)
    pin_style: String,
    /// 快速切换页面的快捷键(窗口里的,写法同 hotkey),空着就不用
    quick_switch_key: String,
    /// 快速切换找哪些页面:all 全部笔记本 / book 当前笔记本
    quick_switch_scope: String,
    /// 找页面(快速切换、[[ 补全)时也能打拼音或拼音首字母
    pinyin_match: bool,
    /// 选中文字时的悬浮工具栏:always 总是出现 / nobar 只在格式栏收起时 / off 不出现
    sel_bar: String,
    /// 悬浮工具栏上的按钮(按顺序,id 同格式栏)
    sel_bar_items: Vec<String>,
    /// 悬浮工具栏放在选区的 above 上面 / below 下面(放不下时换到另一边)
    sel_bar_pos: String,
    /// 0.4.0 小窗:允许把页面放进单独的小窗
    mini_enabled: bool,
    /// 新开的小窗默认置顶
    mini_on_top: bool,
    /// 按热键显示 / 隐藏主窗口时小窗:follow 一起显示和隐藏 / independent 不受影响
    mini_hotkey: String,
    /// 新开的小窗的不透明度(百分比,40–100);鼠标移上去时不透明
    mini_opacity: u32,
    /// 重启后恢复上次开着的小窗
    mini_restore: bool,
    /// 最多同时打开几个小窗,0 表示不限
    mini_max: u32,
    /// 鼠标移到标签上时显示「在小窗中打开」的 ↗ 按钮
    mini_tab_button: bool,
    /// 0.4.0 粘贴、拖进来的图片存进笔记本文件夹里的 assets
    image_paste: bool,
    /// 图片显示多大:full 最宽铺满 / medium 最宽一半多 / small 小图
    image_size: String,
    /// 0.5.1 快速记录:全局热键弹出小窗,写进一个页面(或者新建一页)
    capture_enabled: bool,
    /// 快速记录的全局热键(写法同 hotkey),空着就只能从托盘菜单打开
    capture_hotkey: String,
    /// 写到:page 追加到一个页面 / new 每次新建一页
    capture_target: String,
    /// 写到哪个笔记本(「默认」是空字符串;不在了就用默认笔记本)
    capture_book: String,
    /// 追加到哪一页,没有就新建
    capture_page: String,
    /// 每次新建一页时的名字,可以用 {{日期}} 这些变量
    capture_name: String,
    /// 新的一条加在 end 末尾 / start 开头(页面以标题开头时放在标题下面)
    capture_where: String,
    /// 每一条是 paragraph 段落 / list 列表项 / task 待办
    capture_format: String,
    /// 每一条前面写上时间(格式同 F5)
    capture_stamp: bool,
    /// 小窗出现在 remember 上次的位置 / center 屏幕中间 / cursor 鼠标旁边
    capture_position: String,
    /// 0.5.1 模板放在哪个笔记本里:每一页就是一个模板
    template_book: String,
    /// 0.5.2 新建笔记本时放一页「欢迎」
    new_book_welcome: bool,
    /// 片段:打触发词再按 Tab(或空格)换成内容
    snippets: Vec<Snippet>,
    /// 片段怎么展开:tab / space / off
    snippet_key: String,
    /// 行内计算:tab 打完 = 再按 Tab / equals 打 = 就算 / off 不算
    calc_key: String,
    /// 结果的小数位:auto 最多 10 位、去掉末尾的 0 / "0".."6" 固定几位
    calc_decimals: String,
    /// 结果加千分位逗号
    calc_thousands: bool,
    /// 每页小窗的位置、大小、置顶和不透明度(程序自己记,保存设置时沿用这里的)
    mini_windows: Vec<mini::MiniWin>,
    /// 快速记录小窗的位置和大小(程序自己记,保存设置时沿用这里的)
    capture_window: Option<Geom>,
    window: Option<Geom>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            hotkey: "Ctrl+M".into(),
            always_on_top: true,
            update_check: true,
            edge_hide: true,
            edge_style: "arrow".into(),
            edge_line_width: edge::LINE_STRIP as u32,
            edge_line_length: 100,
            edge_line_length_unit: "percent".into(),
            edge_line_length_px: 120,
            edge_line_glow: false,
            edge_button: true,
            edge_color: String::new(),
            show_in_taskbar: false,
            autostart: false,
            theme: "system".into(),
            ui_style: "starry".into(),
            ui_tree: true,
            ui_rail: true,
            ui_stars: true,
            accent: String::new(),
            book_color_presets: Vec::new(),
            color_presets: None,
            color_library: None,
            quick_color_count: 5,
            quick_colors: None,
            color_library_rev: 0,
            quick_color_limit: 0,
            quick_gradient_limit: 0,
            material_library: None,
            quick_material_limit: 0,
            color_layout: "tabs".into(),
            color_open_tab: "remember".into(),
            gradient_shape: "square".into(),
            gradient_names: true,
            tab_style: "line".into(),
            font_size: 14,
            notes_dir: String::new(),
            line_numbers: false,
            date_format: DEFAULT_DATE_FORMAT.into(),
            code_line_numbers: true,
            code_lang_menu: true,
            code_title_color: true,
            email_auto_link: false,
            block_enabled: true,
            block_context_menu: "system".into(),
            code_exit_mode: "blank3".into(),
            fold_save_state: true,
            format_bar: true,
            format_bar_hidden: Vec::new(),
            format_bar_order: Vec::new(),
            backup_enabled: true,
            backup_keep: 14,
            backup_dir: String::new(),
            ball_enabled: false,
            ball_size: 48,
            ball_icon: "app".into(),
            ball_color: String::new(),
            ball_opacity: 100,
            ball_open: "click".into(),
            ball_pos: None,
            ctrl_f: "page".into(),
            find_bar_pos: "top".into(),
            find_color: String::new(),
            conflict_mode: "copy".into(),
            webdav_enabled: false,
            webdav_server: String::new(),
            webdav_user: String::new(),
            webdav_folder: "/MinipadNext/".into(),
            webdav_allow_http: false,
            webdav_first_mode: "merge".into(),
            webdav_images: true,
            webdav_on_start: true,
            webdav_after_save: true,
            webdav_delay_seconds: 30,
            webdav_interval_minutes: 5,
            webdav_on_hide: true,
            webdav_status_style: "icon".into(),
            webdav_status_color: String::new(),
            webdav_delete_limit: 20,
            webdav_delete_divisor: 3,
            local_path_enabled: true,
            local_path_click: "ctrl".into(),
            local_path_color: String::new(),
            local_path_underline: "dashed".into(),
            local_path_missing: true,
            local_path_confirm: true,
            local_path_trusted: Vec::new(),
            page_links: true,
            page_link_click: "ctrl".into(),
            page_link_suggest: "brackets".into(),
            page_link_cn_brackets: true,
            page_link_rename: "ask".into(),
            page_link_color: String::new(),
            page_link_broken_color: String::new(),
            page_link_brackets: "faint".into(),
            page_link_underline: "hover".into(),
            settings_nav: "left".into(),
            outline_enabled: false,
            outline_mode: "hover".into(),
            outline_side: "right".into(),
            outline_depth: 3,
            outline_width: 200,
            outline_opacity: 100,
            outline_color: String::new(),
            tab_overflow: "scroll".into(),
            tab_fade: true,
            tab_list_button: true,
            tab_rows: 4,
            tab_drawer_side: "left".into(),
            tab_drawer_width: 200,
            tab_drawer_hover: false,
            tab_drawer_pinned: false,
            tab_groups: false,
            tab_group_style: "line".into(),
            pin_style: "icon".into(),
            quick_switch_key: "Ctrl+P".into(),
            quick_switch_scope: "all".into(),
            pinyin_match: true,
            sel_bar: "always".into(),
            sel_bar_items: [
                "block", "strong", "em", "strike", "code", "link", "sep3", "color", "bg",
            ]
            .map(String::from)
            .to_vec(),
            sel_bar_pos: "above".into(),
            mini_enabled: true,
            mini_on_top: true,
            mini_hotkey: "follow".into(),
            mini_opacity: 100,
            mini_restore: true,
            mini_max: 0,
            mini_tab_button: true,
            image_paste: true,
            image_size: "full".into(),
            capture_enabled: true,
            capture_hotkey: "Ctrl+Alt+M".into(),
            capture_target: "page".into(),
            capture_book: String::new(),
            capture_page: DEFAULT_CAPTURE_PAGE.into(),
            capture_name: DEFAULT_CAPTURE_NAME.into(),
            capture_where: "end".into(),
            capture_format: "paragraph".into(),
            capture_stamp: true,
            capture_position: "remember".into(),
            template_book: DEFAULT_TEMPLATE_BOOK.into(),
            new_book_welcome: true,
            snippets: default_snippets(),
            snippet_key: "tab".into(),
            calc_key: "tab".into(),
            calc_decimals: "auto".into(),
            calc_thousands: false,
            mini_windows: Vec::new(),
            capture_window: None,
            window: None,
        }
    }
}

#[derive(Serialize)]
struct LoadedState {
    settings: Settings,
    settings_error: Option<String>,
    /// 设置文件损坏、已改名留底时给用户的提示(启动后只返回一次)
    settings_notice: Option<String>,
    notes_dir: String,
    /// 全部笔记本,「默认」(名字是空字符串)在最前
    books: Vec<Book>,
    /// 当前打开的笔记本
    book: String,
    /// 启动时热键注册失败的原因(比如被别的软件占用了)
    hotkey_error: Option<String>,
    /// 快速记录的热键注册失败的原因
    capture_error: Option<String>,
    version: String,
    debug: bool,
}

#[derive(Default)]
struct EdgeState {
    hidden: Option<Edge>,
    /// 「细边 + 悬浮按钮」样式下,鼠标靠近后按钮已经浮出
    peeking: bool,
    /// 隐藏时所在显示器的范围
    monitor: Rect,
    /// 藏起来时的显示器和窗口沿边的位置,显示器断开又接回来后靠它贴回原处
    home: Option<EdgeHome>,
    outside_ticks: u32,
}

/// 窗口藏起来时所在的显示器,和窗口沿着那条边离显示器起点多远(逻辑像素)
struct EdgeHome {
    rect: Rect,
    name: String,
    offset: f64,
}

#[derive(Default)]
struct QuitState {
    active: Option<u64>,
    waiting_ack: bool,
}

#[derive(Default)]
struct AppState {
    settings: Mutex<Settings>,
    /// 自定义悬浮图片缓存，避免重复读磁盘和 base64 编码。
    ball_image_cache: Mutex<ball::ImageCache>,
    /// 配置文件不存在、成功读取或损坏的原文件已改名留底时才可以写回。读不出来时保持原文件。
    settings_write_allowed: AtomicBool,
    settings_read_error: Mutex<Option<String>>,
    /// 启动时设置文件损坏、已改名留底的提示,前端读过一次就清掉
    settings_notice: Mutex<Option<String>>,
    /// 上次成功写进 settings.json 的内容
    settings_json: Mutex<String>,
    /// 避免外观更改和页面排序同时改写同一份 .minipad.json。
    meta_io: Mutex<()>,
    quit: Mutex<QuitState>,
    quit_sequence: AtomicU64,
    edge: Mutex<EdgeState>,
    geom: Mutex<Option<Geom>>,
    hotkey_error: Mutex<Option<String>>,
    /// 快速记录的热键(0.5.1):注册上的那个的 id(按下的是它就快速记录),注册不上的原因
    capture_key: Mutex<Option<u32>>,
    capture_error: Mutex<Option<String>>,
    /// 托盘菜单里的「快速记录」,跟着设置里的开关变灰
    capture_item: Mutex<Option<MenuItem<tauri::Wry>>>,
    /// 设置里正在录新热键,全局热键暂时停用
    hotkey_paused: AtomicBool,
    /// 窗口出来以后用户打过字:只要窗口还有焦点,就不自动缩回去
    typing: AtomicBool,
    /// 最近一次自动备份是哪天(这一天就不用再备份了)
    backup_day: Mutex<String>,
    /// 后台正在打包备份
    backup_running: AtomicBool,
    /// 这次运行里最近一份备份跳过的文件(读不了的):(日期, 文件)
    backup_skipped: Mutex<(String, Vec<String>)>,
    /// 开着的小窗
    minis: Mutex<Vec<OpenMini>>,
    mini_seq: AtomicU64,
    /// 退出前等小窗把页面存好:还没回话的小窗,和它们报的错
    mini_flush: Mutex<(std::collections::HashSet<String>, Vec<String>)>,
    /// 上次退出时还开着的小窗,主窗口读完笔记后恢复
    mini_restore: Mutex<Vec<(String, String)>>,
}

#[derive(Clone)]
struct OpenMini {
    label: String,
    book: String,
    name: String,
    /// 快速记录的小窗(0.5.1):Esc 或者再按一次热键收起,单独记位置,重启后不恢复
    capture: bool,
}

#[derive(Serialize)]
struct BackupInfo {
    /// 实际使用的备份文件夹
    dir: String,
    /// 最近一份备份的日期
    latest: Option<String>,
    count: usize,
    /// 最近一份备份跳过的读不了的文件(只记得这次运行里打的备份)
    skipped: Vec<String>,
}

// ---------- 路径与设置 ----------

fn config_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("settings.json")
}

/// 默认与可执行文件放在一起；旧版本已有的数据优先保留原位置。
/// 安装目录不可写时继续使用用户数据目录，不影响在 Program Files 的安装。
static DEFAULT_NOTES_PATH: OnceLock<PathBuf> = OnceLock::new();
static DEFAULT_BACKUP_PATH: OnceLock<PathBuf> = OnceLock::new();

fn default_storage_dir(app: &AppHandle, folder: &str) -> PathBuf {
    let cache = if folder == "notes" {
        &DEFAULT_NOTES_PATH
    } else {
        &DEFAULT_BACKUP_PATH
    };
    cache
        .get_or_init(|| {
            let legacy = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(folder);
            let Some(program_root) = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(Path::to_path_buf))
            else {
                return legacy;
            };
            preferred_storage_dir(&program_root, &legacy, folder)
        })
        .clone()
}

fn contains_data(path: &Path) -> bool {
    fs::read_dir(path).is_ok_and(|mut entries| entries.next().is_some())
}

fn preferred_storage_dir(program_root: &Path, legacy: &Path, folder: &str) -> PathBuf {
    preferred_storage_dir_with_probe(program_root, legacy, folder, |root| {
        let probe = root.join(format!(".minipad-write-{}.tmp~", std::process::id()));
        let writable = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)
            .is_ok();
        if writable {
            let _ = fs::remove_file(&probe);
        }
        writable
    })
}

/// 测试可注入权限检查，Windows 的只读属性不能可靠模拟目录 ACL。
fn preferred_storage_dir_with_probe(
    program_root: &Path,
    legacy: &Path,
    folder: &str,
    writable: impl FnOnce(&Path) -> bool,
) -> PathBuf {
    let beside_exe = program_root.join(folder);
    // 若安装目录已有笔记，以那份数据为准；绝不覆盖已有目录。
    if contains_data(&beside_exe) {
        return beside_exe;
    }
    // 只在需要建目录或迁移旧数据时检测可写性，结果由 OnceLock 缓存。
    if writable(program_root) {
        if contains_data(legacy) {
            // 旧版本的默认内容安全复制到 exe 旁边；原文件仍然保留。
            // 若目标不可写、发生冲突或复制失败，就继续读取旧位置。
            return match notes::copy_notes_for_switch(legacy, &beside_exe) {
                Ok(()) => beside_exe,
                Err(e) => {
                    eprintln!("迁移旧默认目录失败，继续使用原目录: {e}");
                    legacy.to_path_buf()
                }
            };
        }
        beside_exe
    } else {
        // 包括旁边已经有空 notes/ 或 backups/ 的情况。目录不可写就使用 AppData。
        legacy.to_path_buf()
    }
}

fn notes_dir(app: &AppHandle, settings: &Settings) -> PathBuf {
    if !settings.notes_dir.trim().is_empty() {
        return PathBuf::from(settings.notes_dir.trim());
    }
    default_storage_dir(app, "notes")
}

fn current_notes_dir(app: &AppHandle) -> PathBuf {
    let s = app.state::<AppState>().settings.lock().unwrap().clone();
    notes_dir(app, &s)
}

fn backup_dir(app: &AppHandle, settings: &Settings) -> PathBuf {
    if !settings.backup_dir.trim().is_empty() {
        return PathBuf::from(settings.backup_dir.trim());
    }
    default_storage_dir(app, "backups")
}

/// `inner` 是不是 `outer` 本身或者在它里面(两个文件夹都要已经存在)
fn is_inside(inner: &Path, outer: &Path) -> bool {
    match (fs::canonicalize(inner), fs::canonicalize(outer)) {
        (Ok(i), Ok(o)) => i.starts_with(o),
        _ => false,
    }
}

/// 改笔记前调用:今天还没备份过就在后台把笔记文件夹打包。
/// 只试一次,失败了通知前端提示一下,明天(或者重启程序后)再试。
fn maybe_backup(app: &AppHandle) {
    let st = app.state::<AppState>();
    let settings = st.settings.lock().unwrap().clone();
    if !settings.backup_enabled {
        return;
    }
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    if *st.backup_day.lock().unwrap() == today || st.backup_running.swap(true, Ordering::SeqCst) {
        return;
    }
    let notes = notes_dir(app, &settings);
    let dest = backup_dir(app, &settings);
    let keep = settings.backup_keep as usize;
    let app = app.clone();
    std::thread::spawn(move || {
        let result = backup::run(&notes, &dest, &today, keep);
        let st = app.state::<AppState>();
        *st.backup_day.lock().unwrap() = today.clone();
        st.backup_running.store(false, Ordering::SeqCst);
        match result {
            Ok(Some(made)) => {
                if !made.skipped.is_empty() {
                    let _ = app.emit("backup-skipped", made.skipped.clone());
                }
                *st.backup_skipped.lock().unwrap() = (today, made.skipped);
            }
            Ok(None) => {}
            Err(e) => {
                eprintln!("{e}");
                let _ = app.emit("backup-error", e);
            }
        }
    });
}

/// 迁移完成后将绝对路径钉在设置中。换安装位置时不再从旧 AppData
/// 重复复制陈旧的笔记；用户明确设置的路径始终优先。
fn pin_default_storage(settings: &mut Settings, notes: &Path, backups: &Path) -> bool {
    let mut changed = false;
    if settings.notes_dir.trim().is_empty() {
        settings.notes_dir = notes.to_string_lossy().into_owned();
        changed = true;
    }
    if settings.backup_dir.trim().is_empty() {
        settings.backup_dir = backups.to_string_lossy().into_owned();
        changed = true;
    }
    changed
}

/// 读取失败(文件不存在除外,比如杀毒软件正占着)时隔 `wait` 再试,最多再试 `retries` 次
fn read_with_retry(
    mut read: impl FnMut() -> std::io::Result<Vec<u8>>,
    retries: u32,
    wait: Duration,
) -> std::io::Result<Vec<u8>> {
    let mut result = read();
    for _ in 0..retries {
        match &result {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                std::thread::sleep(wait);
                result = read();
            }
            _ => break,
        }
    }
    result
}

/// 损坏的设置文件改名留底:settings.json.bad-20261014-093000,这个名字已经有了就加 -2、-3……,不覆盖任何文件
fn move_aside(path: &Path, stamp: &str) -> std::io::Result<PathBuf> {
    let bad = (1..)
        .map(|i| {
            let mut name = path.as_os_str().to_os_string();
            name.push(format!(".bad-{stamp}"));
            if i > 1 {
                name.push(format!("-{i}"));
            }
            PathBuf::from(name)
        })
        .find(|p| !p.exists())
        .unwrap();
    fs::rename(path, &bad)?;
    Ok(bad)
}

/// 损坏的设置里还能读出的项照常使用:是 JSON 对象就逐项合并到默认值上,
/// 合并后还能读成 Settings 的才留下,一项写错不会连累笔记文件夹、热键这些
fn salvage_settings(text: &str) -> Settings {
    let Ok(serde_json::Value::Object(saved)) = serde_json::from_str(text) else {
        return Settings::default();
    };
    let mut merged = serde_json::to_value(Settings::default()).unwrap_or_default();
    for (key, value) in saved {
        let mut trial = merged.clone();
        trial[key.as_str()] = value;
        if Settings::deserialize(&trial).is_ok() {
            merged = trial;
        }
    }
    Settings::deserialize(&merged).unwrap_or_default()
}

/// 区分文件不存在、读不出来与内容损坏,返回设置、能否写回、读不出来的原因、给用户的提示。
/// 读不出来时本次运行使用默认值，且不得覆盖原有 settings.json(文件多半是好的)；
/// 内容损坏时原文件改名留底，能读出的设置照常使用，之后可以正常保存；改名失败就和读不出来一样处理。
fn decode_settings_result(
    path: &Path,
    result: std::io::Result<Vec<u8>>,
    stamp: &str,
) -> (Settings, bool, Option<String>, Option<String>) {
    let (mut settings, allowed, error, notice) = match result {
        Ok(bytes) => {
            let text = notes::decode_text(&bytes);
            match serde_json::from_str::<Settings>(&text) {
                Ok(settings) => (settings, true, None, None),
                Err(e) => match move_aside(path, stamp) {
                    Ok(bad) => (
                        salvage_settings(&text),
                        true,
                        None,
                        Some(format!(
                            "设置文件损坏，已另存为 {}；能读出的设置已保留，其余恢复默认",
                            bad.display()
                        )),
                    ),
                    Err(move_error) => (
                        Settings::default(),
                        false,
                        Some(format!(
                            "设置文件解析失败:{e}；另存损坏的文件也失败:{move_error}"
                        )),
                        None,
                    ),
                },
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            (Settings::default(), true, None, None)
        }
        Err(e) => (
            Settings::default(),
            false,
            Some(format!("设置文件读取失败:{e}")),
            None,
        ),
    };
    // 和保存时一样整理一遍:手改过的数值也限制在范围内,旧版的颜色预设迁移到 color_presets 交给前端
    tidy_settings(&mut settings);
    (settings, allowed, error, notice)
}

fn load_settings(app: &AppHandle) -> (Settings, bool, Option<String>, Option<String>) {
    let path = config_path(app);
    let read = read_with_retry(|| fs::read(&path), 3, Duration::from_millis(200));
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    decode_settings_result(&path, read, &stamp)
}

/// `last` 是上次成功写入的内容:每次隐藏窗口都会保存设置,内容没变就不再写盘
fn write_settings_if_allowed(
    path: &Path,
    settings: &Settings,
    allowed: bool,
    last: &mut String,
) -> Result<(), String> {
    if !allowed {
        // 保护原文件：即使后来暂时恢复可写，也不能用本次运行的默认值覆盖。
        return Ok(());
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    if *last != json {
        notes::write_atomic(path, &json)?;
        *last = json;
    }
    Ok(())
}

fn persist_settings(app: &AppHandle) {
    let state = app.state::<AppState>();
    if !state.settings_write_allowed.load(Ordering::SeqCst) {
        return;
    }
    let mut s = state.settings.lock().unwrap().clone();
    if let Some(g) = state.geom.lock().unwrap().clone() {
        s.window = Some(g);
    }
    let path = config_path(app);
    let mut last = state.settings_json.lock().unwrap();
    if let Err(e) = write_settings_if_allowed(&path, &s, true, &mut last) {
        eprintln!("保存设置失败:{e}");
    }
}

const EDGE_STYLES: [&str; 4] = ["arrow", "line", "hover", "arrow-only"];

/// 所有可自定义的设置颜色与笔记本图标共用严格的纯色/渐变校验。
fn tidy_color(c: &mut String) {
    *c = notes::normalized_book_color(c).unwrap_or_default();
}

/// 只能是几个选项之一的设置:不认识的值换成第一个(默认的那个)
fn pick_one(value: &mut String, options: &[&str]) {
    if !options.contains(&value.as_str()) {
        *value = options[0].to_string();
    }
}

/// 名字类的设置:去掉首尾空格,最多 80 个字,空着用默认的
fn tidy_name(value: &mut String, default: &str) {
    let v: String = value.trim().chars().take(80).collect();
    *value = match v.trim_end() {
        "" => default.into(),
        v => v.into(),
    };
}

/// 片段:触发词不能空、不能有空白、最多 32 个字;内容最多 10000 个字;同一个触发词只留第一条;最多 200 条
fn tidy_snippets(list: &mut Vec<Snippet>) {
    let mut seen = std::collections::HashSet::new();
    list.retain_mut(|s| {
        s.trigger = s.trigger.trim().to_string();
        s.text = s.text.chars().take(10_000).collect();
        !s.trigger.is_empty()
            && s.trigger.chars().count() <= 32
            && !s.trigger.chars().any(char::is_whitespace)
            && seen.insert(s.trigger.clone())
    });
    list.truncate(200);
}

/// 启动读取后和保存前整理设置:去掉首尾空格,数字限制在合理范围
fn tidy_settings(s: &mut Settings) {
    s.hotkey = s.hotkey.trim().to_string();
    s.notes_dir = s.notes_dir.trim().to_string();
    s.backup_dir = s.backup_dir.trim().to_string();
    s.backup_keep = s.backup_keep.clamp(1, 365);
    s.quick_color_count = s.quick_color_count.clamp(1, 128);
    s.quick_color_limit = s.quick_color_limit.min(128);
    s.quick_gradient_limit = s.quick_gradient_limit.min(128);
    s.quick_material_limit = s.quick_material_limit.min(128);
    s.font_size = s.font_size.clamp(10, 28);
    tidy_color(&mut s.accent);
    let mut seen_colors = std::collections::HashSet::new();
    let source = s.color_presets.as_ref().unwrap_or(&s.book_color_presets);
    s.color_presets = Some(
        source
            .iter()
            .filter_map(|v| notes::normalized_book_color(v))
            .filter(|v| seen_colors.insert(v.clone()))
            .take(20)
            .collect(),
    );
    for colors in [&mut s.color_library, &mut s.quick_colors]
        .into_iter()
        .flatten()
    {
        // 纯色和渐变各自最多 128 个
        let mut seen = std::collections::HashSet::new();
        let (mut solid, mut gradient) = (0, 0);
        *colors = colors
            .iter()
            .filter_map(|v| notes::normalized_book_color(v))
            .filter(|v| seen.insert(v.clone()))
            .filter(|v| {
                let count = if v.starts_with("linear-gradient(") {
                    &mut gradient
                } else {
                    &mut solid
                };
                *count += 1;
                *count <= 128
            })
            .collect();
    }
    // 材质色库最多 128 个；同一个颜色不同时出现在渐变库和材质库里
    if let Some(materials) = &mut s.material_library {
        let mut seen = std::collections::HashSet::new();
        *materials = materials
            .iter()
            .filter_map(|v| notes::normalized_book_color(v))
            .filter(|v| seen.insert(v.clone()))
            .take(128)
            .collect();
        if let Some(colors) = &mut s.color_library {
            colors.retain(|c| !materials.contains(c));
        }
    }
    tidy_color(&mut s.edge_color);
    tidy_color(&mut s.ball_color);
    tidy_color(&mut s.find_color);
    tidy_color(&mut s.outline_color);
    tidy_color(&mut s.local_path_color);
    tidy_color(&mut s.page_link_color);
    tidy_color(&mut s.page_link_broken_color);
    tidy_color(&mut s.webdav_status_color);
    s.webdav_delay_seconds = s.webdav_delay_seconds.clamp(10, 300);
    s.webdav_delete_limit = s.webdav_delete_limit.clamp(1, 1000);
    s.webdav_delete_divisor = s.webdav_delete_divisor.clamp(1, 10);
    if ![0, 1, 5, 15, 30].contains(&s.webdav_interval_minutes) {
        s.webdav_interval_minutes = 5;
    }
    pick_one(&mut s.webdav_first_mode, &["merge", "remote", "local"]);
    pick_one(&mut s.webdav_status_style, &["icon", "text", "none"]);
    pick_one(&mut s.ctrl_f, &["page", "all"]);
    pick_one(&mut s.color_layout, &["tabs", "rows"]);
    pick_one(
        &mut s.color_open_tab,
        &["remember", "solid", "gradient", "material", "follow"],
    );
    pick_one(&mut s.gradient_shape, &["square", "bar", "round"]);
    pick_one(&mut s.find_bar_pos, &["top", "bottom"]);
    pick_one(&mut s.block_context_menu, &["system", "block"]);
    pick_one(&mut s.code_exit_mode, &["blank3", "blank2", "ctrl"]);
    pick_one(&mut s.conflict_mode, &["copy", "overwrite"]);
    pick_one(&mut s.local_path_click, &["ctrl", "click"]);
    pick_one(&mut s.local_path_underline, &["solid", "dashed", "none"]);
    s.local_path_trusted.retain(|p| !p.trim().is_empty());
    s.local_path_trusted.sort();
    s.local_path_trusted.dedup();
    pick_one(&mut s.page_link_click, &["ctrl", "click"]);
    pick_one(&mut s.page_link_suggest, &["brackets", "typing", "off"]);
    pick_one(&mut s.page_link_rename, &["ask", "auto", "off"]);
    pick_one(&mut s.page_link_brackets, &["faint", "show", "hide"]);
    pick_one(&mut s.page_link_underline, &["hover", "solid", "dashed", "none"]);
    pick_one(&mut s.settings_nav, &["left", "top"]);
    pick_one(&mut s.outline_mode, &["hover", "pinned"]);
    pick_one(&mut s.outline_side, &["right", "left"]);
    s.outline_depth = s.outline_depth.clamp(1, 6);
    s.outline_width = s.outline_width.clamp(140, 360);
    s.outline_opacity = s.outline_opacity.clamp(40, 100);
    pick_one(&mut s.tab_overflow, &["scroll", "wrap", "drawer"]);
    pick_one(&mut s.tab_drawer_side, &["left", "right"]);
    pick_one(&mut s.tab_group_style, &["line", "tint"]);
    pick_one(&mut s.pin_style, &["icon", "tint", "none"]);
    pick_one(&mut s.quick_switch_scope, &["all", "book"]);
    s.quick_switch_key = s.quick_switch_key.trim().chars().take(40).collect();
    pick_one(&mut s.sel_bar, &["always", "nobar", "off"]);
    pick_one(&mut s.sel_bar_pos, &["above", "below"]);
    pick_one(&mut s.mini_hotkey, &["follow", "independent"]);
    pick_one(&mut s.image_size, &["full", "medium", "small"]);
    s.mini_opacity = mini::clamp_opacity(s.mini_opacity);
    s.mini_max = s.mini_max.min(20);
    mini::tidy(&mut s.mini_windows);
    s.capture_hotkey = s.capture_hotkey.trim().chars().take(40).collect();
    pick_one(&mut s.capture_target, &["page", "new"]);
    tidy_name(&mut s.capture_page, DEFAULT_CAPTURE_PAGE);
    tidy_name(&mut s.capture_name, DEFAULT_CAPTURE_NAME);
    pick_one(&mut s.capture_where, &["end", "start"]);
    pick_one(&mut s.capture_format, &["paragraph", "list", "task"]);
    pick_one(&mut s.capture_position, &["remember", "center", "cursor"]);
    tidy_name(&mut s.template_book, DEFAULT_TEMPLATE_BOOK);
    tidy_snippets(&mut s.snippets);
    pick_one(&mut s.snippet_key, &["tab", "space", "off"]);
    pick_one(&mut s.calc_key, &["tab", "equals", "off"]);
    pick_one(
        &mut s.calc_decimals,
        &["auto", "0", "1", "2", "3", "4", "5", "6"],
    );
    let mut seen = std::collections::HashSet::new();
    s.sel_bar_items
        .retain(|id| !id.is_empty() && id.len() <= 32 && seen.insert(id.clone()));
    s.sel_bar_items.truncate(64);
    s.format_bar_hidden.truncate(64);
    s.format_bar_order.truncate(64);
    s.tab_rows = s.tab_rows.clamp(2, 8);
    s.tab_drawer_width = s.tab_drawer_width.clamp(140, 360);
    s.ball_size = s.ball_size.clamp(32, 96);
    if !["app", "custom"].contains(&s.ball_icon.as_str()) {
        s.ball_icon = "app".into();
    }
    s.ball_opacity = s.ball_opacity.clamp(30, 100);
    if !["click", "dblclick"].contains(&s.ball_open.as_str()) {
        s.ball_open = "click".into();
    }
    if !EDGE_STYLES.contains(&s.edge_style.as_str()) {
        s.edge_style = "arrow".into();
    }
    s.edge_line_width = s.edge_line_width.clamp(1, 12);
    s.edge_line_length = s.edge_line_length.clamp(10, 100);
    if !["percent", "px"].contains(&s.edge_line_length_unit.as_str()) {
        s.edge_line_length_unit = "percent".into();
    }
    s.edge_line_length_px = s.edge_line_length_px.clamp(24, 600);
    if !["line", "fill", "border"].contains(&s.tab_style.as_str()) {
        s.tab_style = "line".into();
    }
    pick_one(&mut s.ui_style, &["starry", "material", "paper", "classic"]);
    // 日期格式最多 64 个字(按字算,不按字节),空着就用默认的
    let format: String = s.date_format.trim().chars().take(64).collect();
    s.date_format = match format.trim_end() {
        "" => DEFAULT_DATE_FORMAT.to_string(),
        f => f.to_string(),
    };
}

/// 把 0.1.x 存在旧标识符目录下的设置和笔记搬到新目录
fn migrate_old_data(app: &AppHandle) {
    let path = app.path();
    let targets = [
        (path.app_config_dir(), "settings.json"),
        (path.app_data_dir(), "notes"),
    ];
    for (dir, item) in targets {
        let Ok(dir) = dir else { continue };
        let old = dir.with_file_name(OLD_IDENTIFIER).join(item);
        if let Err(e) = notes::migrate_path(&old, &dir.join(item)) {
            eprintln!("迁移 {} 失败: {e}", old.display());
        }
    }
}

/// 注册全局热键:呼出主窗口的,和快速记录的(关着就没有)。返回呼出热键的结果;
/// 快速记录的热键注册不上不算失败,原因记在 capture_error
fn register_hotkey(app: &AppHandle, hotkey: &str, capture: Option<&str>) -> Result<(), String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let result = gs.register(hotkey).map_err(|e| e.to_string());
    let (mut id, mut error) = (None, None);
    if let Some(c) = capture {
        match gs.register(c) {
            Ok(()) => id = c.parse::<Shortcut>().ok().map(|k| k.id()),
            Err(e) => error = Some(format!("{c}:{e}")),
        }
    }
    let st = app.state::<AppState>();
    *st.capture_key.lock().unwrap() = id;
    *st.capture_error.lock().unwrap() = error;
    result
}

/// 快速记录要注册的热键:关着或者空着就没有
fn capture_of(s: &Settings) -> Option<&str> {
    (s.capture_enabled && !s.capture_hotkey.is_empty()).then_some(s.capture_hotkey.as_str())
}

/// 快速记录的热键不能和呼出热键一样(写法不同、按键一样也算)
fn check_capture_hotkey(s: &Settings) -> Result<(), String> {
    let Some(c) = capture_of(s) else {
        return Ok(());
    };
    let id = |k: &str| k.parse::<Shortcut>().ok().map(|h| h.id());
    let same = match (id(c), id(&s.hotkey)) {
        (Some(a), Some(b)) => a == b,
        _ => c.eq_ignore_ascii_case(&s.hotkey),
    };
    if same {
        Err("快速记录的热键和呼出热键一样,换一个吧".into())
    } else {
        Ok(())
    }
}

/// 重新启用全局热键(录热键时暂停过的话)
fn resume_hotkey_if_paused(app: &AppHandle) {
    let st = app.state::<AppState>();
    if !st.hotkey_paused.swap(false, Ordering::SeqCst) {
        return;
    }
    let s = st.settings.lock().unwrap().clone();
    let result = register_hotkey(app, &s.hotkey, capture_of(&s));
    *st.hotkey_error.lock().unwrap() = result.err().map(|e| format!("{}:{e}", s.hotkey));
}

const WELCOME: &str = r#"# 欢迎使用 Minipad Next

- 按 **Ctrl+M** 呼出或隐藏这个窗口(可以在设置里改)
- 把窗口拖到屏幕**上边、左边或右边**,鼠标移开后会自动贴边隐藏,鼠标碰到边缘再滑出来
- 内容会自动保存,每个页面就是笔记文件夹里的一个 `.md` 文件;笔记文件夹放在网盘里时,同一页在两边都改过,别处的版本会另存成一页"冲突副本",不会丢
- 看到的就是排好版的样子:行首打 `# ` 变标题,`- ` 变列表,`> ` 变引用,`**粗体**`、`` `代码` `` 打完就变样;选中文字会出来一排按钮
- 标签下面的**格式栏**有标题、粗体、列表、表格、<span style="color: #df2a3f">字体颜色</span>和<span style="background-color: #fbe9a6">背景颜色</span>等按钮;右边的按钮可以选显示哪些、拖动排顺序,顶栏的格式栏按钮(像一个带工具条的小窗口)可以收起它
- 顶栏的太阳 / 月亮按钮切换深色和浅色;设置里可以换<span style="color: #5fb4ff; background-image: linear-gradient(90deg, #5fb4ff, #d66cf0); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent">强调色,也能用渐变色</span>
- 在列表里按 **Enter** 接着写下一项,**Ctrl+Enter** 勾选任务,**F5** 插入当前日期时间
- 打 ```` ``` ```` 再按 Enter 插入代码块;代码块顶栏的"添加标题"和语言点一下就能改,右边有"复制"按钮
- **Ctrl+F** 在这一页里查找,**Ctrl+H** 替换(可以区分大小写、全字匹配、用正则表达式);**Ctrl+Shift+F** 搜索全部笔记本的页面
- 页面多了可以分**笔记本**:点标签栏最左边的笔记本名字(或按 **Ctrl+B**)新建和切换,每个笔记本就是笔记文件夹里的一个子文件夹
- 用过 minipad2?在笔记本列表里点"从 minipad2 导入…",原来的分组会变成笔记本
- 页面长、标题多时,可以在设置的"编辑"里打开**悬浮目录**:编辑区旁边一列短线,鼠标移上去展开成目录,点标题就跳过去
- 页面多了标签栏放不下时,点标签后面的页数按钮看全部页面;设置的"外观"里还可以换成点击展开成多行、侧拉的页面列表,或者打开**标签分组**
- 每天第一次保存时会自动把笔记文件夹备份成 zip,默认保留最近 14 份,可以在设置里改

```python 试试复制
print("点右上角的复制按钮试试")
```

## 快捷键

| 按键 | 作用 |
| --- | --- |
| Ctrl+M | 呼出 / 隐藏(全局) |
| Ctrl+B | 选中文字时加粗,没选中时切换笔记本 |
| Ctrl+I | 斜体 |
| Ctrl+T | 新建页面 |
| Ctrl+F | 在这一页里查找 |
| Ctrl+H | 查找和替换 |
| F3 / Shift+F3 | 下一个 / 上一个找到的地方 |
| Ctrl+Shift+F | 搜索全部笔记本的页面 |
| Ctrl+Tab | 下一个页面 |
| Ctrl+1 ~ 9 | 跳到第 N 个页面 |
| Ctrl+Enter | 勾选 / 取消勾选任务 |
| Shift+Enter | 段落里换行 |
| F5 | 插入当前日期时间 |
| Ctrl+点击链接 | 用浏览器打开 |
| 双击标签 | 重命名 |
| 右键标签 | 重命名、移到别的笔记本、删除 |
| Esc | 隐藏窗口(查找栏开着时先关查找栏) |
"#;

// ---------- 命令 ----------

/// only:小窗只要自己那一页(其他笔记本和页面不读)
#[tauri::command]
fn load_state(app: AppHandle, only: Option<notes::OnlyPage>) -> Result<LoadedState, String> {
    let st = app.state::<AppState>();
    let settings = st.settings.lock().unwrap().clone();
    let dir = notes_dir(&app, &settings);
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建笔记文件夹 {}:{e}", dir.display()))?;

    // 第一次用(文件夹里既没有页面也没有笔记本)时写一页说明
    if notes::list_names(&dir)?.is_empty() && notes::list_books(&dir)?.is_empty() {
        notes::write_atomic(&notes::note_path(&dir, "欢迎"), WELCOME)?;
    }
    let books = notes::load_books_with(&dir, None, only.as_ref())?;
    let saved = notes::read_meta(&dir).book;
    let book = if books.iter().any(|b| b.name == saved) {
        saved
    } else {
        String::new()
    };
    let hotkey_error = st.hotkey_error.lock().unwrap().clone();
    let capture_error = st.capture_error.lock().unwrap().clone();
    let settings_error = st.settings_read_error.lock().unwrap().clone();
    let settings_notice = st.settings_notice.lock().unwrap().take();
    Ok(LoadedState {
        settings,
        settings_error,
        settings_notice,
        notes_dir: dir.to_string_lossy().to_string(),
        books,
        book,
        hotkey_error,
        capture_error,
        version: app.package_info().version.to_string(),
        debug: cfg!(debug_assertions),
    })
}

/// 重新读一遍笔记文件夹,用来发现在别处(网盘同步、其他编辑器)改过的内容。
/// known 是前端已有页面的指纹,没改过的页面不读内容;小窗用 only 只读自己那一页
#[tauri::command]
fn read_notes(
    app: AppHandle,
    known: Option<notes::Known>,
    only: Option<notes::OnlyPage>,
) -> Result<Vec<Book>, String> {
    notes::load_books_with(&current_notes_dir(&app), known.as_ref(), only.as_ref())
}

#[tauri::command]
fn book_exists(app: AppHandle, book: String) -> Result<bool, String> {
    let dir = notes::book_dir(&current_notes_dir(&app), &book)?;
    match fs::metadata(dir) {
        Ok(meta) => Ok(meta.is_dir()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Ok(true),
    }
}

/// 文件在别处(网盘同步、别的编辑器)也改过时,那边的版本另存成的冲突副本
#[derive(Serialize)]
struct ConflictCopy {
    name: String,
    content: String,
}

#[derive(Serialize)]
struct SavedNote {
    conflict: Option<ConflictCopy>,
}

/// 保存页面。`expected` 是前端上次从磁盘读到(或写进去)的内容:
/// 文件现在的内容和它不一样,说明在别处也改过,先把那边的版本另存成冲突副本再写(设置里可以改成直接覆盖)
#[tauri::command]
fn save_note(
    app: AppHandle,
    book: String,
    name: String,
    content: String,
    expected: Option<String>,
) -> Result<SavedNote, String> {
    maybe_backup(&app);
    let keep_both = app
        .state::<AppState>()
        .settings
        .lock()
        .unwrap()
        .conflict_mode
        == "copy";
    let stamp = chrono::Local::now().format("%Y-%m-%d %H.%M").to_string();
    let _write = crate::syncer::WRITE_LOCK
        .lock()
        .map_err(|e| e.to_string())?;
    let conflict = notes::save_page(
        &current_notes_dir(&app),
        &book,
        &name,
        &content,
        expected.as_deref(),
        keep_both,
        &stamp,
    )?;
    Ok(SavedNote {
        conflict: conflict.map(|(name, content)| ConflictCopy { name, content }),
    })
}

#[tauri::command]
fn create_note(app: AppHandle, book: String, name: String) -> Result<String, String> {
    let dir = notes::book_dir(&current_notes_dir(&app), &book)?;
    maybe_backup(&app);
    notes::create_note(&dir, &name)
}

#[tauri::command]
fn rename_note(app: AppHandle, book: String, old: String, new: String) -> Result<String, String> {
    maybe_backup(&app);
    notes::rename_note(&current_notes_dir(&app), &book, &old, &new)
}

#[tauri::command]
fn delete_note(app: AppHandle, book: String, name: String) -> Result<(), String> {
    maybe_backup(&app);
    notes::move_to_trash(&current_notes_dir(&app), &book, &name)
}

/// 快速记录新建的页面没写东西:直接删掉,不进回收站(只删空的),删了返回 true
#[tauri::command]
fn delete_if_empty(app: AppHandle, book: String, name: String) -> Result<bool, String> {
    notes::delete_if_empty(&current_notes_dir(&app), &book, &name)
}

/// 把页面移到另一个笔记本,返回它在那边的名字(重名时会加编号)
#[tauri::command]
fn move_note(app: AppHandle, book: String, name: String, target: String) -> Result<String, String> {
    maybe_backup(&app);
    let root = current_notes_dir(&app);
    let new = notes::move_note(&root, &book, &name, &target)?;
    // 页面里的图片(assets/…)也复制到那个笔记本,不然移过去就看不到了
    if book != target {
        if let (Ok(from), Ok(to), Ok(page)) = (
            notes::book_dir(&root, &book),
            notes::book_dir(&root, &target),
            notes::page_path(&root, &target, &new),
        ) {
            let content = fs::read_to_string(&page).unwrap_or_default();
            for rel in images::copy_referenced(&from, &to, &content) {
                eprintln!("移动页面时没能复制图片 {rel}");
            }
        }
    }
    Ok(new)
}

#[derive(Deserialize)]
struct ImageMeta {
    book: String,
    ext: String,
}

/// 粘贴、拖进来的图片:存进这个笔记本的 assets 文件夹,返回页面里写的相对路径。
/// 图片内容直接作为二进制传过来,笔记本名字和扩展名放在 x-image 头里(encodeURIComponent 过的 JSON)
#[tauri::command]
fn save_image(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("图片数据不对".into());
    };
    let meta = request
        .headers()
        .get("x-image")
        .and_then(|v| v.to_str().ok())
        .and_then(images::percent_decode)
        .ok_or("缺少图片信息")?;
    let meta: ImageMeta = serde_json::from_str(&meta).map_err(|e| e.to_string())?;
    let s = app.state::<AppState>().settings.lock().unwrap().clone();
    if !s.image_paste {
        return Err("粘贴图片已经关掉了,可以在 设置 → 编辑 里打开".into());
    }
    let dir = notes::book_dir(&notes_dir(&app, &s), &meta.book)?;
    if !dir.is_dir() {
        return Err("找不到这个笔记本".into());
    }
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    images::save(&dir, bytes, &meta.ext, &stamp)
}

/// 编辑器里显示图片:https://note.localhost/img?book=…&path=assets/…(Windows 上的写法,小窗是 http)
fn note_image(app: &AppHandle, uri: &tauri::http::Uri) -> tauri::http::Response<Vec<u8>> {
    images::protocol_response(&current_notes_dir(app), uri)
}

/// 参数和前端发来的字段一一对应;base 是前端上次从磁盘读到(或写进去)的页面顺序、固定和分组
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn save_meta(
    app: AppHandle,
    book: String,
    mut order: Vec<String>,
    active: String,
    modes: HashMap<String, String>,
    groups: Option<Vec<notes::TabGroup>>,
    note_groups: Option<HashMap<String, String>>,
    mut pinned: Option<Vec<String>>,
    base: Option<notes::SharedMeta>,
) -> Result<(), String> {
    let mut groups = groups.map(|groups| notes::Groups {
        groups,
        note_groups: note_groups.unwrap_or_default(),
    });
    let st = app.state::<AppState>();
    let _guard = st.meta_io.lock().unwrap();
    // WebDAV 同步写 .minipad.json 时等着,比较磁盘上的样子和写回去之间不会被它插进来
    let _write = crate::syncer::WRITE_LOCK
        .lock()
        .map_err(|e| e.to_string())?;
    let root = current_notes_dir(&app);
    if let Some(base) = &base {
        notes::keep_disk_changes(&root, &book, base, &mut order, &mut pinned, &mut groups)?;
    }
    notes::save_book_meta(&root, &book, order, active, modes, groups, pinned)
}

#[tauri::command]
fn create_book(app: AppHandle, name: String) -> Result<String, String> {
    maybe_backup(&app);
    notes::create_book(&current_notes_dir(&app), &name)
}

#[tauri::command]
fn rename_book(app: AppHandle, old: String, new: String) -> Result<String, String> {
    maybe_backup(&app);
    notes::rename_book(&current_notes_dir(&app), &old, &new)
}

#[tauri::command]
fn delete_book(app: AppHandle, name: String) -> Result<(), String> {
    maybe_backup(&app);
    notes::delete_book(&current_notes_dir(&app), &name)
}

/// 回收站里删掉的页面和笔记本,最近删的在前
#[tauri::command]
fn trash_list(app: AppHandle) -> Result<Vec<notes::TrashItem>, String> {
    notes::list_trash(&current_notes_dir(&app))
}

#[derive(Serialize)]
struct Restored {
    book: String,
    /// 恢复的是笔记本时是空的
    name: String,
}

/// 恢复回收站里的一项,返回它现在的位置(重名时会加编号)
#[tauri::command]
fn trash_restore(app: AppHandle, id: String) -> Result<Restored, String> {
    maybe_backup(&app);
    let (book, name) = notes::restore_trash(&current_notes_dir(&app), &id)?;
    Ok(Restored { book, name })
}

/// 彻底删除回收站里的一项(之前的每日备份里还有)
#[tauri::command]
fn trash_purge(app: AppHandle, id: String) -> Result<(), String> {
    maybe_backup(&app);
    notes::purge_trash(&current_notes_dir(&app), &id)
}

#[tauri::command]
fn trash_empty(app: AppHandle) -> Result<usize, String> {
    maybe_backup(&app);
    notes::empty_trash(&current_notes_dir(&app))
}

/// 从窗口内容区（Alt+左键）触发原生 Windows 拖动。
#[tauri::command]
fn start_window_drag(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_book_appearance(
    app: AppHandle,
    book: String,
    icon: String,
    color: String,
) -> Result<(), String> {
    maybe_backup(&app);
    let st = app.state::<AppState>();
    let _guard = st.meta_io.lock().unwrap();
    // 和 WebDAV 同步写 .minipad.json 排队
    let _write = crate::syncer::WRITE_LOCK
        .lock()
        .map_err(|e| e.to_string())?;
    notes::set_book_appearance(&current_notes_dir(&app), &book, &icon, &color)
}

/// 记住当前打开的笔记本,下次启动还打开它
#[tauri::command]
fn set_current_book(app: AppHandle, book: String) -> Result<(), String> {
    let st = app.state::<AppState>();
    let _guard = st.meta_io.lock().unwrap();
    // 和 WebDAV 同步写 .minipad.json 排队
    let _write = crate::syncer::WRITE_LOCK
        .lock()
        .map_err(|e| e.to_string())?;
    notes::set_current_book(&current_notes_dir(&app), &book)
}

/// 看看选的文件夹里有没有 minipad2 的数据、有多少页面(导入窗口用)
#[tauri::command]
async fn minipad2_preview(path: String) -> Result<minipad2::Preview, String> {
    minipad2::preview(Path::new(&path))
}

/// 按选的选项先放进暂存区:会建哪些笔记本、每个里面有哪些页面,什么都不写
#[tauri::command]
async fn minipad2_stage(
    path: String,
    options: minipad2::Options,
) -> Result<minipad2::Staged, String> {
    minipad2::stage(Path::new(&path), &options)
}

/// 从 minipad2 导入:每个分组建一个新笔记本,不动已有的笔记;`leave` 是暂存区里没勾上的
#[tauri::command]
async fn minipad2_import(
    app: AppHandle,
    path: String,
    options: minipad2::Options,
    leave: Option<minipad2::Leave>,
) -> Result<minipad2::Imported, String> {
    maybe_backup(&app);
    minipad2::import(
        Path::new(&path),
        &current_notes_dir(&app),
        &options,
        &leave.unwrap_or_default(),
    )
}

#[tauri::command]
fn backup_info(app: AppHandle) -> BackupInfo {
    let settings = app.state::<AppState>().settings.lock().unwrap().clone();
    let dir = backup_dir(&app, &settings);
    let all = backup::list(&dir);
    let latest = all.last().map(|(day, _)| day.clone());
    let (day, files) = app
        .state::<AppState>()
        .backup_skipped
        .lock()
        .unwrap()
        .clone();
    BackupInfo {
        dir: dir.to_string_lossy().to_string(),
        skipped: if latest.as_ref() == Some(&day) {
            files
        } else {
            Vec::new()
        },
        latest,
        count: all.len(),
    }
}

#[tauri::command]
fn open_backup_dir(app: AppHandle) -> Result<(), String> {
    let settings = app.state::<AppState>().settings.lock().unwrap().clone();
    let dir = backup_dir(&app, &settings);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| e.to_string())
}

/// 设置变更按热键、开机启动、文件复制的顺序提交；文件复制必须最后执行。
/// 迁移失败时撤回已经成功的系统设置，并报告任何回滚失败。
fn apply_settings_side_effects<H, A, M>(
    hotkey_changed: bool,
    autostart_changed: bool,
    autostart_enabled: bool,
    mut set_hotkey: H,
    mut set_autostart: A,
    copy_notes: M,
) -> Result<(), String>
where
    H: FnMut(bool) -> Result<(), String>,
    A: FnMut(bool) -> Result<(), String>,
    M: FnOnce() -> Result<(), String>,
{
    if hotkey_changed {
        if let Err(e) = set_hotkey(true) {
            let rollback = set_hotkey(false).err();
            return Err(append_rollback_error(e, rollback.into_iter().collect()));
        }
    }
    if autostart_changed {
        if let Err(e) = set_autostart(autostart_enabled) {
            let rollback = if hotkey_changed {
                set_hotkey(false).err()
            } else {
                None
            };
            return Err(append_rollback_error(e, rollback.into_iter().collect()));
        }
    }
    if let Err(e) = copy_notes() {
        let mut errors = Vec::new();
        if autostart_changed {
            if let Err(revert) = set_autostart(!autostart_enabled) {
                errors.push(revert);
            }
        }
        if hotkey_changed {
            if let Err(revert) = set_hotkey(false) {
                errors.push(revert);
            }
        }
        return Err(append_rollback_error(e, errors));
    }
    Ok(())
}

fn append_rollback_error(original: String, rollback: Vec<String>) -> String {
    if rollback.is_empty() {
        original
    } else {
        format!("{original}（回滚失败：{}）", rollback.join("；"))
    }
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    window: WebviewWindow,
    settings: Settings,
    migrate_notes: Option<bool>,
) -> Result<Settings, String> {
    let state = app.state::<AppState>();
    if !state.settings_write_allowed.load(Ordering::SeqCst) {
        let reason = state.settings_read_error.lock().unwrap().clone();
        return Err(format!(
            "启动时无法读取原设置文件，已禁止覆盖；请恢复原文件并重新启动。{}",
            reason.unwrap_or_default()
        ));
    }
    let old = state.settings.lock().unwrap().clone();
    let mut new = settings;
    new.window = old.window.clone();
    new.ball_pos = old.ball_pos;
    new.mini_windows = old.mini_windows.clone();
    new.capture_window = old.capture_window.clone();
    tidy_settings(&mut new);
    check_capture_hotkey(&new)?;

    let old_notes = notes_dir(&app, &old);
    let new_notes = notes_dir(&app, &new);
    let copying_notes = old_notes != new_notes && migrate_notes.unwrap_or(false);
    if !copying_notes && !new.notes_dir.is_empty() {
        fs::create_dir_all(&new.notes_dir).map_err(|e| format!("无法使用这个文件夹:{e}"))?;
    }
    if new.backup_enabled {
        let dest = backup_dir(&app, &new);
        fs::create_dir_all(&dest).map_err(|e| format!("无法使用这个备份位置:{e}"))?;
        if is_inside(&dest, &notes_dir(&app, &new)) {
            return Err("备份位置不能放在笔记文件夹里面,请换一个文件夹".into());
        }
    }
    // 先验证并更新全局热键和开机启动，最后才复制目录。
    // 后续失败时回滚系统设置，避免产生“设置未切换、目标已有副本”的半途状态。
    let hotkey_changed = new.hotkey != old.hotkey;
    let capture_changed = capture_of(&new) != capture_of(&old);
    let retry_hotkey = state.hotkey_error.lock().unwrap().is_some()
        || state.capture_error.lock().unwrap().is_some();
    let update_hotkey = hotkey_changed || capture_changed || retry_hotkey;
    let update_autostart = new.autostart != old.autostart;
    let autolaunch = app.autolaunch();
    apply_settings_side_effects(
        update_hotkey,
        update_autostart,
        new.autostart,
        |use_new| {
            state.hotkey_paused.store(false, Ordering::SeqCst);
            let target = if use_new { &new } else { &old };
            let hotkey = &target.hotkey;
            let result = register_hotkey(&app, hotkey, capture_of(target));
            *state.hotkey_error.lock().unwrap() =
                result.as_ref().err().map(|e| format!("{hotkey}:{e}"));
            result.map_err(|e| format!("热键 {hotkey} 无法使用:{e}"))?;
            // 刚改的快速记录热键注册不上:和呼出热键一样,不保存
            match state.capture_error.lock().unwrap().clone() {
                Some(e) if use_new && capture_changed => {
                    Err(format!("快速记录的热键无法使用({e}),换一个吧"))
                }
                _ => Ok(()),
            }
        },
        |enable| {
            let result = if enable {
                autolaunch.enable()
            } else {
                autolaunch.disable()
            };
            result.map_err(|e| format!("开机启动设置失败:{e}"))
        },
        || {
            if copying_notes {
                notes::copy_notes_for_switch(&old_notes, &new_notes)?;
            }
            Ok(())
        },
    )?;

    if let Some(win) = main_window(&app) {
        let _ = win.set_always_on_top(new.always_on_top);
        let _ = win.set_skip_taskbar(!new.show_in_taskbar);
    }
    for w in mini_windows(&app) {
        let _ = w.set_skip_taskbar(!new.show_in_taskbar);
    }
    if let Some(item) = state.capture_item.lock().unwrap().as_ref() {
        let _ = item.set_enabled(new.capture_enabled);
    }
    // 关掉贴边隐藏或者换了样式(露出的宽度不同),先把窗口放出来
    if !new.edge_hide
        || new.edge_style != old.edge_style
        || new.edge_line_width != old.edge_line_width
        || new.edge_line_glow != old.edge_line_glow
    {
        restore_from_edge(&app, false);
    }
    // 换了笔记文件夹或备份位置,今天就在新地方重新判断要不要备份
    if new.notes_dir != old.notes_dir
        || new.backup_dir != old.backup_dir
        || new.backup_enabled != old.backup_enabled
    {
        state.backup_day.lock().unwrap().clear();
    }
    *state.settings.lock().unwrap() = new.clone();
    persist_settings(&app);
    // 别的窗口(主窗口和小窗)换上新设置
    for label in
        std::iter::once("main".to_string()).chain(open_minis(&app).into_iter().map(|m| m.label))
    {
        if label != window.label() {
            let _ = app.emit_to(label.as_str(), "settings-changed", &new);
        }
    }
    // 关掉悬浮图标时如果正缩着,就把窗口放出来;改了大小、图标、颜色就让悬浮图标重画
    if !new.ball_enabled && ball_visible(&app) {
        show_main(&app);
    } else if let Some(ball) = app.get_webview_window("ball") {
        let side = f64::from(new.ball_size) + 2.0 * ball::PAD;
        let _ = ball.set_size(LogicalSize::new(side, side));
        let _ = app.emit_to("ball", "ball-update", ());
    }
    Ok(new)
}

/// 设置里录新热键时先停用全局热键,否则按下现在的热键会把窗口藏起来
#[tauri::command]
fn pause_hotkey(app: AppHandle) {
    let _ = app.global_shortcut().unregister_all();
    app.state::<AppState>()
        .hotkey_paused
        .store(true, Ordering::SeqCst);
}

#[tauri::command]
fn resume_hotkey(app: AppHandle) {
    resume_hotkey_if_paused(&app);
}

/// 前端在用户打字时调用(有节流),用来判断贴边隐藏该不该缩回去
#[tauri::command]
fn note_activity(app: AppHandle, window: WebviewWindow) {
    // 只管主窗口贴边时要不要缩回去,小窗里打字不算
    if window.label() != "main" {
        return;
    }
    app.state::<AppState>().typing.store(true, Ordering::SeqCst);
}

#[tauri::command]
async fn pick_folder(app: AppHandle, title: Option<String>) -> Option<String> {
    let title = title.unwrap_or_else(|| "选择文件夹".into());
    let mut dialog = app.dialog().file().set_title(title);
    if let Some(win) = main_window(&app) {
        dialog = dialog.set_parent(&win);
    }
    dialog
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    hide_main(&app);
}

/// 0.5.0 小窗里补全 [[页面名]]、判断链接在不在用的页面名单(只列名字,不读内容)
#[tauri::command]
fn page_index(app: AppHandle) -> Result<Vec<notes::BookIndex>, String> {
    notes::index_books(&current_notes_dir(&app))
}

/// 小窗里点了页面链接:主窗口出来,打开(或新建)那一页。book 是小窗那一页所在的笔记本
#[tauri::command]
fn open_page_in_main(app: AppHandle, book: String, target: String) {
    let _ = app.emit_to(
        "main",
        "open-page",
        serde_json::json!({ "book": book, "target": target }),
    );
    show_main(&app);
}

#[tauri::command]
fn show_window(app: AppHandle) {
    show_main(&app);
}

#[tauri::command]
fn expand_edge(app: AppHandle) {
    restore_from_edge(&app, true);
}

#[tauri::command]
fn open_notes_dir(app: AppHandle) -> Result<(), String> {
    let dir = current_notes_dir(&app);
    tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_link(url: String) -> Result<(), String> {
    let lower = url.to_lowercase();
    if !(lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:"))
    {
        return Err("只能打开网页链接".into());
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// 只接受绝对路径；file URI 由 URL 解析器统一还原百分号编码。
fn parse_local_path(raw: &str) -> Result<PathBuf, String> {
    let path = if raw.to_ascii_lowercase().starts_with("file:") {
        tauri::Url::parse(raw)
            .map_err(|_| "本地文件链接格式不正确".to_string())?
            .to_file_path()
            .map_err(|_| "无法解析本地文件链接".to_string())?
    } else {
        PathBuf::from(raw)
    };
    if !path.is_absolute() {
        return Err("只能打开绝对路径".into());
    }
    Ok(path)
}

fn is_executable_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "exe"
            | "bat"
            | "cmd"
            | "ps1"
            | "vbs"
            | "js"
            | "msi"
            | "lnk"
            | "scr"
            | "com"
            | "pif"
            | "cpl"
            | "hta"
            | "wsf"
            | "wsh"
            | "jse"
            | "vbe"
            | "reg"
            | "msc"
            | "url"
            | "appref-ms"
    )
}

#[tauri::command]
async fn local_path_exists(path: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || parse_local_path(&path).is_ok_and(|p| p.exists()))
        .await
        .unwrap_or(false)
}

#[tauri::command]
async fn open_path(
    path: String,
    reveal: bool,
    confirmed: bool,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let (needs_confirmation, trusted) = {
        let settings = state.settings.lock().unwrap();
        (
            settings.local_path_confirm,
            settings.local_path_trusted.contains(&path),
        )
    };
    tauri::async_runtime::spawn_blocking(move || {
        let target = parse_local_path(&path)?;
        if !target.exists() {
            return Err("找不到这个文件".into());
        }
        if !reveal && is_executable_path(&target) && needs_confirmation && !confirmed && !trusted {
            return Err("打开此文件前需要确认".into());
        }
        if reveal && target.is_file() {
            tauri_plugin_opener::reveal_item_in_dir(&target).map_err(|e| e.to_string())
        } else {
            tauri_plugin_opener::open_path(target, None::<&str>).map_err(|e| e.to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn webdav_credential(settings: &Settings) -> Result<keyring::Entry, String> {
    let identity = crate::syncer::journal_path(
        Path::new(""),
        &settings.webdav_server,
        &settings.webdav_user,
        "",
    );
    let name = identity
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("无效的 WebDAV 账号")?;
    keyring::Entry::new("Minipad Next WebDAV", name)
        .map_err(|e| format!("无法打开 Windows 凭据管理器：{e}"))
}

/// 旧版本按服务器、用户名和远程文件夹存的那份凭据
fn legacy_webdav_credential(settings: &Settings) -> Result<keyring::Entry, String> {
    let old_id = crate::syncer::journal_path(
        Path::new(""),
        &settings.webdav_server,
        &settings.webdav_user,
        &settings.webdav_folder,
    );
    let name = old_id
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("账号标识无效")?;
    keyring::Entry::new("Minipad Next WebDAV", name).map_err(|e| e.to_string())
}

// 从旧版按远程文件夹区分的凭据迁移，避免升级后要求重复输入应用密码。
fn webdav_password(settings: &Settings) -> Result<String, String> {
    if let Ok(password) = webdav_credential(settings)?.get_password() {
        return Ok(password);
    }
    let legacy = legacy_webdav_credential(settings)?;
    let password = legacy
        .get_password()
        .map_err(|_| "请先填写并保存 WebDAV 应用密码")?;
    webdav_credential(settings)?
        .set_password(&password)
        .map_err(|_| "迁移 WebDAV 密码失败")?;
    let _ = legacy.delete_credential();
    Ok(password)
}

#[tauri::command]
fn webdav_set_password(app: AppHandle, password: String) -> Result<(), String> {
    let settings = app.state::<AppState>().settings.lock().unwrap().clone();
    if settings.webdav_server.trim().is_empty() || settings.webdav_user.trim().is_empty() {
        return Err("请先保存服务器地址和用户名".into());
    }
    webdav_credential(&settings)?
        .set_password(&password)
        .map_err(|e| format!("保存 WebDAV 密码到 Windows 凭据管理器失败：{e}"))
}

#[tauri::command]
async fn webdav_test(
    app: AppHandle,
    server: Option<String>,
    username: Option<String>,
    folder: Option<String>,
    allow_http: Option<bool>,
    password: Option<String>,
) -> Result<String, String> {
    let mut s = app.state::<AppState>().settings.lock().unwrap().clone();
    if let Some(value) = server {
        s.webdav_server = value;
    }
    if let Some(value) = username {
        s.webdav_user = value;
    }
    if let Some(value) = folder {
        s.webdav_folder = value;
    }
    if let Some(value) = allow_http {
        s.webdav_allow_http = value;
    }
    let secret = match password.filter(|value| !value.is_empty()) {
        Some(value) => value,
        None => webdav_password(&s)?,
    };
    tauri::async_runtime::spawn_blocking(move || {
        let client = crate::webdav::WebdavClient::new(
            &s.webdav_server,
            &s.webdav_user,
            &secret,
            &s.webdav_folder,
            s.webdav_allow_http,
        )?;
        client.test_connection()?;
        Ok::<_, String>("连接成功，目录读取与写入测试通过".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn webdav_status() -> crate::syncer::WebdavStatus {
    crate::syncer::status()
}

#[tauri::command]
fn webdav_forget(app: AppHandle) -> Result<(), String> {
    let s = app.state::<AppState>().settings.lock().unwrap().clone();
    let folder = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let file = crate::syncer::journal_path_for_root(
        &folder,
        &notes_dir(&app, &s),
        &s.webdav_server,
        &s.webdav_user,
        &s.webdav_folder,
    );
    // 旧版本存的那份也删掉，不然下次同步又会把它迁移回来
    for credential in [webdav_credential(&s)?, legacy_webdav_credential(&s)?] {
        match credential.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(format!("无法清除系统凭据中的 WebDAV 密码：{e}")),
        }
    }
    match fs::remove_file(file) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("无法清除同步记录：{e}")),
    }
    app.state::<AppState>()
        .settings
        .lock()
        .unwrap()
        .webdav_enabled = false;
    persist_settings(&app);
    crate::syncer::update_status("off", "已断开，笔记没有被删除");
    Ok(())
}

#[tauri::command]
async fn webdav_sync_now(
    app: AppHandle,
    confirm_deletes: bool,
) -> Result<crate::syncer::SyncReport, String> {
    let s = app.state::<AppState>().settings.lock().unwrap().clone();
    if !s.webdav_enabled {
        return Err("请先在设置中开启 WebDAV 同步".into());
    }
    let password =
        webdav_password(&s).map_err(|_| "WebDAV 密码尚未保存在 Windows 凭据管理器".to_string())?;
    let root = notes_dir(&app, &s);
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let backup_dest = backup_dir(&app, &s);
    let journal = crate::syncer::journal_path_for_root(
        &data,
        &root,
        &s.webdav_server,
        &s.webdav_user,
        &s.webdav_folder,
    );
    let first_mode = match s.webdav_first_mode.as_str() {
        "remote" => crate::syncer::FirstSync::Remote,
        "local" => crate::syncer::FirstSync::Local,
        _ => crate::syncer::FirstSync::Merge,
    };
    let options = crate::syncer::SyncOptions {
        images: s.webdav_images,
        first_mode,
        conflict_copy: s.conflict_mode != "overwrite",
        confirm_deletes,
        delete_limit: s.webdav_delete_limit,
        delete_divisor: s.webdav_delete_divisor,
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _run = crate::syncer::RUN_LOCK.lock().map_err(|e| e.to_string())?;
        crate::syncer::update_status("syncing", "正在同步笔记");
        let client = crate::webdav::WebdavClient::new(
            &s.webdav_server,
            &s.webdav_user,
            &password,
            &s.webdav_folder,
            s.webdav_allow_http,
        )?;
        crate::syncer::sync_once(&client, &root, &journal, &options, || {
            backup::before_sync(&root, &backup_dest)?;
            Ok(())
        })
    })
    .await
    .map_err(|e| e.to_string())?;
    match &result {
        Ok(report) => {
            let mode = if report.conflicts > 0 {
                "conflict"
            } else {
                "synced"
            };
            let message = format!(
                "同步完成：上传 {}，下载 {}，冲突 {}，回收站 {}",
                report.uploaded, report.downloaded, report.conflicts, report.deleted,
            );
            crate::syncer::update_status(mode, &message);
            if !report.changed.is_empty() {
                let _ = app.emit("webdav-changed", &report.changed);
            }
        }
        Err(e) if e.starts_with("WEB_DAV_CONFIRM_DELETE:") => {
            crate::syncer::update_status("confirm", "删除量超过保护阈值，需要确认");
        }
        Err(e) => {
            let state = if e.contains("离线") || e.contains("超时") {
                "offline"
            } else {
                "error"
            };
            crate::syncer::update_status(state, e);
        }
    }
    result
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    persist_settings(&app);
    app.exit(0);
}

#[tauri::command]
fn quit_ack(app: AppHandle, id: u64) -> bool {
    let state = app.state::<AppState>();
    let mut quit = state.quit.lock().unwrap();
    if quit.active == Some(id) && quit.waiting_ack {
        quit.waiting_ack = false;
        true
    } else {
        false
    }
}

#[tauri::command]
fn quit_cancel(app: AppHandle, id: u64) {
    let state = app.state::<AppState>();
    let mut quit = state.quit.lock().unwrap();
    if quit.active == Some(id) && !quit.waiting_ack {
        quit.active = None;
    }
}

// 只在前端完全没有确认收到消息时，才由系统原生对话框接管退出。
fn request_tray_quit(app: &AppHandle) {
    let state = app.state::<AppState>();
    let id = {
        let mut quit = state.quit.lock().unwrap();
        if quit.active.is_some() {
            return;
        }
        let id = state.quit_sequence.fetch_add(1, Ordering::SeqCst) + 1;
        quit.active = Some(id);
        quit.waiting_ack = true;
        id
    };
    let _ = app.emit("before-quit", id);
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(10));
        let state = handle.state::<AppState>();
        {
            let mut quit = state.quit.lock().unwrap();
            if quit.active != Some(id) || !quit.waiting_ack {
                return;
            }
            quit.waiting_ack = false;
        }
        let dialog_app = handle.clone();
        handle
            .dialog()
            .message("程序没有响应，仍要退出吗？尚未保存的笔记可能丢失。")
            .title("Minipad Next")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "仍要退出".into(),
                "取消".into(),
            ))
            .show(move |confirmed| {
                if confirmed {
                    quit_app(dialog_app);
                } else {
                    let state = dialog_app.state::<AppState>();
                    state.quit.lock().unwrap().active = None;
                    show_main(&dialog_app);
                }
            });
    });
}

// ---------- 窗口显示 / 隐藏 / 贴边 ----------

// ---------- 小窗 ----------

fn open_minis(app: &AppHandle) -> Vec<OpenMini> {
    app.state::<AppState>().minis.lock().unwrap().clone()
}

fn mini_windows(app: &AppHandle) -> Vec<WebviewWindow> {
    open_minis(app)
        .iter()
        .filter_map(|m| app.get_webview_window(&m.label))
        .collect()
}

fn mini_by_label(app: &AppHandle, label: &str) -> Option<OpenMini> {
    open_minis(app).into_iter().find(|m| m.label == label)
}

#[derive(Serialize, Clone)]
struct MiniPage {
    book: String,
    name: String,
}

/// 告诉主窗口现在哪些页面在小窗里(这些标签变淡)
fn emit_minis(app: &AppHandle) {
    let _ = app.emit_to("main", "mini-changed", mini_pages(app));
}

fn mini_pages(app: &AppHandle) -> Vec<MiniPage> {
    open_minis(app)
        .into_iter()
        .map(|m| MiniPage {
            book: m.book,
            name: m.name,
        })
        .collect()
}

/// 小窗记住的位置、大小、置顶和不透明度(没开过就用设置里的默认值)
fn mini_entry(app: &AppHandle, book: &str, name: &str) -> mini::MiniWin {
    let s = app.state::<AppState>().settings.lock().unwrap().clone();
    let mut list = s.mini_windows.clone();
    mini::find(&mut list, book, name)
        .map(|m| m.clone())
        .unwrap_or(mini::MiniWin {
            book: book.into(),
            name: name.into(),
            top: s.mini_on_top,
            opacity: s.mini_opacity,
            ..Default::default()
        })
}

fn update_entry(app: &AppHandle, book: &str, name: &str, change: impl FnOnce(&mut mini::MiniWin)) {
    let mut entry = mini_entry(app, book, name);
    change(&mut entry);
    let st = app.state::<AppState>();
    mini::remember(&mut st.settings.lock().unwrap().mini_windows, entry);
}

/// capture:快速记录(0.5.1),不受小窗开关和个数的限制,位置单独记,重启后不恢复
fn open_mini(
    app: &AppHandle,
    book: &str,
    name: &str,
    at: Option<(f64, f64)>,
    focus: bool,
    capture: bool,
) -> Result<(), String> {
    if let Some(m) = open_minis(app)
        .into_iter()
        .find(|m| m.book == book && m.name == name)
    {
        if let Some(w) = app.get_webview_window(&m.label) {
            let _ = w.show();
            let _ = w.set_focus();
        }
        // 这一页已经开在小窗里时按了快速记录:让那个小窗加一条新的
        if capture {
            let st = app.state::<AppState>();
            if let Some(o) = st
                .minis
                .lock()
                .unwrap()
                .iter_mut()
                .find(|o| o.label == m.label)
            {
                o.capture = true;
            }
            let _ = app.emit_to(m.label.as_str(), "mini-capture", ());
        }
        return Ok(());
    }
    let s = app.state::<AppState>().settings.lock().unwrap().clone();
    if !capture && !s.mini_enabled {
        return Err("小窗已经关掉了,可以在 设置 → 窗口 里打开".into());
    }
    let count = open_minis(app).len();
    if !capture && s.mini_max > 0 && count >= s.mini_max as usize {
        return Err(format!(
            "最多同时开 {} 个小窗,先关掉一个吧(设置 → 窗口 可以改)",
            s.mini_max
        ));
    }
    if !notes::page_path(&notes_dir(app, &s), book, name)?.is_file() {
        return Err(format!("找不到页面「{name}」"));
    }
    let st = app.state::<AppState>();
    let label = format!("mini-{}", st.mini_seq.fetch_add(1, Ordering::SeqCst) + 1);
    let entry = mini_entry(app, book, name);
    let (w, h) = if capture {
        (420.0, 300.0)
    } else {
        (340.0, 400.0)
    };
    let win = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(name)
        .inner_size(w, h)
        .min_inner_size(220.0, 140.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(entry.top)
        .skip_taskbar(!s.show_in_taskbar)
        .disable_drag_drop_handler()
        .focused(focus)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    if capture {
        place_capture(app, &win, &s);
    } else if entry.w > 0 {
        apply_saved_geometry(
            &win,
            &Geom {
                x: entry.x,
                y: entry.y,
                w: entry.w,
                h: entry.h,
            },
        );
    } else if let Some((x, y)) = at {
        // 从主窗口拖出来的:小窗出现在松手的地方
        let _ = win.set_position(tauri::LogicalPosition::new(x - 40.0, y - 14.0));
    } else if let Some(r) = main_window(app).and_then(|m| window_rect(&m)) {
        let step = 32 * (count as i32 + 1);
        let _ = win.set_position(PhysicalPosition::new(r.x + step, r.y + step));
    }
    st.minis.lock().unwrap().push(OpenMini {
        label,
        book: book.into(),
        name: name.into(),
        capture,
    });
    if !capture {
        update_entry(app, book, name, |m| m.open = true);
    }
    // 开机自启时主窗口藏在托盘里:恢复的小窗也先藏着,按热键时跟主窗口一起出来
    let hidden_main = !main_window(app).is_some_and(|m| m.is_visible().unwrap_or(false));
    if focus || s.mini_hotkey != "follow" || !hidden_main {
        let _ = win.show();
    }
    if focus {
        let _ = win.set_focus();
    }
    emit_minis(app);
    persist_settings(app);
    Ok(())
}

/// 快速记录的小窗放在哪:上次的位置(没有就和 center 一样)/ 鼠标所在屏幕的中间 / 鼠标旁边。
/// 不是 remember 时大小也用上次的
fn place_capture(app: &AppHandle, win: &WebviewWindow, s: &Settings) {
    if let Some(g) = s.capture_window.as_ref().filter(|g| g.w > 0) {
        if s.capture_position == "remember" {
            return apply_saved_geometry(win, g);
        }
        if g.w >= 200 && g.h >= 150 {
            let _ = win.set_size(PhysicalSize::new(g.w, g.h));
        }
    }
    let Ok(cursor) = app.cursor_position() else {
        let _ = win.center();
        return;
    };
    let monitor = app
        .monitor_from_point(cursor.x, cursor.y)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    let (Some(m), Ok(size)) = (monitor, win.outer_size()) else {
        let _ = win.center();
        return;
    };
    let a = m.work_area();
    let (x, y) = mini::capture_at(
        &s.capture_position,
        (
            a.position.x,
            a.position.y,
            a.size.width as i32,
            a.size.height as i32,
        ),
        (size.width as i32, size.height as i32),
        (cursor.x as i32, cursor.y as i32),
    );
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

/// 快速记录(0.5.1):快速记录的小窗开着、又在最前面,就收起它(小窗先存好);
/// 不然让主窗口找好要写的页面,用快速记录的方式打开小窗
fn quick_capture(app: &AppHandle) {
    let focused = open_minis(app).into_iter().find(|m| {
        m.capture
            && app
                .get_webview_window(&m.label)
                .is_some_and(|w| w.is_focused().unwrap_or(false))
    });
    match focused {
        Some(m) => {
            let _ = app.emit_to(m.label.as_str(), "mini-close-request", ());
        }
        None => {
            let _ = app.emit_to("main", "quick-capture", ());
        }
    }
}

/// 把一页放进小窗(主窗口已经先把这页存好了);x、y 是拖出标签时松手的屏幕位置;
/// capture 是快速记录。建窗口的命令要用 async,在 Windows 上同步命令里建窗口会卡死
#[tauri::command]
async fn mini_open(
    app: AppHandle,
    book: String,
    name: String,
    x: Option<f64>,
    y: Option<f64>,
    capture: Option<bool>,
) -> Result<(), String> {
    open_mini(&app, &book, &name, x.zip(y), true, capture == Some(true))
}

#[derive(Serialize)]
struct MiniSelf {
    book: String,
    name: String,
    top: bool,
    opacity: u32,
    capture: bool,
}

/// 小窗启动时问自己放的是哪一页
#[tauri::command]
fn mini_self(app: AppHandle, window: WebviewWindow) -> Option<MiniSelf> {
    let m = mini_by_label(&app, window.label())?;
    let e = mini_entry(&app, &m.book, &m.name);
    Some(MiniSelf {
        book: m.book,
        name: m.name,
        top: e.top,
        opacity: e.opacity,
        capture: m.capture,
    })
}

#[tauri::command]
fn mini_list(app: AppHandle) -> Vec<MiniPage> {
    mini_pages(&app)
}

/// 主窗口里点变淡的标签:把那个小窗叫到前面
#[tauri::command]
fn mini_focus(app: AppHandle, book: String, name: String) -> bool {
    let Some(m) = open_minis(&app)
        .into_iter()
        .find(|m| m.book == book && m.name == name)
    else {
        return false;
    };
    let Some(w) = app.get_webview_window(&m.label) else {
        return false;
    };
    let _ = w.show();
    let _ = w.set_focus();
    true
}

/// 主窗口里右键「放回主窗口」:让那个小窗存好页面后自己关掉
#[tauri::command]
fn mini_recall(app: AppHandle, book: String, name: String) -> bool {
    let Some(m) = open_minis(&app)
        .into_iter()
        .find(|m| m.book == book && m.name == name)
    else {
        return false;
    };
    app.emit_to(m.label.as_str(), "mini-recall", ()).is_ok()
}

/// 小窗存好页面后关掉自己;back = 「放回主窗口」(主窗口出来并切到这页)
#[tauri::command]
async fn mini_close(app: AppHandle, window: WebviewWindow, back: bool) {
    let Some(m) = mini_by_label(&app, window.label()) else {
        let _ = window.destroy();
        return;
    };
    update_entry(&app, &m.book, &m.name, |e| e.open = false);
    forget_mini(&app, &m.label);
    let _ = app.emit_to(
        "main",
        "mini-returned",
        serde_json::json!({ "book": m.book, "name": m.name, "back": back }),
    );
    let _ = window.destroy();
    if back {
        show_main(&app);
    }
    persist_settings(&app);
}

fn forget_mini(app: &AppHandle, label: &str) {
    let st = app.state::<AppState>();
    let removed = {
        let mut minis = st.minis.lock().unwrap();
        let before = minis.len();
        minis.retain(|m| m.label != label);
        before != minis.len()
    };
    st.mini_flush.lock().unwrap().0.remove(label);
    if removed {
        emit_minis(app);
    }
}

/// 小窗标题栏的置顶和不透明度
#[tauri::command]
fn mini_set(app: AppHandle, window: WebviewWindow, top: Option<bool>, opacity: Option<u32>) {
    let Some(m) = mini_by_label(&app, window.label()) else {
        return;
    };
    if let Some(top) = top {
        let _ = window.set_always_on_top(top);
    }
    update_entry(&app, &m.book, &m.name, |e| {
        if let Some(top) = top {
            e.top = top;
        }
        if let Some(o) = opacity {
            e.opacity = mini::clamp_opacity(o);
        }
    });
}

/// 主窗口读完笔记后调用:打开上次退出时还开着的小窗
#[tauri::command]
async fn mini_restore(app: AppHandle) {
    let pending = std::mem::take(&mut *app.state::<AppState>().mini_restore.lock().unwrap());
    for (book, name) in pending {
        if let Err(e) = open_mini(&app, &book, &name, None, false, false) {
            eprintln!("没能恢复小窗「{name}」:{e}");
        }
    }
}

/// 退出前让每个小窗把页面存好,最多等 8 秒;返回没存好的原因
#[tauri::command]
async fn mini_flush_all(app: AppHandle) -> Vec<String> {
    let minis = open_minis(&app);
    if minis.is_empty() {
        return Vec::new();
    }
    {
        let st = app.state::<AppState>();
        let mut f = st.mini_flush.lock().unwrap();
        f.0 = minis.iter().map(|m| m.label.clone()).collect();
        f.1.clear();
    }
    for m in &minis {
        let _ = app.emit_to(m.label.as_str(), "mini-flush", ());
    }
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let st = handle.state::<AppState>();
        for _ in 0..80 {
            if st.mini_flush.lock().unwrap().0.is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let mut f = st.mini_flush.lock().unwrap();
        let mut errors = std::mem::take(&mut f.1);
        for m in minis.iter().filter(|m| f.0.contains(&m.label)) {
            errors.push(format!("小窗「{}」没有回应", m.name));
        }
        f.0.clear();
        errors
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
fn mini_flushed(app: AppHandle, window: WebviewWindow, error: Option<String>) {
    let name = mini_by_label(&app, window.label())
        .map(|m| m.name)
        .unwrap_or_default();
    let st = app.state::<AppState>();
    let mut f = st.mini_flush.lock().unwrap();
    f.0.remove(window.label());
    if let Some(e) = error {
        f.1.push(format!("小窗「{name}」:{e}"));
    }
}

/// 小窗挪动或改大小:记下来,下次打开同一页时还在这里
fn remember_mini_geometry(app: &AppHandle, window: &tauri::Window) {
    let Some(m) = mini_by_label(app, window.label()) else {
        return;
    };
    let (Ok(p), Ok(s)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    if window.is_minimized().unwrap_or(false) || s.width == 0 {
        return;
    }
    if m.capture {
        app.state::<AppState>()
            .settings
            .lock()
            .unwrap()
            .capture_window = Some(Geom {
            x: p.x,
            y: p.y,
            w: s.width,
            h: s.height,
        });
        return;
    }
    update_entry(app, &m.book, &m.name, |e| {
        e.x = p.x;
        e.y = p.y;
        e.w = s.width;
        e.h = s.height;
    });
}

// ---------- 悬浮图标 ----------

fn ball_visible(app: &AppHandle) -> bool {
    app.get_webview_window("ball")
        .is_some_and(|b| b.is_visible().unwrap_or(false))
}

/// 自定义图标存在设置文件旁边,文件名 ball-icon.扩展名
fn ball_image_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = config_path(app).parent()?.to_path_buf();
    ball::IMAGE_EXTS
        .iter()
        .map(|ext| dir.join(format!("ball-icon.{ext}")))
        .find(|p| p.is_file())
}

fn ball_image_data(app: &AppHandle) -> Option<String> {
    let st = app.state::<AppState>();
    let Some(path) = ball_image_path(app) else {
        st.ball_image_cache.lock().unwrap().clear();
        return None;
    };
    let mime = ball::mime_for(path.extension()?.to_str()?)?;
    let meta = fs::metadata(&path).ok()?;
    let modified = meta.modified().ok()?;
    let result =
        st.ball_image_cache
            .lock()
            .unwrap()
            .get_or_load(&path, meta.len(), modified, || {
                let bytes = fs::read(&path).ok()?;
                Some(ball::data_url(mime, &bytes))
            });
    result
}

#[tauri::command]
fn refresh_ball_icon(app: AppHandle) -> Option<String> {
    app.state::<AppState>()
        .ball_image_cache
        .lock()
        .unwrap()
        .clear();
    let image = ball_image_data(&app);
    let _ = app.emit_to("ball", "ball-update", ());
    image
}

#[derive(Serialize)]
struct BallInfo {
    size: u32,
    icon: String,
    color: String,
    opacity: u32,
    open: String,
    /// 自定义图片(data: 网址),没有就是空
    image: Option<String>,
}

#[tauri::command]
fn ball_info(app: AppHandle) -> BallInfo {
    let s = app.state::<AppState>().settings.lock().unwrap().clone();
    BallInfo {
        size: s.ball_size,
        icon: s.ball_icon,
        color: s.ball_color,
        opacity: s.ball_opacity,
        open: s.ball_open,
        image: ball_image_data(&app),
    }
}

/// 选一张图片当悬浮图标,复制到设置文件旁边。返回图片(data: 网址),取消就是空
#[tauri::command]
async fn pick_ball_icon(app: AppHandle) -> Result<Option<String>, String> {
    let mut dialog = app
        .dialog()
        .file()
        .set_title("选择悬浮图标的图片")
        .add_filter("图片", &ball::IMAGE_EXTS);
    if let Some(win) = main_window(&app) {
        dialog = dialog.set_parent(&win);
    }
    let Some(src) = dialog.blocking_pick_file().and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|e| ball::mime_for(e).is_some())
        .ok_or("只支持 png、jpg、gif、webp、ico 图片")?;
    let len = fs::metadata(&src).map_err(|e| e.to_string())?.len();
    if len > ball::MAX_IMAGE {
        return Err("图片太大了,请选 2 MB 以内的图片".into());
    }
    let bytes = fs::read(&src).map_err(|e| e.to_string())?;
    let dir = config_path(&app)
        .parent()
        .map(Path::to_path_buf)
        .ok_or("找不到设置文件夹")?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // 先写新的再删旧的(扩展名可能不一样)
    let dest = dir.join(format!("ball-icon.{ext}"));
    fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    for other in ball::IMAGE_EXTS.iter().filter(|e| **e != ext) {
        let _ = fs::remove_file(dir.join(format!("ball-icon.{other}")));
    }
    app.state::<AppState>()
        .ball_image_cache
        .lock()
        .unwrap()
        .clear();
    let _ = app.emit_to("ball", "ball-update", ());
    Ok(Some(ball::data_url(
        ball::mime_for(&ext).unwrap_or("image/png"),
        &bytes,
    )))
}

fn ensure_ball(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(ball) = app.get_webview_window("ball") {
        return Ok(ball);
    }
    let side =
        f64::from(app.state::<AppState>().settings.lock().unwrap().ball_size) + 2.0 * ball::PAD;
    WebviewWindowBuilder::new(app, "ball", WebviewUrl::App("ball.html".into()))
        .title("Minipad Next")
        .inner_size(side, side)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())
}

/// 主窗口缩成悬浮图标
#[tauri::command]
fn collapse_to_ball(app: AppHandle) -> Result<(), String> {
    let Some(main) = main_window(&app) else {
        return Ok(());
    };
    restore_from_edge(&app, false);
    let ball_win = ensure_ball(&app)?;
    let s = app.state::<AppState>().settings.lock().unwrap().clone();
    let scale = main.scale_factor().unwrap_or(1.0);
    let side = f64::from(s.ball_size) + 2.0 * ball::PAD;
    let _ = ball_win.set_size(LogicalSize::new(side, side));
    let main_rect = window_rect(&main).unwrap_or(Rect::new(0, 0, 440, 540));
    let monitors: Vec<Rect> = main
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(monitor_rect)
        .collect();
    let (x, y) = ball::position(
        s.ball_pos,
        (side * scale).round() as i32,
        main_rect,
        &monitors,
    );
    let _ = ball_win.set_position(PhysicalPosition::new(x, y));
    let _ = app.emit_to("ball", "ball-update", ());
    let _ = ball_win.show();
    hide_main(&app);
    Ok(())
}

/// 点悬浮图标:放出主窗口
#[tauri::command]
fn expand_from_ball(app: AppHandle) {
    show_main(&app);
    persist_settings(&app);
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn window_rect(win: &WebviewWindow) -> Option<Rect> {
    let p = win.outer_position().ok()?;
    let s = win.outer_size().ok()?;
    Some(Rect::new(p.x, p.y, s.width as i32, s.height as i32))
}

fn monitor_rect(m: &Monitor) -> Rect {
    Rect::new(
        m.position().x,
        m.position().y,
        m.size().width as i32,
        m.size().height as i32,
    )
}

fn show_main(app: &AppHandle) {
    if let Some(ball) = app.get_webview_window("ball") {
        let _ = ball.hide();
    }
    if let Some(win) = main_window(app) {
        restore_from_edge(app, false);
        app.state::<AppState>()
            .typing
            .store(false, Ordering::SeqCst);
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        let _ = app.emit("shown", ());
    }
}

fn hide_main(app: &AppHandle) {
    if let Some(win) = main_window(app) {
        let _ = app.emit("flush", ());
        let _ = win.hide();
        resume_hotkey_if_paused(app);
        persist_settings(app);
    }
}

fn toggle_main(app: &AppHandle) {
    let Some(win) = main_window(app) else { return };
    let visible = win.is_visible().unwrap_or(false);
    let focused = win.is_focused().unwrap_or(false);
    let edge_hidden = app
        .state::<AppState>()
        .edge
        .lock()
        .unwrap()
        .hidden
        .is_some();
    // 小窗默认跟着主窗口一起藏起来、一起出来(设置里可以改成各管各的)
    let follow = app.state::<AppState>().settings.lock().unwrap().mini_hotkey == "follow";
    if visible && focused && !edge_hidden {
        if follow {
            for w in mini_windows(app) {
                let _ = w.hide();
            }
        }
        hide_main(app);
    } else {
        if follow {
            for w in mini_windows(app) {
                let _ = w.show();
            }
        }
        show_main(app);
    }
}

/// 从贴边隐藏状态滑回屏幕内
fn restore_from_edge(app: &AppHandle, focus: bool) {
    let Some(win) = main_window(app) else { return };
    let st = app.state::<AppState>();
    let (edge, mon) = {
        let e = st.edge.lock().unwrap();
        (e.hidden, e.monitor)
    };
    let Some(edge) = edge else { return };
    let Some(rect) = window_rect(&win) else {
        return;
    };
    let (x, y) = edge::shown_position(edge, rect, mon);
    // 缩进去时关掉了窗口阴影(不然会在屏幕边上投一大片黑影),放出来再打开
    let _ = win.set_shadow(true);
    let _ = win.set_position(PhysicalPosition::new(x, y));
    let _ = app.emit("edge-shown", ());
    {
        let mut e = st.edge.lock().unwrap();
        e.hidden = None;
        e.home = None;
        e.peeking = false;
        e.outside_ticks = 0;
    }
    st.typing.store(false, Ordering::SeqCst);
    if let Ok(size) = win.inner_size() {
        *st.geom.lock().unwrap() = Some(Geom {
            x,
            y,
            w: size.width,
            h: size.height,
        });
    }
    if focus {
        let _ = win.set_focus();
    }
}

/// 露出的宽度按逻辑像素算,换成这块屏幕的物理像素(高分屏上不会变细)
fn scaled_strip(
    win: &tauri::WebviewWindow,
    style: &str,
    peeking: bool,
    line_width: u32,
    glow: bool,
) -> i32 {
    let scale = win.scale_factor().unwrap_or(1.0);
    (f64::from(edge::strip_for(style, peeking, line_width, glow)) * scale).round() as i32
}

fn screen_of(m: &Monitor) -> edge::Screen {
    edge::Screen {
        rect: monitor_rect(m),
        scale: m.scale_factor(),
        name: m.name().cloned().unwrap_or_default(),
    }
}

/// 显示器断开又接上、分辨率或缩放改变后,Windows 会把窗口挪到别处(比如挪到笔记本屏上)。
/// 藏起来的窗口不在该在的位置时,贴回原来那条边:原来的显示器回来了就回到它上面、
/// 沿边的位置和藏起来时一样(按逻辑像素算);还没回来就先留在现在这块屏幕上。
/// 返回 true 表示这一轮已经处理过。
fn resnap_hidden(
    app: &AppHandle,
    win: &WebviewWindow,
    edge: Edge,
    rect: Rect,
    mon: Rect,
    peeking: bool,
) -> bool {
    let st = app.state::<AppState>();
    let screens: Vec<edge::Screen> = win
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(screen_of)
        .collect();
    // 显示器正在切换时可能一块都查不到,等下一轮
    let rects: Vec<Rect> = screens.iter().map(|s| s.rect).collect();
    let home = st
        .edge
        .lock()
        .unwrap()
        .home
        .as_ref()
        .map(|h| (h.rect, h.name.clone(), h.offset));
    let found = home
        .as_ref()
        .and_then(|(home_rect, name, _)| edge::find_home(*home_rect, name, &screens))
        .or_else(|| screens.iter().position(|s| s.rect == mon))
        .or_else(|| {
            let near = edge::nearest_monitor(rect, &rects)?;
            rects.iter().position(|r| *r == near)
        });
    let Some(target) = found.map(|i| &screens[i]) else {
        return false;
    };
    // 没记下位置时保持窗口现在的位置
    let offset = home
        .map(|(_, _, offset)| offset)
        .unwrap_or_else(|| edge::along_offset(edge, rect, target.rect, target.scale));
    // 先取出设置再问窗口缩放:后台线程查询窗口要等主线程,主线程上的命令又会锁设置
    let (style, line_width, glow) = {
        let settings = st.settings.lock().unwrap();
        (
            settings.edge_style.clone(),
            settings.edge_line_width,
            settings.edge_line_glow,
        )
    };
    let strip = scaled_strip(win, &style, peeking, line_width, glow);
    let (x, y) = edge::rehide_position(edge, rect, target.rect, target.scale, strip, offset);
    if target.rect == mon && (rect.x - x).abs() <= 2 && (rect.y - y).abs() <= 2 {
        return false;
    }
    st.edge.lock().unwrap().monitor = target.rect;
    if edge::edge_is_free(edge, Rect::new(x, y, rect.w, rect.h), target.rect, &rects) {
        let _ = win.set_position(PhysicalPosition::new(x, y));
    } else {
        // 这条边外面现在接着另一块显示器,缩过去会露在那块屏幕上:放出来留在屏幕里
        restore_from_edge(app, false);
    }
    true
}

fn edge_tick(app: &AppHandle) {
    let st = app.state::<AppState>();
    if !st.settings.lock().unwrap().edge_hide {
        return;
    }
    let Some(win) = main_window(app) else { return };
    if !win.is_visible().unwrap_or(false)
        || win.is_minimized().unwrap_or(false)
        || win.is_maximized().unwrap_or(false)
        || win.is_fullscreen().unwrap_or(false)
    {
        return;
    }
    let (Some(rect), Ok(cur)) = (window_rect(&win), win.cursor_position()) else {
        return;
    };
    let (cx, cy) = (cur.x.round() as i32, cur.y.round() as i32);

    let (hidden, peeking, mon) = {
        let e = st.edge.lock().unwrap();
        (e.hidden, e.peeking, e.monitor)
    };
    if let Some(edge) = hidden {
        if resnap_hidden(app, &win, edge, rect, mon, peeking) {
            return;
        }
        let (style, length, unit, fixed_px) = {
            let settings = st.settings.lock().unwrap();
            (
                settings.edge_style.clone(),
                settings.edge_line_length,
                settings.edge_line_length_unit.clone(),
                settings.edge_line_length_px,
            )
        };
        let inside = edge::IndicatorHotzone {
            edge,
            win: rect,
            mon,
            style: &style,
            length_percent: length,
            length_unit: &unit,
            length_px: fixed_px,
            peeking,
            scale: win.scale_factor().unwrap_or(1.0),
        }
        .contains(cx, cy);
        if style != "hover" {
            // 鼠标碰到露出来的那条边就滑出来
            if inside {
                restore_from_edge(app, true);
            }
            return;
        }
        // 悬浮按钮样式:靠近时只浮出按钮,点按钮才展开;离开约 0.45 秒后收回细边
        let change = {
            let mut e = st.edge.lock().unwrap();
            if inside {
                e.outside_ticks = 0;
                (!peeking).then_some(true)
            } else if peeking {
                e.outside_ticks += 1;
                (e.outside_ticks >= 3).then_some(false)
            } else {
                None
            }
        };
        if let Some(peek) = change {
            {
                let mut e = st.edge.lock().unwrap();
                e.peeking = peek;
                e.outside_ticks = 0;
            }
            // 先取出设置再问窗口缩放:后台线程查询窗口要等主线程,主线程上的命令又会锁设置
            let (line_width, glow) = {
                let settings = st.settings.lock().unwrap();
                (settings.edge_line_width, settings.edge_line_glow)
            };
            let (x, y) = edge::hidden_position_with_strip(
                edge,
                rect,
                mon,
                scaled_strip(&win, "hover", peek, line_width, glow),
            );
            let _ = win.set_position(PhysicalPosition::new(x, y));
            let _ = app.emit("edge-peek", peek);
        }
        return;
    }

    // 鼠标还在窗口上,或者正在打字,都不缩回去
    let busy = rect.contains_with_margin(cx, cy, 2)
        || (st.typing.load(Ordering::SeqCst) && win.is_focused().unwrap_or(false));
    let docked = if busy {
        None
    } else {
        win.current_monitor().ok().flatten().and_then(|m| {
            let screen = screen_of(&m);
            let monitors: Vec<Rect> = win
                .available_monitors()
                .unwrap_or_default()
                .iter()
                .map(monitor_rect)
                .collect();
            edge::docked_edge(rect, screen.rect, &monitors).map(|e| (e, screen))
        })
    };

    // 鼠标离开约 0.45 秒后再缩回去,避免误触
    let ready = {
        let mut e = st.edge.lock().unwrap();
        match docked {
            None => {
                e.outside_ticks = 0;
                None
            }
            Some((edge, screen)) => {
                e.outside_ticks += 1;
                if e.outside_ticks >= 3 {
                    e.hidden = Some(edge);
                    e.monitor = screen.rect;
                    e.home = Some(EdgeHome {
                        rect: screen.rect,
                        offset: edge::along_offset(edge, rect, screen.rect, screen.scale),
                        name: screen.name,
                    });
                    e.outside_ticks = 0;
                    Some((edge, screen.rect))
                } else {
                    None
                }
            }
        }
    };
    if let Some((edge, mon)) = ready {
        let (style, line_width, glow) = {
            let settings = st.settings.lock().unwrap();
            (
                settings.edge_style.clone(),
                settings.edge_line_width,
                settings.edge_line_glow,
            )
        };
        st.edge.lock().unwrap().peeking = false;
        let (x, y) = edge::hidden_position_with_strip(
            edge,
            rect,
            mon,
            scaled_strip(&win, &style, false, line_width, glow),
        );
        let _ = app.emit("flush", ());
        let _ = app.emit("edge-hidden", edge.name());
        // Windows 给无边框窗口加的阴影会从露出的细边上投到桌面和别的窗口上,缩进去时先关掉
        let _ = win.set_shadow(false);
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
}

/// 启动时恢复上次的位置和大小;如果那个位置已经不在任何显示器上就居中
fn apply_saved_geometry(win: &WebviewWindow, g: &Geom) {
    let monitors = win.available_monitors().unwrap_or_default();
    let visible = monitors.iter().any(|m| {
        let r = monitor_rect(m);
        g.x + 40 < r.x + r.w
            && g.x + g.w as i32 - 40 > r.x
            && g.y >= r.y - 4
            && g.y + 30 < r.y + r.h
    });
    if g.w >= 200 && g.h >= 150 {
        let _ = win.set_size(PhysicalSize::new(g.w, g.h));
    }
    if visible {
        let _ = win.set_position(PhysicalPosition::new(g.x, g.y));
    } else {
        let _ = win.center();
    }
}

// ---------- 启动 ----------

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let capture = *app.state::<AppState>().capture_key.lock().unwrap();
                    if capture == Some(shortcut.id()) {
                        quick_capture(app);
                    } else {
                        toggle_main(app);
                    }
                })
                .build(),
        )
        .manage(AppState::default())
        .register_uri_scheme_protocol("note", |ctx, request| {
            note_image(ctx.app_handle(), request.uri())
        })
        .invoke_handler(tauri::generate_handler![
            load_state,
            read_notes,
            book_exists,
            save_note,
            create_note,
            rename_note,
            delete_note,
            delete_if_empty,
            move_note,
            save_meta,
            create_book,
            rename_book,
            delete_book,
            set_book_appearance,
            start_window_drag,
            set_current_book,
            trash_list,
            trash_restore,
            trash_purge,
            trash_empty,
            backup_info,
            open_backup_dir,
            save_settings,
            pause_hotkey,
            resume_hotkey,
            note_activity,
            pick_folder,
            minipad2_preview,
            minipad2_stage,
            minipad2_import,
            hide_window,
            show_window,
            page_index,
            open_page_in_main,
            expand_edge,
            ball_info,
            pick_ball_icon,
            refresh_ball_icon,
            collapse_to_ball,
            expand_from_ball,
            open_notes_dir,
            open_link,
            webdav_set_password,
            webdav_test,
            webdav_status,
            webdav_sync_now,
            webdav_forget,
            local_path_exists,
            open_path,
            save_image,
            mini_open,
            mini_self,
            mini_list,
            mini_focus,
            mini_close,
            mini_recall,
            mini_set,
            mini_restore,
            mini_flush_all,
            mini_flushed,
            quit_app,
            quit_ack,
            quit_cancel
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            migrate_old_data(&handle);
            let (mut settings, write_allowed, read_error, settings_notice) = load_settings(&handle);
            if let Some(e) = &read_error {
                eprintln!("{e}；本次运行使用默认值，禁止自动覆盖 settings.json");
            }
            if let Some(notice) = &settings_notice {
                eprintln!("{notice}");
            }
            // 首次解析默认目录时可能把旧数据安全复制到 EXE 同级。
            // 配置暂时不可读(或损坏的原文件没能改名留底)时，运行中可使用默认目录，但不得将其写回配置文件。
            let default_notes = notes_dir(&handle, &settings);
            let default_backups = backup_dir(&handle, &settings);
            let pinned = pin_default_storage(&mut settings, &default_notes, &default_backups);
            notes::cleanup_stale_temps(&notes_dir(&handle, &settings));
            {
                let st = handle.state::<AppState>();
                st.settings_write_allowed
                    .store(write_allowed, Ordering::SeqCst);
                *st.settings_read_error.lock().unwrap() = read_error;
                *st.settings.lock().unwrap() = settings.clone();
                *st.geom.lock().unwrap() = settings.window.clone();
                // 上次退出时还开着的小窗:等主窗口读完笔记再打开
                if settings.mini_enabled && settings.mini_restore {
                    *st.mini_restore.lock().unwrap() = settings
                        .mini_windows
                        .iter()
                        .filter(|m| m.open)
                        .map(|m| (m.book.clone(), m.name.clone()))
                        .collect();
                }
                for m in st.settings.lock().unwrap().mini_windows.iter_mut() {
                    m.open = false;
                }
                // 损坏的原文件已经改名留底:马上写一份新的,免得没来得及保存就退出、下次启动又回到默认值
                if (pinned || settings_notice.is_some()) && write_allowed {
                    let path = config_path(&handle);
                    let mut last = st.settings_json.lock().unwrap();
                    if let Err(e) = write_settings_if_allowed(&path, &settings, true, &mut last) {
                        eprintln!("无法保存设置(迁移后的存储路径或损坏后整理出的设置): {e}");
                    }
                }
                *st.settings_notice.lock().unwrap() = settings_notice;
                if let Err(e) = register_hotkey(&handle, &settings.hotkey, capture_of(&settings)) {
                    eprintln!("热键注册失败: {e}");
                    *st.hotkey_error.lock().unwrap() = Some(format!("{}:{e}", settings.hotkey));
                }
                let capture_error = st.capture_error.lock().unwrap().clone();
                if let Some(e) = capture_error {
                    eprintln!("快速记录的热键注册失败: {e}");
                }
            }

            let win = main_window(&handle).expect("main window");
            let _ = win.set_always_on_top(settings.always_on_top);
            let _ = win.set_skip_taskbar(!settings.show_in_taskbar);
            if let Some(g) = &settings.window {
                apply_saved_geometry(&win, g);
            }
            let start_hidden = std::env::args().any(|a| a == "--hidden");
            if !start_hidden {
                let _ = win.show();
                let _ = win.set_focus();
            }

            // 托盘
            let toggle = MenuItem::with_id(app, "toggle", "显示 / 隐藏", true, None::<&str>)?;
            let capture = MenuItem::with_id(
                app,
                "capture",
                "快速记录",
                settings.capture_enabled,
                None::<&str>,
            )?;
            *handle.state::<AppState>().capture_item.lock().unwrap() = Some(capture.clone());
            let open_dir =
                MenuItem::with_id(app, "open_dir", "打开笔记文件夹", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle, &capture, &open_dir, &sep, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Minipad Next")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle_main(app),
                    "capture" => quick_capture(app),
                    "open_dir" => {
                        let _ = open_notes_dir(app.clone());
                    }
                    "quit" => {
                        request_tray_quit(app);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // 贴边隐藏轮询
            let h = handle.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(150));
                edge_tick(&h);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            let st = app.state::<AppState>();
            if window.label() == "ball" {
                match event {
                    // 悬浮图标关不掉,只记住拖到了哪里
                    WindowEvent::CloseRequested { api, .. } => api.prevent_close(),
                    WindowEvent::Moved(p) if window.is_visible().unwrap_or(false) => {
                        st.settings.lock().unwrap().ball_pos = Some([p.x, p.y]);
                    }
                    _ => {}
                }
                return;
            }
            if window.label().starts_with("mini-") {
                match event {
                    // Alt+F4 之类:让小窗先存好页面再自己关
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = app.emit_to(window.label(), "mini-close-request", ());
                    }
                    WindowEvent::Destroyed => forget_mini(app, window.label()),
                    WindowEvent::Focused(true) => {
                        let _ = app.emit_to(window.label(), "window-focus", ());
                    }
                    WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                        remember_mini_geometry(app, window)
                    }
                    _ => {}
                }
                return;
            }
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    // 关闭按钮只是隐藏到托盘
                    api.prevent_close();
                    hide_main(app);
                }
                WindowEvent::Focused(true) => {
                    // 前端借这个机会检查笔记有没有在别处被改过(小窗里改的也在这时读回来)
                    let _ = app.emit_to("main", "window-focus", ());
                }
                WindowEvent::Focused(false) => {
                    st.typing.store(false, Ordering::SeqCst);
                    resume_hotkey_if_paused(app);
                }
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    if st.edge.lock().unwrap().hidden.is_some() {
                        return;
                    }
                    if let (Ok(p), Ok(s)) = (window.outer_position(), window.inner_size()) {
                        if window.is_minimized().unwrap_or(false)
                            || window.is_maximized().unwrap_or(false)
                            || s.width == 0
                        {
                            return;
                        }
                        *st.geom.lock().unwrap() = Some(Geom {
                            x: p.x,
                            y: p.y,
                            w: s.width,
                            h: s.height,
                        });
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Minipad Next");
}

#[cfg(test)]
mod tests {
    use super::*;

    const STAMP: &str = "20261014-093000";

    fn locked() -> std::io::Result<Vec<u8>> {
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "模拟杀毒软件占用",
        ))
    }

    #[test]
    fn settings_read_states_distinguish_missing_valid_corrupt_and_unreadable() {
        let root = notes::temp_dir("settings-read-guard");
        let path = root.join("settings.json");

        let (missing, can_write, err, notice) =
            decode_settings_result(&path, fs::read(&path), STAMP);
        assert!(can_write);
        assert!(err.is_none() && notice.is_none());
        assert_eq!(missing.hotkey, "Ctrl+M");

        let original = r#"{"hotkey":"Ctrl+Alt+M","notes_dir":"D:\\\\custom","theme":"dark"}"#;
        fs::write(&path, original).unwrap();
        let (loaded, can_write, err, notice) =
            decode_settings_result(&path, fs::read(&path), STAMP);
        assert!(can_write);
        assert!(err.is_none() && notice.is_none());
        assert_eq!(loaded.hotkey, "Ctrl+Alt+M");
        assert_eq!(loaded.theme, "dark");

        // 内容损坏:原文件原样改名留底,本次用默认值,之后可以正常保存
        let corrupt = b"{\"hotkey\": ".to_vec();
        fs::write(&path, &corrupt).unwrap();
        let (fallback, can_write, err, notice) =
            decode_settings_result(&path, fs::read(&path), STAMP);
        let bad = root.join(format!("settings.json.bad-{STAMP}"));
        assert!(can_write);
        assert!(err.is_none());
        assert!(notice.unwrap().contains(&bad.display().to_string()));
        assert_eq!(fs::read(&bad).unwrap(), corrupt);
        assert!(!path.exists());
        assert_eq!(fallback.hotkey, "Ctrl+M");
        write_settings_if_allowed(&path, &fallback, can_write, &mut String::new()).unwrap();
        assert!(path.exists());

        // 读不出来(比如被独占):用默认值,禁止写回,原文件不动
        fs::write(&path, original).unwrap();
        let (fallback, can_write, err, notice) = decode_settings_result(&path, locked(), STAMP);
        assert!(!can_write);
        assert!(err.unwrap().contains("读取失败"));
        assert!(notice.is_none());
        write_settings_if_allowed(&path, &fallback, can_write, &mut String::new()).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), original);

        // 能读了以后，下次启动可继续读取自定义位置。
        let (recovered, can_write, err, _) = decode_settings_result(&path, fs::read(&path), STAMP);
        assert!(can_write);
        assert!(err.is_none());
        assert_eq!(recovered.notes_dir, "D:\\\\custom");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unreadable_settings_never_get_pinned_back_to_disk() {
        let root = notes::temp_dir("settings-guarded-pin");
        let path = root.join("settings.json");
        let damaged = b"old settings must survive";
        fs::write(&path, damaged).unwrap();
        let (mut fallback, can_write, _, _) = decode_settings_result(&path, locked(), STAMP);
        let pinned = pin_default_storage(
            &mut fallback,
            &root.join("installed").join("notes"),
            &root.join("installed").join("backups"),
        );
        assert!(pinned);
        assert!(!can_write);
        write_settings_if_allowed(&path, &fallback, can_write, &mut String::new()).unwrap();
        assert_eq!(fs::read(&path).unwrap(), damaged);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unchanged_settings_are_not_written_again() {
        let root = notes::temp_dir("settings-unchanged");
        let path = root.join("settings.json");
        let mut last = String::new();
        let mut s = Settings::default();
        write_settings_if_allowed(&path, &s, true, &mut last).unwrap();
        assert!(path.exists());
        // 内容没变就不写:删掉文件也不会被重新写出来
        fs::remove_file(&path).unwrap();
        write_settings_if_allowed(&path, &s, true, &mut last).unwrap();
        assert!(!path.exists());
        // 写失败(这里目标是个文件夹)不算写过,下次照样再写
        s.theme = "dark".into();
        fs::create_dir(&path).unwrap();
        assert!(write_settings_if_allowed(&path, &s, true, &mut last).is_err());
        fs::remove_dir(&path).unwrap();
        write_settings_if_allowed(&path, &s, true, &mut last).unwrap();
        let saved: Settings = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved.theme, "dark");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_settings_keep_every_field_that_still_reads() {
        let root = notes::temp_dir("settings-salvage");
        let path = root.join("settings.json");
        // 合法的 JSON,但字号写成了字符串、窗口位置也坏了:只丢这两项
        let broken = r#"{"hotkey":"Ctrl+Alt+N","notes_dir":"D:\\笔记","font_size":"18","theme":"dark","window":{"x":"left"}}"#;
        fs::write(&path, broken).unwrap();
        let (s, can_write, err, notice) = decode_settings_result(&path, fs::read(&path), STAMP);
        assert!(can_write && err.is_none() && notice.is_some());
        assert_eq!(
            (s.hotkey.as_str(), s.notes_dir.as_str(), s.theme.as_str()),
            ("Ctrl+Alt+N", "D:\\笔记", "dark")
        );
        assert_eq!(s.font_size, 14);
        assert!(s.window.is_none());
        // 同一秒里又坏了一次:新留底加 -2,不覆盖上一份
        fs::write(&path, "不是 JSON").unwrap();
        let (s, can_write, _, _) = decode_settings_result(&path, fs::read(&path), STAMP);
        assert!(can_write);
        assert_eq!(s.hotkey, "Ctrl+M");
        assert_eq!(
            fs::read_to_string(root.join(format!("settings.json.bad-{STAMP}"))).unwrap(),
            broken
        );
        assert_eq!(
            fs::read_to_string(root.join(format!("settings.json.bad-{STAMP}-2"))).unwrap(),
            "不是 JSON"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_settings_stay_protected_when_they_cannot_be_moved_aside() {
        let root = notes::temp_dir("settings-no-rename");
        // 改名失败(这里是因为文件夹不存在):和读不出来一样,用默认值、禁止写回
        let path = root.join("gone").join("settings.json");
        let (s, can_write, err, notice) =
            decode_settings_result(&path, Ok(br#"{"hotkey":"#.to_vec()), STAMP);
        assert!(!can_write);
        assert!(err.unwrap().contains("解析失败"));
        assert!(notice.is_none());
        assert_eq!(s.hotkey, "Ctrl+M");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn settings_reads_are_retried_unless_the_file_is_missing() {
        let mut calls = 0;
        let result = read_with_retry(
            || {
                calls += 1;
                if calls < 3 {
                    locked()
                } else {
                    Ok(b"{}".to_vec())
                }
            },
            3,
            Duration::ZERO,
        );
        assert_eq!(result.unwrap(), b"{}");
        assert_eq!(calls, 3);
        calls = 0;
        let result = read_with_retry(
            || {
                calls += 1;
                locked()
            },
            3,
            Duration::ZERO,
        );
        assert!(result.is_err());
        assert_eq!(calls, 4);
        calls = 0;
        let result = read_with_retry(
            || {
                calls += 1;
                Err(std::io::ErrorKind::NotFound.into())
            },
            3,
            Duration::ZERO,
        );
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::NotFound);
        assert_eq!(calls, 1);
    }

    #[test]
    fn old_settings_get_the_new_defaults() {
        // 0.2.1 的设置文件里还没有行号和日期格式
        let json = r#"{
            "hotkey": "Ctrl+Alt+M",
            "always_on_top": false,
            "edge_hide": true,
            "show_in_taskbar": true,
            "autostart": false,
            "theme": "dark",
            "font_size": 16,
            "notes_dir": "D:\\笔记",
            "backup_enabled": false,
            "backup_keep": 30,
            "backup_dir": "",
            "window": { "x": 10, "y": 20, "w": 500, "h": 600 }
        }"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        assert!(!s.line_numbers);
        assert!(s.code_line_numbers);
        assert!(s.code_lang_menu);
        assert!(s.code_title_color);
        assert!(s.update_check);
        assert_eq!(s.date_format, DEFAULT_DATE_FORMAT);
        assert_eq!(s.hotkey, "Ctrl+Alt+M");
        assert!(!s.always_on_top && s.show_in_taskbar && !s.backup_enabled);
        assert_eq!((s.theme.as_str(), s.font_size), ("dark", 16));
        assert_eq!(s.notes_dir, "D:\\笔记");
        assert_eq!(s.backup_keep, 30);
        let g = s.window.unwrap();
        assert_eq!((g.x, g.y, g.w, g.h), (10, 20, 500, 600));
    }

    #[test]
    fn small_window_settings_default_on_and_stay_in_range() {
        let s: Settings = serde_json::from_str(r#"{ "hotkey": "Ctrl+M" }"#).unwrap();
        assert!(s.mini_enabled && s.mini_on_top && s.mini_restore && s.mini_tab_button);
        assert_eq!(
            (s.mini_hotkey.as_str(), s.mini_opacity, s.mini_max),
            ("follow", 100, 0)
        );
        let mut s: Settings = serde_json::from_str(
            r#"{ "mini_hotkey": "sometimes", "mini_opacity": 3, "mini_max": 500,
                 "mini_windows": [{ "book": "", "name": "a", "opacity": 300, "open": true },
                                  { "book": "", "name": "a", "opacity": 60 }] }"#,
        )
        .unwrap();
        tidy_settings(&mut s);
        assert_eq!(s.mini_hotkey, "follow");
        assert_eq!((s.mini_opacity, s.mini_max), (mini::MIN_OPACITY, 20));
        assert_eq!(
            s.mini_windows.len(),
            1,
            "one remembered small window per page"
        );
        assert_eq!(s.mini_windows[0].opacity, 60);
    }

    #[test]
    fn tidy_settings_trims_and_limits() {
        let mut s = Settings {
            hotkey: " Ctrl+M ".into(),
            notes_dir: "  D:\\笔记 ".into(),
            backup_dir: " ".into(),
            backup_keep: 0,
            date_format: "  yyyy-MM-dd  ".into(),
            ..Settings::default()
        };
        tidy_settings(&mut s);
        assert_eq!(s.hotkey, "Ctrl+M");
        assert_eq!(s.notes_dir, "D:\\笔记");
        assert_eq!(s.backup_dir, "");
        assert_eq!(s.backup_keep, 1);
        assert_eq!(s.quick_color_count, 5);
        assert_eq!(s.quick_color_limit, 0, "no quick color limit by default");
        assert_eq!(s.date_format, "yyyy-MM-dd");

        s.backup_keep = 1000;
        s.quick_color_count = 0;
        s.date_format = " \t ".into();
        tidy_settings(&mut s);
        assert_eq!(s.backup_keep, 365);
        assert_eq!(s.quick_color_count, 1);
        s.quick_color_count = 999;
        s.quick_color_limit = 999;
        tidy_settings(&mut s);
        assert_eq!(s.quick_color_count, 128);
        assert_eq!(s.quick_color_limit, 128);
        assert_eq!(
            s.quick_colors, None,
            "old settings keep using the first quick_color_count colors"
        );
        s.quick_colors = Some(vec![
            "#ABCDEF".into(),
            "bad".into(),
            "#abcdef".into(),
            "#123456".into(),
        ]);
        tidy_settings(&mut s);
        assert_eq!(
            s.quick_colors,
            Some(vec!["#abcdef".to_string(), "#123456".to_string()])
        );
        // 纯色和渐变各自最多 128 个
        let gradients = (0..130).map(|i| format!("linear-gradient(135deg, #{i:06x}, #ffffff)"));
        let solids = (0..130).map(|i| format!("#{i:06x}"));
        s.color_library = Some(gradients.chain(solids).collect());
        s.color_layout = "grid".into();
        tidy_settings(&mut s);
        let library = s.color_library.as_ref().unwrap();
        assert_eq!(library.len(), 256);
        assert_eq!(library.iter().filter(|c| c.starts_with('#')).count(), 128);
        assert_eq!(
            s.color_layout, "tabs",
            "unknown layouts fall back to the top switch"
        );
        let gold = "linear-gradient(135deg, #a8741a 0%, #f6dc8a 30%, #9a6b16 100%)".to_string();
        s.color_library = Some(vec!["#111111".into(), gold.clone()]);
        s.material_library = Some(vec![gold.clone(), gold.clone(), "nope".into()]);
        s.color_open_tab = "material".into();
        tidy_settings(&mut s);
        assert_eq!(s.material_library, Some(vec![gold]));
        assert_eq!(
            s.color_library,
            Some(vec!["#111111".to_string()]),
            "a material is not also a gradient"
        );
        assert_eq!(s.color_open_tab, "material");
        assert_eq!(s.date_format, DEFAULT_DATE_FORMAT);

        // 字号和前端一样限制在 10..=28;按钮列表最多留 64 项
        s.font_size = 3;
        s.format_bar_hidden = vec!["x".into(); 100];
        s.format_bar_order = vec!["y".into(); 65];
        tidy_settings(&mut s);
        assert_eq!(s.font_size, 10);
        assert_eq!(
            (s.format_bar_hidden.len(), s.format_bar_order.len()),
            (64, 64)
        );
        s.font_size = 99;
        tidy_settings(&mut s);
        assert_eq!(s.font_size, 28);

        // 按字截断,不会把中文切坏;截断后末尾的空格也去掉
        s.date_format = "年月日".repeat(30);
        tidy_settings(&mut s);
        assert_eq!(s.date_format, format!("{}年", "年月日".repeat(21)));
        s.date_format = format!("{} H:mm", "年".repeat(63));
        tidy_settings(&mut s);
        assert_eq!(s.date_format, "年".repeat(63));
    }

    #[test]
    fn tidy_settings_falls_back_to_the_top_line_for_unknown_tab_styles() {
        for (given, kept) in [
            ("line", "line"),
            ("fill", "fill"),
            ("border", "border"),
            ("", "line"),
            ("glow", "line"),
        ] {
            let mut s = Settings {
                tab_style: given.into(),
                ..Settings::default()
            };
            tidy_settings(&mut s);
            assert_eq!(s.tab_style, kept, "{given}");
        }
    }

    #[test]
    fn tidy_settings_falls_back_to_starry_for_unknown_ui_styles() {
        assert_eq!(Settings::default().ui_style, "starry");
        for (given, kept) in [
            ("material", "material"),
            ("paper", "paper"),
            ("starry", "starry"),
            ("classic", "classic"),
            ("", "starry"),
            ("neon", "starry"),
        ] {
            let mut s = Settings {
                ui_style: given.into(),
                ..Settings::default()
            };
            tidy_settings(&mut s);
            assert_eq!(s.ui_style, kept, "{given}");
        }
        // 0.4.3 及以前的设置里没有这几项:用默认的星空渐变,侧栏和星光都开着
        let old: Settings = serde_json::from_str(r#"{"theme":"dark"}"#).unwrap();
        assert_eq!(old.ui_style, "starry");
        assert!(old.ui_tree && old.ui_rail && old.ui_stars);
    }

    #[test]
    fn tidy_settings_keeps_floating_icon_options_in_range() {
        let mut s = Settings::default();
        assert!(!s.ball_enabled);
        assert_eq!(
            (
                s.ball_size,
                s.ball_icon.as_str(),
                s.ball_opacity,
                s.ball_open.as_str()
            ),
            (48, "app", 100, "click")
        );
        s.ball_size = 500;
        s.ball_opacity = 5;
        s.ball_icon = "rocket".into();
        s.ball_open = "hover".into();
        s.ball_color = "#8b5cf6".into();
        tidy_settings(&mut s);
        assert_eq!(
            (
                s.ball_size,
                s.ball_icon.as_str(),
                s.ball_opacity,
                s.ball_open.as_str()
            ),
            (96, "app", 30, "click")
        );
        assert_eq!(s.ball_color, "#8b5cf6");
        s.ball_size = 1;
        s.ball_icon = "custom".into();
        s.ball_open = "dblclick".into();
        tidy_settings(&mut s);
        assert_eq!(
            (s.ball_size, s.ball_icon.as_str(), s.ball_open.as_str()),
            (32, "custom", "dblclick")
        );
    }

    #[test]
    fn tidy_settings_keeps_find_and_conflict_options_known() {
        let mut s = Settings::default();
        assert_eq!(
            (
                s.ctrl_f.as_str(),
                s.find_bar_pos.as_str(),
                s.find_color.as_str(),
                s.conflict_mode.as_str()
            ),
            ("page", "top", "", "copy")
        );
        s.ctrl_f = "all".into();
        s.find_bar_pos = "bottom".into();
        s.find_color = " #8b5cf6 ".into();
        s.conflict_mode = "overwrite".into();
        tidy_settings(&mut s);
        assert_eq!(
            (
                s.ctrl_f.as_str(),
                s.find_bar_pos.as_str(),
                s.find_color.as_str(),
                s.conflict_mode.as_str()
            ),
            ("all", "bottom", "#8b5cf6", "overwrite")
        );
        s.ctrl_f = "everything".into();
        s.find_bar_pos = "left".into();
        s.find_color = "url(javascript:x)".into();
        s.conflict_mode = "ask".into();
        tidy_settings(&mut s);
        assert_eq!(
            (
                s.ctrl_f.as_str(),
                s.find_bar_pos.as_str(),
                s.find_color.as_str(),
                s.conflict_mode.as_str()
            ),
            ("page", "top", "", "copy")
        );
        // 0.2.9 的设置文件里没有这几项,读出来是默认值
        let old: Settings = serde_json::from_str(r#"{"hotkey":"Ctrl+M"}"#).unwrap();
        assert_eq!(
            (old.ctrl_f.as_str(), old.conflict_mode.as_str()),
            ("page", "copy")
        );
    }

    #[test]
    fn tidy_settings_keeps_page_link_options_known() {
        let mut s = Settings::default();
        let options = |s: &Settings| {
            [
                s.page_link_click.clone(),
                s.page_link_suggest.clone(),
                s.page_link_rename.clone(),
                s.page_link_brackets.clone(),
                s.page_link_underline.clone(),
                s.page_link_color.clone(),
                s.page_link_broken_color.clone(),
            ]
        };
        assert_eq!(
            options(&s),
            ["ctrl", "brackets", "ask", "faint", "hover", "", ""]
        );
        assert!(s.page_links && s.page_link_cn_brackets && s.pinyin_match);
        s.page_link_click = "click".into();
        s.page_link_suggest = "typing".into();
        s.page_link_rename = "auto".into();
        s.page_link_brackets = "hide".into();
        s.page_link_underline = "dashed".into();
        s.page_link_color = " #16A34A ".into();
        s.page_link_broken_color = "linear-gradient(90deg, #112233, #445566)".into();
        tidy_settings(&mut s);
        assert_eq!(
            options(&s),
            [
                "click",
                "typing",
                "auto",
                "hide",
                "dashed",
                "#16a34a",
                "linear-gradient(90deg, #112233, #445566)"
            ]
        );
        s.page_link_click = "double".into();
        s.page_link_suggest = "always".into();
        s.page_link_rename = "never".into();
        s.page_link_brackets = "bold".into();
        s.page_link_underline = "wavy".into();
        s.page_link_color = "red".into();
        s.page_link_broken_color = "url(javascript:x)".into();
        tidy_settings(&mut s);
        assert_eq!(
            options(&s),
            ["ctrl", "brackets", "ask", "faint", "hover", "", ""]
        );
        // 0.4.5 的设置文件里没有这几项,读出来是默认值
        let old: Settings = serde_json::from_str(r#"{"hotkey":"Ctrl+M"}"#).unwrap();
        assert!(old.page_links && old.pinyin_match);
        assert_eq!(old.page_link_rename, "ask");
    }

    #[test]
    fn tidy_settings_keeps_capture_template_snippet_and_calc_options_known() {
        let mut s = Settings::default();
        let options = |s: &Settings| {
            [
                s.capture_target.clone(),
                s.capture_where.clone(),
                s.capture_format.clone(),
                s.capture_position.clone(),
                s.snippet_key.clone(),
                s.calc_key.clone(),
                s.calc_decimals.clone(),
            ]
        };
        assert_eq!(
            options(&s),
            ["page", "end", "paragraph", "remember", "tab", "tab", "auto"]
        );
        assert!(s.capture_enabled && s.capture_stamp && !s.calc_thousands);
        assert_eq!(s.capture_hotkey, "Ctrl+Alt+M");
        assert_eq!(
            (s.capture_page.as_str(), s.template_book.as_str()),
            ("收集箱", "模板")
        );
        s.capture_target = "new".into();
        s.capture_where = "start".into();
        s.capture_format = "task".into();
        s.capture_position = "cursor".into();
        s.snippet_key = "space".into();
        s.calc_key = "equals".into();
        s.calc_decimals = "2".into();
        tidy_settings(&mut s);
        assert_eq!(
            options(&s),
            ["new", "start", "task", "cursor", "space", "equals", "2"]
        );
        s.capture_target = "both".into();
        s.capture_where = "middle".into();
        s.capture_format = "heading".into();
        s.capture_position = "top".into();
        s.snippet_key = "enter".into();
        s.calc_key = "always".into();
        s.calc_decimals = "7".into();
        tidy_settings(&mut s);
        assert_eq!(
            options(&s),
            ["page", "end", "paragraph", "remember", "tab", "tab", "auto"]
        );
        // 名字:去掉首尾空格,空着用默认的
        s.capture_hotkey = "  Ctrl+Shift+K ".into();
        s.capture_page = "  ".into();
        s.capture_name = " 灵感 {{日期}} ".into();
        s.template_book = "".into();
        tidy_settings(&mut s);
        assert_eq!(s.capture_hotkey, "Ctrl+Shift+K");
        assert_eq!(s.capture_page, "收集箱");
        assert_eq!(s.capture_name, "灵感 {{日期}}");
        assert_eq!(s.template_book, "模板");
        // 0.5.0 的设置文件里没有这几项,读出来是默认值(三个默认片段)
        let old: Settings = serde_json::from_str(r#"{"hotkey":"Ctrl+M"}"#).unwrap();
        assert!(old.capture_enabled);
        // 0.5.1 及以前的设置里没有「新建笔记本放欢迎页」:默认开着
        assert!(old.new_book_welcome);
        assert_eq!(
            old.snippets
                .iter()
                .map(|s| s.trigger.as_str())
                .collect::<Vec<_>>(),
            [";rq", ";sj", ";xq"]
        );
    }

    #[test]
    fn snippets_need_a_trigger_without_spaces_and_keep_the_first_of_each() {
        let snip = |trigger: &str, text: &str| Snippet {
            trigger: trigger.into(),
            text: text.into(),
        };
        let mut list = vec![
            snip(" ;dz ", "地址"),
            snip("", "没有触发词"),
            snip("a b", "有空格"),
            snip(";dz", "重复的"),
            snip(&"x".repeat(33), "太长"),
            snip(";long", &"字".repeat(10_005)),
        ];
        list.extend((0..300).map(|i| snip(&format!(";s{i}"), "")));
        tidy_snippets(&mut list);
        assert_eq!(list.len(), 200);
        assert_eq!(list[0], snip(";dz", "地址"));
        assert_eq!(list[1].trigger, ";long");
        assert_eq!(list[1].text.chars().count(), 10_000);
        assert_eq!(list[2].trigger, ";s0");
    }

    #[test]
    fn capture_hotkey_cannot_be_the_main_hotkey() {
        let mut s = Settings::default();
        assert!(check_capture_hotkey(&s).is_ok());
        s.capture_hotkey = "ctrl+m".into();
        assert!(check_capture_hotkey(&s).is_err());
        s.capture_hotkey = "Control+M".into();
        assert!(check_capture_hotkey(&s).is_err());
        // 关掉了或者空着就不用比
        s.capture_enabled = false;
        assert!(check_capture_hotkey(&s).is_ok());
        s.capture_enabled = true;
        s.capture_hotkey = String::new();
        assert!(check_capture_hotkey(&s).is_ok());
        assert_eq!(capture_of(&s), None);
    }

    #[test]
    fn tidy_settings_keeps_settings_nav_known() {
        let mut s = Settings::default();
        assert_eq!(s.settings_nav, "left");
        s.settings_nav = "top".into();
        tidy_settings(&mut s);
        assert_eq!(s.settings_nav, "top");
        s.settings_nav = "right".into();
        tidy_settings(&mut s);
        assert_eq!(s.settings_nav, "left");
        // 0.3.0 的设置文件里没有这一项,读出来是默认值
        let old: Settings = serde_json::from_str(r#"{"hotkey":"Ctrl+M"}"#).unwrap();
        assert_eq!(old.settings_nav, "left");
    }

    #[test]
    fn tidy_settings_keeps_tab_bar_options_known() {
        let mut s = Settings::default();
        assert_eq!(
            (
                s.tab_overflow.as_str(),
                s.tab_fade,
                s.tab_list_button,
                s.tab_rows,
                s.tab_drawer_side.as_str(),
                s.tab_drawer_width,
                s.tab_groups,
                s.tab_group_style.as_str()
            ),
            ("scroll", true, true, 4, "left", 200, false, "line")
        );
        s.tab_overflow = "drawer".into();
        s.tab_drawer_side = "right".into();
        s.tab_group_style = "tint".into();
        tidy_settings(&mut s);
        assert_eq!(
            (
                s.tab_overflow.as_str(),
                s.tab_drawer_side.as_str(),
                s.tab_group_style.as_str()
            ),
            ("drawer", "right", "tint")
        );
        s.tab_overflow = "shrink".into();
        s.tab_drawer_side = "top".into();
        s.tab_group_style = "dot".into();
        s.tab_rows = 30;
        s.tab_drawer_width = 20;
        tidy_settings(&mut s);
        assert_eq!(
            (
                s.tab_overflow.as_str(),
                s.tab_drawer_side.as_str(),
                s.tab_group_style.as_str(),
                s.tab_rows,
                s.tab_drawer_width
            ),
            ("scroll", "left", "line", 8, 140)
        );
        // 0.3.1 的设置文件里没有这些,读出来是默认值
        let old: Settings = serde_json::from_str(r#"{"hotkey":"Ctrl+M"}"#).unwrap();
        assert_eq!(
            (old.tab_overflow.as_str(), old.tab_fade, old.tab_groups),
            ("scroll", true, false)
        );
    }

    #[test]
    fn tidy_settings_keeps_selection_bar_options_known() {
        let mut s = Settings::default();
        assert_eq!(
            (s.sel_bar.as_str(), s.sel_bar_pos.as_str()),
            ("always", "above")
        );
        assert_eq!(s.sel_bar_items.first().map(String::as_str), Some("block"));
        s.sel_bar = "sometimes".into();
        s.sel_bar_pos = "left".into();
        s.sel_bar_items = vec!["strong".into(), "".into(), "strong".into(), "em".into()];
        tidy_settings(&mut s);
        assert_eq!(
            (s.sel_bar.as_str(), s.sel_bar_pos.as_str()),
            ("always", "above")
        );
        assert_eq!(s.sel_bar_items, vec!["strong", "em"]);
        s.sel_bar = "nobar".into();
        tidy_settings(&mut s);
        assert_eq!(s.sel_bar, "nobar");
        // 0.3.1 的设置文件里没有这些,读出来是默认值
        let old: Settings = serde_json::from_str(r#"{"hotkey":"Ctrl+M"}"#).unwrap();
        assert_eq!(
            (old.sel_bar.as_str(), old.sel_bar_items.len()),
            ("always", 9)
        );
    }

    #[test]
    fn tidy_settings_keeps_outline_options_in_range() {
        let mut s = Settings::default();
        assert_eq!(
            (
                s.outline_enabled,
                s.outline_mode.as_str(),
                s.outline_side.as_str(),
                s.outline_depth,
                s.outline_width,
                s.outline_opacity
            ),
            (false, "hover", "right", 3, 200, 100)
        );
        s.outline_mode = "pinned".into();
        s.outline_side = "left".into();
        s.outline_color = " #3b82f6 ".into();
        tidy_settings(&mut s);
        assert_eq!(
            (
                s.outline_mode.as_str(),
                s.outline_side.as_str(),
                s.outline_color.as_str()
            ),
            ("pinned", "left", "#3b82f6")
        );
        s.outline_mode = "float".into();
        s.outline_side = "top".into();
        s.outline_depth = 9;
        s.outline_width = 20;
        s.outline_opacity = 0;
        s.outline_color = "red; x".into();
        tidy_settings(&mut s);
        assert_eq!(
            (
                s.outline_mode.as_str(),
                s.outline_side.as_str(),
                s.outline_depth,
                s.outline_width,
                s.outline_opacity,
                s.outline_color.as_str()
            ),
            ("hover", "right", 6, 140, 40, "")
        );
        // 0.3.0 的设置文件里没有这几项,读出来是默认值(目录关着)
        let old: Settings = serde_json::from_str(r#"{"hotkey":"Ctrl+M"}"#).unwrap();
        assert!(!old.outline_enabled);
        assert_eq!((old.outline_depth, old.outline_width), (3, 200));
    }

    #[test]
    fn edge_line_dimensions_are_backward_compatible_and_bounded() {
        let old: Settings = serde_json::from_str(r#"{"edge_style":"line"}"#).unwrap();
        assert_eq!(old.edge_line_width, 2);
        assert_eq!(old.edge_line_length, 100);
        assert_eq!(old.edge_line_length_unit, "percent");
        assert_eq!(old.edge_line_length_px, 120);
        assert!(!old.edge_line_glow);

        let mut s = Settings {
            edge_style: "arrow-only".into(),
            edge_line_width: 0,
            edge_line_length: 0,
            edge_line_length_unit: "other".into(),
            edge_line_length_px: 0,
            ..Settings::default()
        };
        tidy_settings(&mut s);
        assert_eq!(s.edge_style, "arrow-only");
        assert_eq!(s.edge_line_width, 1);
        assert_eq!(s.edge_line_length, 10);
        assert_eq!(s.edge_line_length_unit, "percent");
        assert_eq!(s.edge_line_length_px, 24);

        s.edge_line_width = 200;
        s.edge_line_length = 200;
        s.edge_line_length_px = 2000;
        s.edge_line_length_unit = "px".into();
        tidy_settings(&mut s);
        assert_eq!(s.edge_line_width, 12);
        assert_eq!(s.edge_line_length, 100);
        assert_eq!(s.edge_line_length_px, 600);
        assert_eq!(s.edge_line_length_unit, "px");
    }

    #[test]
    fn tidy_settings_checks_edge_style_and_color() {
        let mut s = Settings::default();
        assert_eq!(s.edge_style, "arrow");
        assert_eq!(s.edge_color, "");
        for style in ["arrow", "line", "hover"] {
            s.edge_style = style.into();
            tidy_settings(&mut s);
            assert_eq!(s.edge_style, style);
        }
        s.edge_style = "glow".into();
        s.edge_color = " linear-gradient(135deg, #5fb4ff, #d66cf0) ".into();
        tidy_settings(&mut s);
        assert_eq!(s.edge_style, "arrow");
        assert_eq!(s.edge_color, "linear-gradient(135deg, #5fb4ff, #d66cf0)");
        s.edge_color = "url(javascript:x)".into();
        tidy_settings(&mut s);
        assert_eq!(s.edge_color, "");
    }

    #[test]
    fn shared_color_presets_migrate_once_without_resurrecting_deleted_entries() {
        let mut old: Settings = serde_json::from_str(
            r##"{"book_color_presets":["#123456","linear-gradient(135deg, #abcdef, #012345)"]}"##,
        )
        .unwrap();
        assert!(old.color_presets.is_none());
        tidy_settings(&mut old);
        assert_eq!(old.color_presets.as_ref().unwrap().len(), 2);
        let written = serde_json::to_value(&old).unwrap();
        assert!(
            written.get("book_color_presets").is_none(),
            "旧预设字段只读，不再写回"
        );
        assert_eq!(written["color_presets"].as_array().unwrap().len(), 2);
        old.color_presets = Some(Vec::new());
        tidy_settings(&mut old);
        assert!(old.color_presets.unwrap().is_empty());
    }

    #[test]
    fn old_color_presets_reach_the_frontend_right_after_startup() {
        // book_color_presets 不写回也不交给前端,所以启动读取时就要迁移到 color_presets
        let root = notes::temp_dir("settings-old-presets");
        let path = root.join("settings.json");
        fs::write(
            &path,
            r##"{"book_color_presets":["#123456","linear-gradient(135deg, #ABCDEF, #012345)"],"font_size":40}"##,
        )
        .unwrap();
        let (s, can_write, _, _) = decode_settings_result(&path, fs::read(&path), STAMP);
        assert!(can_write);
        assert_eq!(
            s.color_presets.as_deref().unwrap(),
            ["#123456", "linear-gradient(135deg, #abcdef, #012345)"]
        );
        assert_eq!(s.font_size, 28);
        let sent = serde_json::to_value(&s).unwrap();
        assert_eq!(sent["color_presets"].as_array().unwrap().len(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn notebook_user_color_presets_are_safe_unique_and_bounded() {
        let mut s = Settings {
            book_color_presets: vec![
                "#ABCDEF".into(),
                "#abcdef".into(),
                "linear-gradient(135deg, #FF0000, #00FF00)".into(),
                "javascript:alert(1)".into(),
            ],
            ..Settings::default()
        };
        tidy_settings(&mut s);
        assert_eq!(
            s.color_presets.clone().unwrap(),
            vec!["#abcdef", "linear-gradient(135deg, #ff0000, #00ff00)"]
        );
        s.color_presets = Some((0..40).map(|i| format!("#{:06x}", i)).collect());
        tidy_settings(&mut s);
        assert_eq!(s.color_presets.as_ref().unwrap().len(), 20);
        assert!(serde_json::from_str::<Settings>(r#"{"theme":"dark"}"#)
            .unwrap()
            .color_presets
            .is_none());
    }

    #[test]
    fn editable_color_library_preserves_empty_and_legacy_settings() {
        let old: Settings = serde_json::from_str(
            r##"{"color_presets":["#abcdef"],"book_color_presets":["#123456"]}"##,
        )
        .unwrap();
        assert!(
            old.color_library.is_none(),
            "older settings use the initial palette"
        );
        let mut s = Settings {
            color_library: Some(vec![
                "#ABCDEF".into(),
                "#abcdef".into(),
                "foo".into(),
                "linear-gradient(90deg, #112233 0%, #445566 40%, #778899 100%)".into(),
            ]),
            ..Settings::default()
        };
        tidy_settings(&mut s);
        assert_eq!(
            s.color_library.as_ref().unwrap(),
            &vec![
                "#abcdef".to_string(),
                "linear-gradient(90deg, #112233 0%, #445566 40%, #778899 100%)".to_string()
            ],
        );
        s.color_library = Some(Vec::new());
        tidy_settings(&mut s);
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["color_library"], serde_json::json!([]));
        let restored: Settings = serde_json::from_value(json).unwrap();
        assert_eq!(
            restored.color_library,
            Some(Vec::new()),
            "deleted defaults must not reappear"
        );
    }

    #[test]
    fn tidy_settings_validates_all_custom_colors_like_notebook_icons() {
        let valid = "linear-gradient(90deg, #112233 0%, #445566 25%, #778899 100%)";
        let mut s = Settings {
            accent: " red ".into(),
            edge_color: "foo".into(),
            ball_color: format!("  {valid}  "),
            find_color: "#ABCDEF".into(),
            outline_color: "blue".into(),
            ..Settings::default()
        };
        tidy_settings(&mut s);
        assert_eq!(s.accent, "");
        assert_eq!(s.edge_color, "");
        assert_eq!(s.ball_color, valid);
        assert_eq!(s.find_color, "#abcdef");
        assert_eq!(s.outline_color, "");
        s.edge_color = "linear-gradient(90deg, #112233 120%, #445566 100%)".into();
        s.accent = "linear-gradient(20deg, red, foo)".into();
        tidy_settings(&mut s);
        assert_eq!(s.edge_color, "");
        assert_eq!(s.accent, "");
    }

    #[test]
    fn tidy_settings_keeps_only_plain_accent_values() {
        let mut s = Settings::default();
        for ok in [
            "",
            "#3b82f6",
            "linear-gradient(135deg, #ff5f6d, #ffa94d, #f5d142)",
        ] {
            s.accent = format!("  {ok} ");
            tidy_settings(&mut s);
            assert_eq!(s.accent, ok);
        }
        let long = "#".repeat(200);
        for bad in [
            "url(javascript:x)",
            "red; background: url(x)",
            long.as_str(),
        ] {
            s.accent = bad.to_string();
            tidy_settings(&mut s);
            assert_eq!(s.accent, "", "{bad}");
        }
    }
    #[test]
    fn hotkey_failure_prevents_folder_copy() {
        use std::cell::{Cell, RefCell};
        let events = RefCell::new(Vec::new());
        let copied = Cell::new(false);
        let error = apply_settings_side_effects(
            true,
            true,
            true,
            |new| {
                events
                    .borrow_mut()
                    .push(if new { "new-hotkey" } else { "old-hotkey" });
                if new {
                    Err("快捷键被占用".into())
                } else {
                    Ok(())
                }
            },
            |enabled| {
                events.borrow_mut().push(if enabled {
                    "autostart-on"
                } else {
                    "autostart-off"
                });
                Ok(())
            },
            || {
                copied.set(true);
                Ok(())
            },
        )
        .unwrap_err();
        assert!(error.contains("快捷键被占用"));
        assert_eq!(*events.borrow(), ["new-hotkey", "old-hotkey"]);
        assert!(!copied.get());
    }

    #[test]
    fn autostart_failure_does_not_copy_and_restores_hotkey() {
        use std::cell::{Cell, RefCell};
        let events = RefCell::new(Vec::new());
        let copied = Cell::new(false);
        let error = apply_settings_side_effects(
            true,
            true,
            true,
            |new| {
                events
                    .borrow_mut()
                    .push(if new { "new-hotkey" } else { "old-hotkey" });
                Ok(())
            },
            |enabled| {
                events.borrow_mut().push(if enabled {
                    "autostart-on"
                } else {
                    "autostart-off"
                });
                Err("启动设置不可用".into())
            },
            || {
                copied.set(true);
                Ok(())
            },
        )
        .unwrap_err();
        assert!(error.contains("启动设置不可用"));
        assert_eq!(
            *events.borrow(),
            ["new-hotkey", "autostart-on", "old-hotkey"]
        );
        assert!(!copied.get());
    }

    #[test]
    fn folder_copy_failure_reverts_autostart_and_hotkey() {
        use std::cell::RefCell;
        let events = RefCell::new(Vec::new());
        let root = notes::temp_dir("settings-rollback");
        let old_dir = root.join("old");
        let dest = root.join("dest");
        fs::create_dir_all(&old_dir).unwrap();
        fs::write(old_dir.join("note.md"), "old").unwrap();
        fs::create_dir_all(&dest).unwrap();
        fs::write(dest.join("occupied.md"), "no overwrite").unwrap();
        let err = apply_settings_side_effects(
            true,
            true,
            true,
            |new| {
                events
                    .borrow_mut()
                    .push(if new { "new-hotkey" } else { "old-hotkey" });
                Ok(())
            },
            |enabled| {
                events.borrow_mut().push(if enabled {
                    "autostart-on"
                } else {
                    "autostart-off"
                });
                Ok(())
            },
            || notes::copy_notes_for_switch(&old_dir, &dest),
        )
        .unwrap_err();
        assert!(err.contains("目标文件夹为空"));
        assert_eq!(
            *events.borrow(),
            ["new-hotkey", "autostart-on", "autostart-off", "old-hotkey"]
        );
        assert_eq!(
            fs::read_to_string(dest.join("occupied.md")).unwrap(),
            "no overwrite"
        );
        assert_eq!(fs::read_to_string(old_dir.join("note.md")).unwrap(), "old");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn explicit_storage_paths_survive_install_location_changes() {
        let root = notes::temp_dir("sticky-path");
        let old_install = root.join("old-app");
        let new_install = root.join("new-app");
        let stale_appdata = root.join("old-appdata");
        fs::create_dir_all(&old_install).unwrap();
        fs::create_dir_all(&new_install).unwrap();
        fs::create_dir_all(&stale_appdata).unwrap();
        fs::write(stale_appdata.join("stale.md"), "旧副本").unwrap();
        let original = preferred_storage_dir(&old_install, &stale_appdata, "notes");
        fs::write(original.join("current.md"), "最近更新").unwrap();
        let mut settings = Settings::default();
        assert!(pin_default_storage(
            &mut settings,
            &original,
            &old_install.join("backups"),
        ));
        let encoded = serde_json::to_string(&settings).unwrap();
        let reloaded: Settings = serde_json::from_str(&encoded).unwrap();
        assert!(!pin_default_storage(
            &mut reloaded.clone(),
            &new_install.join("notes"),
            &new_install.join("backups"),
        ));
        assert_eq!(PathBuf::from(reloaded.notes_dir.as_str()), original);
        assert_eq!(
            fs::read_to_string(PathBuf::from(reloaded.notes_dir.as_str()).join("current.md"))
                .unwrap(),
            "最近更新"
        );
        assert_eq!(
            reloaded.backup_dir,
            old_install.join("backups").to_string_lossy()
        );
        assert!(!new_install.join("notes").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unwritable_install_folder_falls_back_even_with_empty_notes_directory() {
        let root = notes::temp_dir("readonly-install");
        let program = root.join("installed");
        let legacy = root.join("appdata");
        fs::create_dir_all(program.join("notes")).unwrap();
        fs::create_dir_all(program.join("backups")).unwrap();
        for folder in ["notes", "backups"] {
            assert_eq!(
                preferred_storage_dir_with_probe(&program, &legacy, folder, |_| false),
                legacy
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn executable_extensions_are_checked_case_insensitively() {
        for path in [
            "C:/tools/start.EXE",
            "C:/tools/run.Ps1",
            "C:/tools/link.LNK",
        ] {
            assert!(is_executable_path(Path::new(path)), "{path}");
        }
        for path in ["C:/notes/report.md", "C:/notes/fake.exe.txt"] {
            assert!(!is_executable_path(Path::new(path)), "{path}");
        }
    }

    #[test]
    fn path_command_rejects_relative_paths() {
        assert!(parse_local_path("readme.md").is_err());
        assert!(parse_local_path("https://example.com/file").is_err());
    }

    #[test]
    fn configured_storage_paths_are_never_overwritten() {
        let mut settings = Settings {
            notes_dir: "D:\\\\notes".into(),
            backup_dir: "E:\\\\backups".into(),
            ..Settings::default()
        };
        assert!(!pin_default_storage(
            &mut settings,
            Path::new("C:/app/notes"),
            Path::new("C:/app/backups"),
        ));
        assert_eq!(settings.notes_dir, "D:\\\\notes");
        assert_eq!(settings.backup_dir, "E:\\\\backups");
    }

    #[test]
    fn default_storage_prefers_program_folder_without_losing_existing_legacy_data() {
        let root = notes::temp_dir("default-path");
        let program = root.join("program");
        let legacy = root.join("legacy-notes");
        fs::create_dir_all(&program).unwrap();
        assert_eq!(
            preferred_storage_dir(&program, &legacy, "notes"),
            program.join("notes")
        );
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("previous.md"), "old").unwrap();
        assert_eq!(
            preferred_storage_dir(&program, &legacy, "notes"),
            program.join("notes")
        );
        assert_eq!(
            fs::read_to_string(program.join("notes").join("previous.md")).unwrap(),
            "old"
        );
        assert_eq!(
            fs::read_to_string(legacy.join("previous.md")).unwrap(),
            "old"
        );
        fs::write(program.join("notes").join("new.md"), "new").unwrap();
        assert_eq!(
            preferred_storage_dir(&program, &legacy, "notes"),
            program.join("notes")
        );
        fs::remove_dir_all(root).unwrap();
    }
}
