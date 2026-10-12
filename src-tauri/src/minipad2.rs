//! 从 minipad2(3.2 版)导入笔记。只读 minipad2 的文件,不改它们。
//!
//! minipad2 把全部页面存在程序文件夹下 data 里的两个文件中:
//! - minipad2.idx:页面目录。第一行是版本号,第二行是可以复用的 id,之后每行一个页面:
//!   `id ⇥ 上级页面的 id ⇥ 页面类型 ⇥ 文字长度 ⇥ 字段 ⇥ 字段…`。字段里的 \x01 代表 Tab、\x02 代表换行。
//! - minipad2.dat:所有页面的文字按 id 从小到大首尾相接,每段多长(UTF-16 单元数)记在目录里。
//!
//! 两个文件都是 UTF-16LE,开头可能先有一个 0xFD 字节(minipad2 的「加密数据文件」选项,内容其实没变),再是 BOM。
//! 笔记里 \x1c 开始一段高亮,\x1d \x1e \x1f \x7f 结束它,分别是第 1~4 种高亮;
//! 每种的颜色和画不画下划线在程序文件夹 minipad2.ini 的 [Editor] 里(HLColor1~4、HLUnderline1~4)。
//!
//! 导入时每个分组变成一个新笔记本(不和已有的合并),笔记变成 .md 页面,
//! 备忘录、链接、通讯录、文字模板、快速链接、剪贴文字各自整理成一页。
//! 笔记是纯文字,写成 Markdown 时把会被当成格式的符号转义掉,在编辑器里看到的和 minipad2 里一样。

use crate::notes;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

/// 根页面的 id;分组、回收站、快速链接这些都挂在它下面
const ROOT_ID: i64 = -1;

// minipad2 的页面类型编号
const GROUP: i32 = 0;
const NOTE: i32 = 1;
const CALC: i32 = 2;
const MEMO: i32 = 3;
const DICT: i32 = 4;
const LINK: i32 = 5;
const CONTACT: i32 = 6;
const TEMPLATE: i32 = 7;
const FAST_LINK: i32 = 8;
const RECYCLE_BIN: i32 = 13;
const MEMO_ITEM: i32 = 15;
const LINK_ITEM: i32 = 16;
const CONTACT_ITEM: i32 = 17;
const TEMPLATE_ITEM: i32 = 18;
const GROUP_ROOT: i32 = 22;
const ROOT: i32 = 23;
const CLIP: i32 = 25;
const CLIP_ITEM: i32 = 26;
const EXTERNAL_NOTE: i32 = 27;

/// 字段里排第 17 个的是子页面顺序的页面类型
const CONTAINERS: [i32; 10] = [
    GROUP,
    MEMO,
    LINK,
    CONTACT,
    TEMPLATE,
    FAST_LINK,
    RECYCLE_BIN,
    GROUP_ROOT,
    ROOT,
    CLIP,
];
/// 存着一段文字的页面:笔记、计算、词典
const TEXT_PAGES: [i32; 4] = [NOTE, CALC, DICT, EXTERNAL_NOTE];
/// 一列条目的页面
const LIST_PAGES: [i32; 5] = [MEMO, LINK, CONTACT, TEMPLATE, FAST_LINK];

/// 高亮开始的标记;结束标记决定是哪种高亮
const HL_OPEN: char = '\u{1c}';
fn hl_close(c: char) -> Option<usize> {
    match c {
        '\u{1d}' => Some(0),
        '\u{1e}' => Some(1),
        '\u{1f}' => Some(2),
        '\u{7f}' => Some(3),
        _ => None,
    }
}

/// 导入窗口里的选项
#[derive(Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Options {
    /// groups:每个分组一个笔记本 / single:全部放进一个笔记本
    pub layout: String,
    /// 不在分组里的页面放进的笔记本(single 时就是唯一的那个)
    pub base: String,
    pub skip_empty: bool,
    /// 备忘录、链接、通讯录、文字模板、快速链接,每个整理成一页
    pub lists: bool,
    pub clips: bool,
    /// 回收站里的页面放进「<base> 回收站」笔记本
    pub recycle: bool,
    /// 高亮写成文字颜色 / 背景色;关掉就只留文字
    pub highlights: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            layout: "groups".into(),
            base: "minipad2".into(),
            skip_empty: true,
            lists: true,
            clips: false,
            recycle: false,
            highlights: true,
        }
    }
}

/// 选好文件夹后先看看里面有什么,导入窗口据此显示数量和选项
#[derive(Serialize, Debug, Default)]
pub struct Preview {
    pub version: String,
    /// 找到的 minipad2.idx 所在的文件夹
    pub folder: String,
    pub groups: usize,
    /// 笔记页面(不算回收站里的)
    pub pages: usize,
    /// 其中空白的
    pub empty: usize,
    /// 有内容的备忘录、链接、通讯录、文字模板、快速链接页面
    pub lists: usize,
    pub clips: usize,
    /// 回收站里的笔记页面
    pub recycled: usize,
    /// 笔记里用了高亮
    pub highlights: bool,
    pub warnings: Vec<String>,
}

/// 导入的结果
#[derive(Serialize, Debug)]
pub struct Imported {
    /// 新建的笔记本,按导入的顺序
    pub books: Vec<String>,
    pub pages: usize,
    /// 因为是空白页面而跳过的
    pub skipped: usize,
    pub warnings: Vec<String>,
}

/// 一种高亮的样子:画下划线的写成文字颜色(编辑器没有彩色下划线),否则写成背景色
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Scheme {
    /// 0xRRGGBB
    rgb: u32,
    underline: bool,
}

impl Scheme {
    fn css(self) -> String {
        let prop = if self.underline {
            "color"
        } else {
            "background-color"
        };
        format!("{prop}: #{:06x}", self.rgb)
    }
}

/// minipad2 自己的默认高亮:红、蓝下划线,粉、黄底
const DEFAULT_SCHEMES: [Scheme; 4] = [
    Scheme {
        rgb: 0xff3232,
        underline: true,
    },
    Scheme {
        rgb: 0x503cff,
        underline: true,
    },
    Scheme {
        rgb: 0xff80ff,
        underline: false,
    },
    Scheme {
        rgb: 0xffff14,
        underline: false,
    },
];

struct Record {
    id: i64,
    owner: i64,
    kind: i32,
    len: usize,
    fields: Vec<String>,
    /// 从 minipad2.dat 里取出的文字(还带着高亮标记,换行是 \r\n)
    text: String,
}

impl Record {
    fn field(&self, i: usize) -> &str {
        self.fields.get(i).map(String::as_str).unwrap_or("")
    }

    fn flag(&self, i: usize) -> bool {
        let v = self.field(i).trim();
        v == "1" || v.eq_ignore_ascii_case("true")
    }

    fn name(&self) -> String {
        self.field(0).trim().to_string()
    }

    /// 页面名,没起名字的按类型给一个
    fn page_name(&self) -> String {
        let name = self.name();
        if !name.is_empty() {
            return name;
        }
        match self.kind {
            CALC => "计算",
            DICT => "词典",
            MEMO => "备忘录",
            LINK => "链接",
            CONTACT => "通讯录",
            TEMPLATE => "文字模板",
            FAST_LINK => "快速链接",
            CLIP => "剪贴文字",
            _ => "未命名",
        }
        .to_string()
    }

    /// 子页面的顺序(只有分组这类页面有)
    fn child_list(&self) -> Vec<i64> {
        if !CONTAINERS.contains(&self.kind) {
            return Vec::new();
        }
        self.field(16)
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect()
    }
}

struct Source {
    version: String,
    folder: PathBuf,
    prog_dir: PathBuf,
    /// 按 id 从小到大
    records: Vec<Record>,
    by_id: HashMap<i64, usize>,
    /// 每个页面的子页面,按 minipad2 里的顺序
    children: HashMap<i64, Vec<i64>>,
    schemes: [Scheme; 4],
    warnings: Vec<String>,
}

/// 去掉开头的 0xFD 和 BOM,按 UTF-16LE 读成单元
fn utf16_units(bytes: &[u8]) -> Vec<u16> {
    let mut b = bytes;
    if b.first() == Some(&0xFD) {
        b = &b[1..];
    }
    if b.starts_with(&[0xFF, 0xFE]) {
        b = &b[2..];
    }
    let (pairs, _) = b.as_chunks::<2>();
    pairs.iter().map(|&p| u16::from_le_bytes(p)).collect()
}

/// 用户选的可能是 minipad2 的程序文件夹、它的 data 文件夹,或者 minipad2.idx 本身
fn locate(path: &Path) -> Result<PathBuf, String> {
    let candidates = if path.is_file() {
        vec![path.to_path_buf()]
    } else {
        vec![
            path.join("minipad2.idx"),
            path.join("data").join("minipad2.idx"),
        ]
    };
    candidates.into_iter().find(|p| p.is_file()).ok_or_else(|| {
        format!(
            "「{}」里没有找到 minipad2 的数据。请选 minipad2 的程序文件夹(里面有 data 文件夹),或者它的 data 文件夹",
            path.display()
        )
    })
}

fn parse_record(line: &str) -> Option<Record> {
    let mut parts = line.splitn(5, '\t');
    let id = parts.next()?.trim().parse().ok()?;
    let owner = parts.next()?.trim().parse().ok()?;
    let kind = parts.next()?.trim().parse().ok()?;
    let len: i64 = parts.next()?.trim().parse().ok()?;
    let fields = parts
        .next()
        .map(|v| {
            v.split('\t')
                .map(|f| f.replace('\u{1}', "\t").replace('\u{2}', "\n"))
                .collect()
        })
        .unwrap_or_default();
    Some(Record {
        id,
        owner,
        kind,
        len: usize::try_from(len).unwrap_or(0),
        fields,
        text: String::new(),
    })
}

/// 从 minipad2.ini 的 [Editor] 里读高亮颜色,没有的用 minipad2 的默认值
fn read_schemes(ini: &Path) -> [Scheme; 4] {
    let mut schemes = DEFAULT_SCHEMES;
    let Ok(bytes) = fs::read(ini) else {
        return schemes;
    };
    let mut in_editor = false;
    for line in notes::decode_text(&bytes).lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_editor = line.eq_ignore_ascii_case("[Editor]");
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if !in_editor {
            continue;
        }
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim();
        let slot = |prefix: &str| {
            key.strip_prefix(prefix)
                .and_then(|n| n.parse::<usize>().ok())
                .filter(|n| (1..=4).contains(n))
                .map(|n| n - 1)
        };
        if let Some(i) = slot("hlcolor") {
            // TColor 是 R | G<<8 | B<<16;负数、超出范围的是系统颜色,不认
            if let Ok(c) = value.parse::<u32>() {
                if c <= 0xFF_FFFF {
                    schemes[i].rgb = ((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF);
                }
            }
        } else if let Some(i) = slot("hlunderline") {
            schemes[i].underline = value == "1" || value.eq_ignore_ascii_case("true");
        }
    }
    schemes
}

fn load(path: &Path) -> Result<Source, String> {
    let idx = locate(path)?;
    let folder = idx.parent().map(Path::to_path_buf).unwrap_or_default();
    let prog_dir = folder
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| folder.clone());
    let bytes = fs::read(&idx).map_err(|e| format!("读不了 {}:{e}", idx.display()))?;
    let text = String::from_utf16_lossy(&utf16_units(&bytes));
    let mut lines = text.split("\r\n");
    let version = lines.next().unwrap_or("").trim().to_string();
    if !version.starts_with(|c: char| c.is_ascii_digit()) || version.chars().count() > 20 {
        return Err(format!(
            "{} 不是 minipad2 的数据文件(第一行应该是版本号)",
            idx.display()
        ));
    }
    if !version.starts_with("3.2.") {
        return Err(format!(
            "这是 minipad2 {version} 的数据,只能导入 3.2 版的。请先用 minipad2 3.2 打开一次(它会把数据升级到新格式),再来导入"
        ));
    }
    lines.next(); // 可以复用的 id

    let mut warnings = Vec::new();
    let mut records: Vec<Record> = Vec::new();
    let mut seen = HashSet::new();
    let (mut bad, mut dup) = (0, 0);
    for line in lines.filter(|l| !l.is_empty()) {
        match parse_record(line) {
            Some(r) if seen.insert(r.id) => records.push(r),
            Some(_) => dup += 1,
            None => bad += 1,
        }
    }
    if bad > 0 {
        warnings.push(format!("目录里有 {bad} 行看不懂,跳过了"));
    }
    if dup > 0 {
        warnings.push(format!("目录里有 {dup} 个重复的页面编号,只取了第一个"));
    }
    records.sort_by_key(|r| r.id);

    // 文字按 id 顺序首尾相接
    let dat = idx.with_extension("dat");
    let units = match fs::read(&dat) {
        Ok(b) => utf16_units(&b),
        Err(_) => {
            if records.iter().any(|r| r.len > 0) {
                warnings.push(format!("没找到 {},页面内容会是空的", dat.display()));
            }
            Vec::new()
        }
    };
    let mut offset = 0usize;
    let mut short = false;
    for r in &mut records {
        let end = offset.saturating_add(r.len);
        if end > units.len() {
            short = true;
        }
        let (from, to) = (offset.min(units.len()), end.min(units.len()));
        r.text = String::from_utf16_lossy(&units[from..to]);
        offset = end;
    }
    if short && !units.is_empty() {
        warnings.push("minipad2.dat 比目录里记的短,有些页面的内容可能不完整".into());
    }

    let by_id: HashMap<i64, usize> = records.iter().enumerate().map(|(i, r)| (r.id, i)).collect();
    let mut children: HashMap<i64, Vec<i64>> = HashMap::new();
    for r in records.iter().filter(|r| r.id != r.owner) {
        children.entry(r.owner).or_default().push(r.id);
    }
    // 先按上级页面里记的顺序,没记的按 id
    for (owner, kids) in children.iter_mut() {
        let Some(list) = by_id.get(owner).map(|&i| records[i].child_list()) else {
            continue;
        };
        let mut pos = HashMap::new();
        for (i, id) in list.into_iter().enumerate() {
            pos.entry(id).or_insert(i);
        }
        kids.sort_by_key(|id| pos.get(id).copied().unwrap_or(usize::MAX));
    }

    let schemes = read_schemes(&prog_dir.join("minipad2.ini"));
    Ok(Source {
        version,
        folder,
        prog_dir,
        records,
        by_id,
        children,
        schemes,
        warnings,
    })
}

impl Source {
    fn get(&self, id: i64) -> Option<&Record> {
        self.by_id.get(&id).map(|&i| &self.records[i])
    }

    fn kids(&self, id: i64) -> impl Iterator<Item = &Record> {
        self.children
            .get(&id)
            .into_iter()
            .flatten()
            .filter_map(move |&c| self.get(c))
    }

    /// 上级页面里有没有回收站
    fn in_recycle_bin(&self, id: i64) -> bool {
        let mut seen = HashSet::new();
        let mut cur = self.get(id).map(|r| r.owner);
        while let Some(owner) = cur {
            if !seen.insert(owner) {
                return false;
            }
            let Some(r) = self.get(owner) else {
                return false;
            };
            if r.kind == RECYCLE_BIN {
                return true;
            }
            cur = Some(r.owner);
        }
        false
    }

    /// 笔记的文字。选了「外部保存」的笔记存在单独的文件里,读不到再用 minipad2.dat 里的
    fn page_text(&self, r: &Record, warnings: &mut Vec<String>) -> String {
        let file = r.field(8).trim();
        if r.flag(7) && !file.is_empty() {
            let path = PathBuf::from(file);
            let path = if path.is_absolute() {
                path
            } else {
                self.prog_dir.join(path)
            };
            match fs::read(&path) {
                Ok(bytes) => return notes::decode_text(&bytes),
                Err(_) => warnings.push(format!(
                    "「{}」的内容存在 {} 里,但读不到这个文件,改用了 minipad2 里存的那份",
                    r.page_name(),
                    path.display()
                )),
            }
        }
        r.text.clone()
    }

    fn list_items(&self, r: &Record) -> Vec<&Record> {
        let item = match r.kind {
            MEMO => MEMO_ITEM,
            LINK | FAST_LINK => LINK_ITEM,
            CONTACT => CONTACT_ITEM,
            TEMPLATE => TEMPLATE_ITEM,
            CLIP => CLIP_ITEM,
            _ => return Vec::new(),
        };
        self.kids(r.id).filter(|c| c.kind == item).collect()
    }
}

// ---------- 纯文字写成 Markdown ----------

/// 网址开头;写成 <网址>,编辑器显示的还是原样的文字
const URL_SCHEMES: [&str; 5] = ["http://", "https://", "ftp://", "file://", "mailto:"];

/// 从 `i` 开始是不是一个网址:返回网址结束的位置,和要不要写成 <网址>(www. 开头的原样写,编辑器自己认得)
fn url_at(chars: &[char], i: usize) -> Option<(usize, bool)> {
    if i > 0 && chars[i - 1].is_ascii_alphanumeric() {
        return None;
    }
    let head: String = chars[i..chars.len().min(i + 8)]
        .iter()
        .collect::<String>()
        .to_ascii_lowercase();
    let scheme = URL_SCHEMES.iter().find(|s| head.starts_with(*s));
    let www = head.starts_with("www.");
    if scheme.is_none() && !www {
        return None;
    }
    // 网址到空白、尖括号或者中文标点为止
    let mut end = i;
    while end < chars.len()
        && !chars[end].is_whitespace()
        && !chars[end].is_control()
        && !matches!(chars[end], '<' | '>' | '\u{3000}'..='\u{303f}' | '\u{ff00}'..='\u{ffef}' | '“' | '”' | '‘' | '’' | '…' | '—')
    {
        end += 1;
    }
    // 末尾的标点不算网址的一部分(和编辑器认网址的规矩一样)
    let paren = chars[i..end].contains(&'(');
    while end > i
        && (matches!(
            chars[end - 1],
            '.' | ',' | ':' | ';' | '!' | '?' | '\'' | '"' | '*' | '_' | '~'
        ) || (chars[end - 1] == ')' && !paren))
    {
        end -= 1;
    }
    let url: String = chars[i..end].iter().collect();
    match scheme {
        Some(s) if url.len() > s.len() => Some((end, true)),
        // www. 后面得像个域名,不然编辑器不认,里面的符号就得转义
        None if www && plain_domain(&url) => Some((end, false)),
        _ => None,
    }
}

/// www.example.com/… 的域名部分只有字母、数字、-、.,而且 www. 后面至少还有一段
fn plain_domain(url: &str) -> bool {
    let domain = url.split(['/', '?', '#']).next().unwrap_or("");
    let Some(rest) = domain.get(4..) else {
        return false;
    };
    !rest.is_empty()
        && rest
            .split('.')
            .all(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        && url.chars().all(|c| c.is_ascii_graphic())
}

/// 把一段纯文字写成 Markdown,让编辑器原样显示(不会变成标题、列表、加粗、链接……)。
/// `line_start`:这段文字在一行的开头。网址保留成编辑器里可以点的链接。
fn escape(text: &str, line_start: bool) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len() + 8);
    let mut i = 0;
    if line_start {
        match chars.first() {
            // 行首的空白会被吃掉(还可能变成代码块):第一个写成字符引用
            Some(' ') => {
                out.push_str("&#x20;");
                i = 1;
            }
            Some('\t') => {
                out.push_str("&#x9;");
                i = 1;
            }
            // 标题、引用、列表、分隔线
            Some('#' | '>' | '-' | '+' | '=') => out.push('\\'),
            _ => {
                // 「1. 」「2) 」开头是有序列表
                let digits = chars.iter().take_while(|c| c.is_ascii_digit()).count();
                if (1..=9).contains(&digits)
                    && matches!(chars.get(digits), Some('.' | ')'))
                    && matches!(chars.get(digits + 1), None | Some(' ' | '\t'))
                {
                    out.extend(&chars[..digits]);
                    out.push('\\');
                    i = digits;
                }
            }
        }
    }
    while i < chars.len() {
        if let Some((end, bracket)) = url_at(&chars, i) {
            let url: String = chars[i..end].iter().collect();
            if bracket {
                out.push('<');
                out.push_str(&url);
                out.push('>');
            } else {
                out.push_str(&url);
            }
            i = end;
            continue;
        }
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        match c {
            // 反斜杠后面是标点(或者在末尾,会变成换行)时要再写一个
            '\\' => {
                out.push('\\');
                if next.is_none_or(|n| n.is_ascii_punctuation()) {
                    out.push('\\');
                }
            }
            '*' | '`' | '~' | '[' | '|' | '<' => {
                out.push('\\');
                out.push(c);
            }
            // 夹在两个字母或数字中间的 _ 不会变成斜体
            '_' => {
                let inside = i > 0
                    && chars[i - 1].is_alphanumeric()
                    && next.is_some_and(char::is_alphanumeric);
                if !inside {
                    out.push('\\');
                }
                out.push('_');
            }
            // &amp; &#123; 这样的会被当成字符引用
            '&' => {
                if next.is_some_and(|n| n.is_ascii_alphanumeric() || n == '#') {
                    out.push('\\');
                }
                out.push('&');
            }
            _ => out.push(c),
        }
        i += 1;
    }
    out
}

/// 标题里的文字:再把 # 转义掉(末尾的 # 会被当成标题的结束符号)
fn heading(text: &str) -> String {
    escape(text.trim(), false).replace('#', "\\#")
}

/// 一段文字按高亮切开:(文字, 第几种高亮)。没配对的标记丢掉,其他控制字符(Tab、换行除外)也去掉
fn highlight_segments(text: &str) -> Vec<(String, Option<usize>)> {
    let mut segments = Vec::new();
    let mut plain = String::new();
    let mut open: Option<String> = None;
    for c in text.chars() {
        if c == HL_OPEN {
            match open.replace(String::new()) {
                Some(unclosed) => segments.push((unclosed, None)),
                None => segments.push((std::mem::take(&mut plain), None)),
            }
        } else if let Some(k) = hl_close(c) {
            if let Some(inner) = open.take() {
                segments.push((inner, Some(k)));
            }
        } else if c == '\n' || c == '\t' || !c.is_control() {
            open.as_mut().unwrap_or(&mut plain).push(c);
        }
    }
    if let Some(unclosed) = open {
        segments.push((unclosed, None));
    }
    segments.push((plain, None));
    segments.retain(|(s, _)| !s.is_empty());
    segments
}

/// 把一行(几段文字)写成 Markdown;空行返回 None
fn render_line(mut segs: Vec<(String, Option<Scheme>)>) -> Option<String> {
    // 行尾的空白看不见,而且两个空格结尾会变成换行
    while let Some((s, _)) = segs.last_mut() {
        let keep = s.trim_end_matches([' ', '\t']).len();
        s.truncate(keep);
        if !s.is_empty() {
            break;
        }
        segs.pop();
    }
    if segs.is_empty() {
        return None;
    }
    // 行首的空白不放进颜色里:编辑器保存时会把它挪到颜色外面的行首,下次打开就被吃掉了
    if segs[0].1.is_some() {
        let s = &segs[0].0;
        let ws = s.len() - s.trim_start_matches([' ', '\t']).len();
        if ws > 0 {
            let lead = s[..ws].to_string();
            segs[0].0.replace_range(..ws, "");
            segs.insert(0, (lead, None));
            segs.retain(|(s, _)| !s.is_empty());
        }
    }
    let mut out = String::new();
    for (i, (text, scheme)) in segs.iter().enumerate() {
        let md = escape(text, i == 0);
        match scheme {
            Some(s) => {
                out.push_str(&format!("<span style=\"{}\">{md}</span>", s.css()));
            }
            None => out.push_str(&md),
        }
    }
    Some(out)
}

/// minipad2 的一段纯文字(可能带高亮)写成 Markdown:每行之间是换行,空行分段,多出来的空行写成空段落
fn text_markdown(text: &str, schemes: Option<&[Scheme; 4]>) -> String {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines: Vec<Vec<(String, Option<Scheme>)>> = vec![Vec::new()];
    for (s, k) in highlight_segments(&text) {
        let scheme = k.and_then(|k| schemes.map(|all| all[k]));
        for (i, part) in s.split('\n').enumerate() {
            if i > 0 {
                lines.push(Vec::new());
            }
            if !part.is_empty() {
                lines.last_mut().unwrap().push((part.to_string(), scheme));
            }
        }
    }
    let mut out = String::new();
    let mut blank = 0;
    let mut started = false;
    for line in lines {
        let Some(md) = render_line(line) else {
            blank += 1;
            continue;
        };
        if started {
            if blank == 0 {
                out.push('\n');
            } else {
                out.push_str("\n\n");
                blank -= 1;
            }
        }
        for _ in 0..blank {
            out.push_str("<br />\n\n");
        }
        out.push_str(&md);
        started = true;
        blank = 0;
    }
    out
}

/// 去掉高亮标记和控制字符(Tab、换行除外),换行统一成 \n
fn clean(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|&c| c == '\n' || c == '\t' || !c.is_control())
        .collect()
}

/// 原样保留的代码块(文字模板、剪贴文字:代码块右上角有复制按钮)
fn code_block(text: &str) -> Option<String> {
    let code = clean(text);
    let code = code.trim_end();
    if code.trim().is_empty() {
        return None;
    }
    let mut longest = 0;
    let mut run = 0;
    for c in code.chars() {
        run = if c == '`' { run + 1 } else { 0 };
        longest = longest.max(run);
    }
    let fence = "`".repeat((longest + 1).max(3));
    Some(format!("{fence}\n{code}\n{fence}"))
}

/// 备忘录的时间:@ 开头的是重复提醒
fn memo_time(s: &str) -> String {
    let s = s.trim();
    let Some(rest) = s.strip_prefix('@') else {
        return s.to_string();
    };
    let kind = match rest.chars().next() {
        Some('w' | 'W') => "每周",
        Some('m' | 'M') => "每月",
        Some('y' | 'Y') => "每年",
        _ => return format!("每天 {}", rest.trim()),
    };
    let rest = &rest[1..];
    match rest.split_once(' ') {
        Some((days, time)) => format!("{kind}({}) {}", days.trim(), time.trim()),
        None => format!("{kind}({})", rest.trim()),
    }
}

/// 一个条目的正文:几行「名称:内容」,内容可以有多行
fn item_lines(item: &Record) -> Vec<String> {
    let labeled = |label: &str, i: usize| {
        let v = item.field(i).trim();
        (!v.is_empty()).then(|| format!("{label}{v}"))
    };
    let plain = |i: usize| {
        let v = item.field(i).trim();
        (!v.is_empty()).then(|| v.to_string())
    };
    let parts = match item.kind {
        MEMO_ITEM => {
            let time = memo_time(item.field(4));
            vec![
                (!time.is_empty()).then(|| format!("时间:{time}")),
                plain(6),
                labeled("备注:", 11),
            ]
        }
        LINK_ITEM => vec![plain(5), labeled("备注:", 8)],
        CONTACT_ITEM => vec![
            labeled("手机:", 5),
            labeled("邮箱:", 6),
            labeled("即时通讯:", 7),
            labeled("即时通讯:", 8),
            labeled("公司:", 9),
            labeled("部门:", 10),
            labeled("地址:", 11),
            labeled("邮编:", 12),
            labeled("电话:", 13),
            labeled("传真:", 14),
            labeled("其他:", 15),
            labeled("备注:", 16),
        ],
        TEMPLATE_ITEM => vec![labeled("备注:", 7)],
        _ => Vec::new(),
    };
    parts.into_iter().flatten().collect()
}

/// 备忘录、链接、通讯录、文字模板整理成一页:每个条目一个小标题,下面是它的内容;
/// 分隔线条目(minipad2 里名字空着或者以 --- 开头的)写成分隔线
fn list_markdown(list: &Record, items: &[&Record]) -> String {
    let checks = list.flag(12);
    let mut blocks: Vec<String> = Vec::new();
    let mut rule = false;
    for item in items {
        let name = item.name();
        if name.is_empty() || name.starts_with("---") {
            rule = !blocks.is_empty();
            continue;
        }
        if rule {
            blocks.push("---".into());
            rule = false;
        }
        let title = if checks {
            format!("{} {name}", if item.flag(3) { "☑" } else { "☐" })
        } else {
            name
        };
        let mut block = format!("### {}", heading(&title));
        if item.kind == TEMPLATE_ITEM {
            if let Some(code) = code_block(item.field(4)) {
                block.push_str("\n\n");
                block.push_str(&code);
            }
        }
        let body = text_markdown(&clean(&item_lines(item).join("\n")), None);
        if !body.is_empty() {
            block.push_str("\n\n");
            block.push_str(&body);
        }
        blocks.push(block);
    }
    blocks.join("\n\n")
}

/// 剪贴文字:每条一个代码块
fn clips_markdown(items: &[&Record]) -> String {
    items
        .iter()
        .filter_map(|c| code_block(&c.text))
        .collect::<Vec<_>>()
        .join("\n\n")
}

// ---------- 规划:哪些页面放进哪个笔记本 ----------

struct PlanBook {
    name: String,
    pages: Vec<(String, String)>,
}

struct Planner<'a> {
    src: &'a Source,
    opts: &'a Options,
    books: Vec<PlanBook>,
    recycle: Option<usize>,
    skipped: usize,
    visited: HashSet<i64>,
    warnings: Vec<String>,
}

impl<'a> Planner<'a> {
    fn walk(&mut self, parent: i64, book: usize, path: &[String], in_bin: bool) {
        let kids = self.src.children.get(&parent).cloned().unwrap_or_default();
        for id in kids {
            self.visit(id, book, path, in_bin);
        }
    }

    fn visit(&mut self, id: i64, book: usize, path: &[String], in_bin: bool) {
        if !self.visited.insert(id) {
            return;
        }
        let src = self.src;
        let Some(r) = src.get(id) else {
            return;
        };
        match r.kind {
            GROUP if !in_bin && self.opts.layout != "single" => {
                let name = r.name();
                let mut path = path.to_vec();
                path.push(if name.is_empty() {
                    "未命名分组".into()
                } else {
                    name
                });
                let b = self.add_book(path.join(" › "));
                self.walk(id, b, &path, false);
            }
            GROUP | GROUP_ROOT | ROOT => self.walk(id, book, path, in_bin),
            RECYCLE_BIN => {
                if self.opts.recycle && !in_bin {
                    let b = match self.recycle {
                        Some(b) => b,
                        None => {
                            let b = self.add_book(format!("{} 回收站", self.books[0].name));
                            self.recycle = Some(b);
                            b
                        }
                    };
                    self.walk(id, b, &[], true);
                }
            }
            k if TEXT_PAGES.contains(&k) => {
                let text = src.page_text(r, &mut self.warnings);
                let schemes = self.opts.highlights.then_some(&src.schemes);
                let md = text_markdown(&text, schemes);
                if md.is_empty() && self.opts.skip_empty {
                    self.skipped += 1;
                } else {
                    self.books[book].pages.push((r.page_name(), md));
                }
            }
            k if LIST_PAGES.contains(&k) && self.opts.lists => {
                let items = src.list_items(r);
                let md = list_markdown(r, &items);
                if !md.is_empty() {
                    self.books[book].pages.push((r.page_name(), md));
                }
            }
            CLIP if self.opts.clips => {
                let md = clips_markdown(&src.list_items(r));
                if !md.is_empty() {
                    self.books[book].pages.push((r.page_name(), md));
                }
            }
            _ => {}
        }
    }

    fn add_book(&mut self, name: String) -> usize {
        self.books.push(PlanBook {
            name,
            pages: Vec::new(),
        });
        self.books.len() - 1
    }
}

/// 决定每个页面写成什么、放进哪个笔记本。顺序和 minipad2 树里的一样
fn plan<'a>(src: &'a Source, opts: &'a Options) -> Planner<'a> {
    let base = opts.base.trim();
    let mut p = Planner {
        src,
        opts,
        books: vec![PlanBook {
            name: if base.is_empty() { "minipad2" } else { base }.to_string(),
            pages: Vec::new(),
        }],
        recycle: None,
        skipped: 0,
        visited: HashSet::new(),
        warnings: Vec::new(),
    };
    p.walk(ROOT_ID, 0, &[], false);
    // 走不到的页面(上级不在了,或者挂在收藏夹这类页面下面)放进第一个笔记本:
    // 先放上级不存在的,这样它们下面的分组还在原来的位置
    let wanted = |r: &Record| {
        r.kind == GROUP
            || r.kind == CLIP
            || TEXT_PAGES.contains(&r.kind)
            || LIST_PAGES.contains(&r.kind)
    };
    let orphans: Vec<i64> = src
        .records
        .iter()
        .filter(|r| wanted(r) && src.get(r.owner).is_none())
        .map(|r| r.id)
        .chain(src.records.iter().filter(|r| wanted(r)).map(|r| r.id))
        .collect();
    for id in orphans {
        if !p.visited.contains(&id) && !src.in_recycle_bin(id) {
            p.visit(id, 0, &[], false);
        }
    }
    p
}

// ---------- 对外的两个入口 ----------

pub fn preview(path: &Path) -> Result<Preview, String> {
    let src = load(path)?;
    let mut warnings = src.warnings.clone();
    let mut p = Preview {
        version: src.version.clone(),
        folder: src.folder.display().to_string(),
        ..Default::default()
    };
    for r in &src.records {
        let bin = src.in_recycle_bin(r.id);
        match r.kind {
            GROUP if !bin => p.groups += 1,
            k if TEXT_PAGES.contains(&k) => {
                if bin {
                    p.recycled += 1;
                    continue;
                }
                p.pages += 1;
                let text = src.page_text(r, &mut warnings);
                if text_markdown(&text, None).is_empty() {
                    p.empty += 1;
                }
                p.highlights |= text.contains(HL_OPEN);
            }
            k if LIST_PAGES.contains(&k) && !bin => {
                if !list_markdown(r, &src.list_items(r)).is_empty() {
                    p.lists += 1;
                }
            }
            CLIP_ITEM if !bin && !clean(&r.text).trim().is_empty() => p.clips += 1,
            _ => {}
        }
    }
    p.warnings = warnings;
    Ok(p)
}

/// 同一个新笔记本里页面重名时加 (2)、(3)……
fn unique_in(taken: &mut HashSet<String>, base: &str) -> String {
    let base = notes::sanitize_name(base);
    let mut name = base.clone();
    let mut i = 2;
    while taken.contains(&name.to_lowercase()) {
        name = format!("{base} ({i})");
        i += 1;
    }
    taken.insert(name.to_lowercase());
    name
}

/// 导入到笔记文件夹 `root`:每个笔记本都是新建的,重名的自动改名
pub fn import(path: &Path, root: &Path, opts: &Options) -> Result<Imported, String> {
    let src = load(path)?;
    let plan = plan(&src, opts);
    let mut books = Vec::new();
    let mut pages = 0;
    for book in plan.books.iter().filter(|b| !b.pages.is_empty()) {
        let name = notes::unique_book_name(root, &book.name, None);
        let dir = notes::book_dir(root, &name)?;
        fs::create_dir_all(&dir).map_err(|e| format!("新建笔记本「{name}」失败:{e}"))?;
        let mut taken = HashSet::new();
        let mut order = Vec::new();
        for (page, content) in &book.pages {
            let file = unique_in(&mut taken, page);
            notes::write_atomic(&notes::note_path(&dir, &file), content)
                .map_err(|e| format!("写入「{name}」里的「{file}」失败:{e}"))?;
            order.push(file);
            pages += 1;
        }
        let meta = notes::Meta {
            active: order[0].clone(),
            order,
            ..Default::default()
        };
        notes::write_meta(&dir, &meta)?;
        books.push(name);
    }
    let mut warnings = src.warnings.clone();
    warnings.extend(plan.warnings);
    Ok(Imported {
        books,
        pages,
        skipped: plan.skipped,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 纯文字和导入后写成的 Markdown。界面测试(tests/ui.test.mjs 的 MINIPAD2_ESCAPES)用同一张表
    /// 检查编辑器打开这些 Markdown 后显示的正是原来的文字,两边改的时候要一起改
    const ESCAPES: [(&str, &str); 24] = [
        ("# 标题", "\\# 标题"),
        ("> 引用", "\\> 引用"),
        ("- 列表", "\\- 列表"),
        ("+ 加号", "\\+ 加号"),
        ("* 星号", "\\* 星号"),
        ("1. 第一", "1\\. 第一"),
        ("2) 第二", "2\\) 第二"),
        ("3.14 和 2020年", "3.14 和 2020年"),
        ("===", "\\==="),
        ("___", "\\_\\_\\_"),
        ("a*b*c", "a\\*b\\*c"),
        ("snake_case 和 _斜体_", "snake_case 和 \\_斜体\\_"),
        ("`代码` ~~删除~~", "\\`代码\\` \\~\\~删除\\~\\~"),
        ("[链接](x) ![图](y)", "\\[链接](x) !\\[图](y)"),
        ("<b>粗</b> <不是标签>", "\\<b>粗\\</b> \\<不是标签>"),
        ("a | b", "a \\| b"),
        ("&amp; & &#123;", "\\&amp; & \\&#123;"),
        ("C:\\temp\\", "C:\\temp\\\\"),
        ("\\_x", "\\\\\\_x"),
        ("    缩进四格", "&#x20;   缩进四格"),
        ("\t制表符", "&#x9;制表符"),
        ("　　全角空格", "　　全角空格"),
        (
            "看 https://a.com/x_y?q=1&r=2。好",
            "看 <https://a.com/x_y?q=1&r=2>。好",
        ),
        ("www.a.com/b_c*d 和 www.。", "www.a.com/b_c*d 和 www.。"),
    ];

    #[test]
    fn plain_text_is_escaped_for_the_editor() {
        for (plain, md) in ESCAPES {
            assert_eq!(text_markdown(plain, None), md, "{plain}");
        }
    }

    #[test]
    fn highlights_become_colors_and_blank_lines_paragraphs() {
        let text = "第一行\r\n\u{1c}红字\u{1d} 普通\r\n\r\n\r\n  \u{1c}黄底\r\n第二行\u{7f}\r\n";
        assert_eq!(
            text_markdown(text, Some(&DEFAULT_SCHEMES)),
            "第一行\n<span style=\"color: #ff3232\">红字</span> 普通\n\n<br />\n\n\
             &#x20; <span style=\"background-color: #ffff14\">黄底</span>\n\
             <span style=\"background-color: #ffff14\">第二行</span>"
        );
        // 不要颜色:只留文字
        assert_eq!(
            text_markdown(text, None),
            "第一行\n红字 普通\n\n<br />\n\n&#x20; 黄底\n第二行"
        );
        // 行首的空白不放进颜色里
        assert_eq!(
            text_markdown("\u{1c}  缩进的红字\u{1d}", Some(&DEFAULT_SCHEMES)),
            "&#x20; <span style=\"color: #ff3232\">缩进的红字</span>"
        );
        // 没配对的标记和其他控制字符丢掉
        assert_eq!(
            text_markdown("\u{1d}孤立\u{1c}没结束\u{7}", None),
            "孤立没结束"
        );
        // 开头的空行保留成空段落,只有空白的页面是空的
        assert_eq!(text_markdown("\n\n正文", None), "<br />\n\n<br />\n\n正文");
        assert_eq!(text_markdown(" \r\n\t\r\n", None), "");
    }

    #[test]
    fn memo_times_read_naturally() {
        assert_eq!(memo_time(""), "");
        assert_eq!(memo_time("2016-07-12 19:05"), "2016-07-12 19:05");
        assert_eq!(memo_time("@08:30"), "每天 08:30");
        assert_eq!(memo_time("@w1,3 09:00"), "每周(1,3) 09:00");
        assert_eq!(memo_time("@m15 10:00"), "每月(15) 10:00");
        assert_eq!(memo_time("@y"), "每年()");
    }

    // ---------- 拼一份 minipad2 的数据 ----------

    fn utf16(text: &str, fd: bool) -> Vec<u8> {
        let mut b = Vec::new();
        if fd {
            b.push(0xFD);
        }
        b.extend([0xFF, 0xFE]);
        for u in text.encode_utf16() {
            b.extend(u.to_le_bytes());
        }
        b
    }

    struct P {
        id: i64,
        owner: i64,
        kind: i32,
        fields: Vec<String>,
        text: String,
    }

    fn enc(s: &str) -> String {
        s.replace('\t', "\u{1}").replace('\n', "\u{2}")
    }

    /// 笔记这类页面:名字、状态、图标、勾选,创建/修改/访问时间,外部保存、外部文件、备注
    fn note(id: i64, owner: i64, name: &str, text: &str) -> P {
        P {
            id,
            owner,
            kind: NOTE,
            fields: [
                name,
                "0",
                "",
                "0",
                "2016-07-12 19:05:21",
                "2016-07-12 19:05:21",
                "2016-07-12 19:05:21",
                "0",
                "",
                "",
            ]
            .map(String::from)
            .to_vec(),
            text: text.into(),
        }
    }

    /// 分组这类页面:再加上列表的 6 个设置和子页面顺序
    fn container(id: i64, owner: i64, kind: i32, name: &str, children: &str) -> P {
        let mut p = note(id, owner, name, "");
        p.kind = kind;
        p.fields
            .extend(["25840,25850", "120,240", "0", "3", "1", "0", children].map(String::from));
        p
    }

    /// 备忘录、链接这类条目:名字、状态、图标、勾选,后面是各自的字段
    fn item(id: i64, owner: i64, kind: i32, name: &str, extra: &[&str]) -> P {
        let mut fields: Vec<String> = [name, "0", "", "0"].map(String::from).to_vec();
        fields.extend(extra.iter().map(|s| enc(s)));
        P {
            id,
            owner,
            kind,
            fields,
            text: String::new(),
        }
    }

    fn write_data(prog: &Path, pages: &[P], fd: bool) {
        let data = prog.join("data");
        fs::create_dir_all(&data).unwrap();
        let mut idx = String::from("3.2.0\r\n\r\n");
        for p in pages {
            idx.push_str(&format!(
                "{}\t{}\t{}\t{}\t{}\r\n",
                p.id,
                p.owner,
                p.kind,
                p.text.encode_utf16().count(),
                p.fields.join("\t")
            ));
        }
        let mut sorted: Vec<&P> = pages.iter().collect();
        sorted.sort_by_key(|p| p.id);
        let dat: String = sorted.iter().map(|p| p.text.as_str()).collect();
        fs::write(data.join("minipad2.idx"), utf16(&idx, fd)).unwrap();
        fs::write(data.join("minipad2.dat"), utf16(&dat, fd)).unwrap();
    }

    /// 一份典型的数据:分组套分组、没名字的笔记、空白笔记、回收站、备忘录、快速链接、文字模板、剪贴文字、
    /// 上级不在了的笔记、外部保存的笔记,还有两个同名笔记
    fn sample(prog: &Path, fd: bool) {
        let mut ext = note(60, 7, "外部", "旧的");
        ext.fields[7] = "1".into();
        ext.fields[8] = "外部.txt".into();
        fs::create_dir_all(prog).unwrap();
        fs::write(prog.join("外部.txt"), "外部文件的内容\r\n第二行").unwrap();
        let pages = vec![
            container(ROOT_ID, -2, ROOT, "", "7,8,10"),
            container(7, ROOT_ID, GROUP_ROOT, "全部", "9,20,30"),
            note(9, 7, "便签", "你好\r\n世界"),
            container(20, 7, GROUP, "工作", "22,21"),
            note(21, 20, "周报", "本周\u{1c}完成\u{1d}了"),
            note(22, 20, "", "无名"),
            container(23, 20, GROUP, "项目", ""),
            note(24, 23, "计划", "1. 第一步"),
            container(25, 20, MEMO, "提醒", ""),
            item(
                26,
                25,
                MEMO_ITEM,
                "开会",
                &[
                    "@w1,3 09:00",
                    "0",
                    "带上电脑",
                    "0",
                    "",
                    "0",
                    "0",
                    "会议室 A",
                ],
            ),
            container(30, 7, GROUP, "空分组", ""),
            note(31, 30, "空", "  \r\n"),
            container(8, ROOT_ID, RECYCLE_BIN, "回收站", ""),
            note(40, 8, "旧笔记", "删掉的"),
            container(10, ROOT_ID, FAST_LINK, "快速链接", ""),
            item(
                11,
                10,
                LINK_ITEM,
                "官网",
                &["2", "https://minipad.example/", "0", "", "常用"],
            ),
            container(12, ROOT_ID, TEMPLATE, "文字模板", ""),
            item(
                13,
                12,
                TEMPLATE_ITEM,
                "签名",
                &["张三\n电话:123", "0", "", ""],
            ),
            container(14, ROOT_ID, CLIP, "剪贴文字", ""),
            {
                let mut c = item(15, 14, CLIP_ITEM, "剪1", &[]);
                c.text = "复制的文字".into();
                c
            },
            note(50, 99, "孤儿", "没有上级"),
            ext,
            note(61, 7, "便签", "第二个"),
        ];
        write_data(prog, &pages, fd);
    }

    fn summary(p: &Planner) -> Vec<(String, Vec<(String, String)>)> {
        p.books
            .iter()
            .map(|b| (b.name.clone(), b.pages.clone()))
            .collect()
    }

    fn pages(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter()
            .map(|(n, c)| (n.to_string(), c.to_string()))
            .collect()
    }

    #[test]
    fn groups_become_notebooks_in_minipad2_order() {
        let prog = notes::temp_dir("mp2-plan");
        sample(&prog, false);
        let src = load(&prog).unwrap();
        assert_eq!(src.version, "3.2.0");
        assert!(src.warnings.is_empty(), "{:?}", src.warnings);
        let opts = Options::default();
        let p = plan(&src, &opts);
        assert_eq!(
            summary(&p),
            vec![
                (
                    "minipad2".into(),
                    pages(&[
                        ("便签", "你好\n世界"),
                        ("外部", "外部文件的内容\n第二行"),
                        ("便签", "第二个"),
                        (
                            "快速链接",
                            "### 官网\n\n<https://minipad.example/>\n备注:常用"
                        ),
                        ("文字模板", "### 签名\n\n```\n张三\n电话:123\n```"),
                        ("孤儿", "没有上级"),
                    ])
                ),
                (
                    "工作".into(),
                    pages(&[
                        ("未命名", "无名"),
                        ("周报", "本周<span style=\"color: #ff3232\">完成</span>了"),
                        (
                            "提醒",
                            "### 开会\n\n时间:每周(1,3) 09:00\n带上电脑\n备注:会议室 A"
                        ),
                    ])
                ),
                ("工作 › 项目".into(), pages(&[("计划", "1\\. 第一步")])),
                ("空分组".into(), Vec::new()),
            ]
        );
        assert_eq!(p.skipped, 1);
        let _ = fs::remove_dir_all(&prog);
    }

    #[test]
    fn options_change_what_is_imported() {
        let prog = notes::temp_dir("mp2-options");
        sample(&prog, true);
        let src = load(&prog.join("data")).unwrap();
        let opts = Options {
            layout: "single".into(),
            base: "  旧笔记  ".into(),
            skip_empty: false,
            lists: false,
            clips: true,
            recycle: true,
            highlights: false,
        };
        let p = plan(&src, &opts);
        let names: Vec<(String, Vec<String>)> = p
            .books
            .iter()
            .map(|b| {
                (
                    b.name.clone(),
                    b.pages.iter().map(|(n, _)| n.clone()).collect(),
                )
            })
            .collect();
        assert_eq!(
            names,
            vec![
                (
                    "旧笔记".to_string(),
                    [
                        "便签",
                        "未命名",
                        "周报",
                        "计划",
                        "空",
                        "外部",
                        "便签",
                        "剪贴文字",
                        "孤儿"
                    ]
                    .map(String::from)
                    .to_vec()
                ),
                ("旧笔记 回收站".to_string(), vec!["旧笔记".to_string()]),
            ]
        );
        let content = |name: &str| {
            p.books[0]
                .pages
                .iter()
                .find(|(n, _)| n == name)
                .unwrap()
                .1
                .clone()
        };
        assert_eq!(content("周报"), "本周完成了");
        assert_eq!(content("空"), "");
        assert_eq!(content("剪贴文字"), "```\n复制的文字\n```");
        assert_eq!(p.skipped, 0);
        let _ = fs::remove_dir_all(&prog);
    }

    #[test]
    fn preview_counts_what_is_there() {
        let prog = notes::temp_dir("mp2-preview");
        sample(&prog, false);
        let p = preview(&prog.join("data").join("minipad2.idx")).unwrap();
        assert_eq!(p.version, "3.2.0");
        assert_eq!(
            (
                p.groups,
                p.pages,
                p.empty,
                p.lists,
                p.clips,
                p.recycled,
                p.highlights
            ),
            (3, 8, 1, 3, 1, 1, true)
        );
        let _ = fs::remove_dir_all(&prog);
    }

    #[test]
    fn import_writes_new_notebooks_next_to_existing_ones() {
        let prog = notes::temp_dir("mp2-src");
        sample(&prog, false);
        let root = notes::temp_dir("mp2-root");
        fs::create_dir_all(root.join("工作")).unwrap();
        fs::write(root.join("工作").join("周报.md"), "原来的").unwrap();
        let done = import(&prog, &root, &Options::default()).unwrap();
        assert_eq!(done.books, ["minipad2", "工作 (2)", "工作 › 项目"]);
        assert_eq!((done.pages, done.skipped), (10, 1));
        // 已有的笔记本没动
        assert_eq!(
            fs::read_to_string(root.join("工作").join("周报.md")).unwrap(),
            "原来的"
        );
        let book = notes::load_book(&root, "minipad2").unwrap();
        let names: Vec<&str> = book.notes.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(
            names,
            ["便签", "外部", "便签 (2)", "快速链接", "文字模板", "孤儿"]
        );
        assert_eq!(book.active, "便签");
        assert_eq!(
            notes::read_note(&root.join("工作 (2)"), "周报").unwrap(),
            "本周<span style=\"color: #ff3232\">完成</span>了"
        );
        let _ = fs::remove_dir_all(&prog);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn finds_the_data_and_rejects_other_versions() {
        let prog = notes::temp_dir("mp2-locate");
        let err = preview(&prog).unwrap_err();
        assert!(err.contains("没有找到 minipad2 的数据"), "{err}");
        sample(&prog, false);
        for path in [
            prog.clone(),
            prog.join("data"),
            prog.join("data").join("minipad2.idx"),
        ] {
            assert_eq!(preview(&path).unwrap().pages, 8, "{}", path.display());
        }
        let idx = prog.join("data").join("minipad2.idx");
        fs::write(&idx, utf16("3.1.0\r\n\r\n", false)).unwrap();
        let err = preview(&prog).unwrap_err();
        assert!(
            err.contains("minipad2 3.1.0") && err.contains("3.2"),
            "{err}"
        );
        fs::write(&idx, "随便什么文字").unwrap();
        let err = preview(&prog).unwrap_err();
        assert!(err.contains("不是 minipad2 的数据文件"), "{err}");
        let _ = fs::remove_dir_all(&prog);
    }

    #[test]
    fn broken_data_still_imports_with_warnings() {
        let prog = notes::temp_dir("mp2-broken");
        write_data(
            &prog,
            &[
                container(7, ROOT_ID, GROUP_ROOT, "全部", "9"),
                note(9, 7, "长", "一二三四五"),
                note(10, 7, "后面", "六七"),
            ],
            false,
        );
        // 目录里多一行看不懂的,文字文件被截短
        let idx = prog.join("data").join("minipad2.idx");
        let mut text = String::from_utf16_lossy(&utf16_units(&fs::read(&idx).unwrap()));
        text.push_str("坏掉的一行\r\n");
        fs::write(&idx, utf16(&text, false)).unwrap();
        fs::write(
            prog.join("data").join("minipad2.dat"),
            utf16("一二三四五六", false),
        )
        .unwrap();
        let src = load(&prog).unwrap();
        assert_eq!(src.warnings.len(), 2, "{:?}", src.warnings);
        let opts = Options::default();
        let p = plan(&src, &opts);
        assert_eq!(
            summary(&p),
            vec![(
                "minipad2".into(),
                pages(&[("长", "一二三四五"), ("后面", "六")])
            )]
        );
        let _ = fs::remove_dir_all(&prog);
    }

    #[test]
    fn highlight_colors_come_from_the_ini() {
        let prog = notes::temp_dir("mp2-ini");
        fs::write(
            prog.join("minipad2.ini"),
            "[Program]\r\nHLColor1=1\r\n[Editor]\r\nHLColor1=16711680\r\nHLUnderline1=0\r\nHLColor3=-16777201\r\nHLUnderline4=1\r\n",
        )
        .unwrap();
        let s = read_schemes(&prog.join("minipad2.ini"));
        assert_eq!(
            s[0],
            Scheme {
                rgb: 0x0000ff,
                underline: false
            }
        );
        assert_eq!(s[1], DEFAULT_SCHEMES[1]);
        assert_eq!(s[2], DEFAULT_SCHEMES[2]);
        assert_eq!(
            s[3],
            Scheme {
                rgb: 0xffff14,
                underline: true
            }
        );
        assert_eq!(s[0].css(), "background-color: #0000ff");
        assert_eq!(s[3].css(), "color: #ffff14");
        let _ = fs::remove_dir_all(&prog);
    }
}
