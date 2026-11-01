// ---------- 快捷键(0.5.5):每个命令的按键都能在 设置 → 快捷键 里改 ----------
// 按键写成 "Ctrl+Shift+P" 这样:修饰键 + 键的位置(e.code,字母和数字去掉 Key、Digit),和键盘布局、输入法无关。
// 应用内的命令改过的才存进设置的 shortcuts({ 命令: [按键…] },空数组就是不用),没改过的跟着这里的默认值;
// 快速切换页面、呼出热键和快速记录的热键还存在原来的设置里(quick_switch_key、hotkey、capture_hotkey),老设置文件照常能读

// 按下的组合键写成 "Ctrl+Shift+P";只按了修饰键,或者没按修饰键的普通键(F1~F24 除外)是 null
export function comboOf(e) {
  const mods = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  const c = e.code || "";
  if (/^(Control|Alt|Shift|Meta|OS)/.test(c)) return null;
  let key;
  if (/^Key[A-Z]$/.test(c)) key = c.slice(3);
  else if (/^Digit\d$/.test(c)) key = c.slice(5);
  else key = c;
  if (!mods.length && !/^F\d{1,2}$/.test(key)) return null;
  return [...mods, key].join("+");
}

// 能当快捷键的:带 Ctrl、Alt 或 Win 键,或者是 F1~F24(只带 Shift 的普通键会挡住打大写字母)
export const usable = (combo) => /(^|\+)(Ctrl|Alt|Super)\+/.test(combo) || /(^|\+)F\d{1,2}$/.test(combo);

export const same = (a, b) => a.toLowerCase() === b.toLowerCase();

// 应用内的命令(主窗口;小窗里只有查找、保存、字号和 F3、F5 这几个)
export const COMMANDS = [
  { id: "books", name: "打开 / 收起笔记本列表", keys: ["Ctrl+B"] },
  { id: "new_page", name: "新建页面", keys: ["Ctrl+T", "Ctrl+N"] },
  { id: "new_from_template", name: "选模板新建页面", keys: ["Ctrl+Shift+N"] },
  { id: "quick_switch", name: "快速切换页面", field: "quick_switch_key" },
  // Ctrl+F 是在这一页里找还是搜全部页面,看 设置 → 编辑 → 查找替换 里选的
  { id: "find", name: "在当前页面里查找", keys: (s) => [s.ctrl_f === "all" ? "Ctrl+Shift+F" : "Ctrl+F"] },
  { id: "search", name: "搜索全部页面", keys: (s) => [s.ctrl_f === "all" ? "Ctrl+F" : "Ctrl+Shift+F"] },
  { id: "replace", name: "查找和替换", keys: ["Ctrl+H"] },
  { id: "find_next", name: "找下一个", keys: ["F3"] },
  { id: "find_prev", name: "找上一个", keys: ["Shift+F3"] },
  { id: "next_page", name: "下一个页面", keys: ["Ctrl+Tab"] },
  { id: "prev_page", name: "上一个页面", keys: ["Ctrl+Shift+Tab"] },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ id: `page_${n}`, name: `跳到第 ${n} 个页面`, keys: [`Ctrl+${n}`] })),
  { id: "last_page", name: "跳到最后一个页面", keys: ["Ctrl+9"] },
  { id: "delete_page", name: "删除当前页面", keys: ["Ctrl+W"] },
  { id: "save", name: "马上保存", keys: ["Ctrl+S"] },
  { id: "insert_date", name: "插入当前日期时间", keys: ["F5"] },
  { id: "font_bigger", name: "字号调大", keys: ["Ctrl+Equal", "Ctrl+Shift+Equal", "Ctrl+NumpadAdd"] },
  { id: "font_smaller", name: "字号调小", keys: ["Ctrl+Minus", "Ctrl+NumpadSubtract"] },
  { id: "fullscreen", name: "全屏编辑", keys: ["F11"] },
];

// 全局热键:在别的程序里也能按,由后端注册
export const GLOBAL_COMMANDS = [
  { id: "hotkey", name: "呼出 / 隐藏主窗口", field: "hotkey", global: true, required: true },
  { id: "capture", name: "快速记录", field: "capture_hotkey", global: true },
];

const FIELD_DEFAULTS = { quick_switch_key: "Ctrl+P", hotkey: "Ctrl+M", capture_hotkey: "Ctrl+Alt+M" };

// 编辑区自己的按键(Milkdown 和 editor.js 里的,不能改):录到这些时提醒一下
export const EDITOR_KEYS = [
  { name: "撤销", keys: ["Ctrl+Z"] },
  { name: "重做", keys: ["Ctrl+Y", "Ctrl+Shift+Z"] },
  { name: "粗体(选中文字时)", keys: ["Ctrl+B"], warn: "编辑区里选中文字时 Ctrl+B 是粗体,没选中时才是这个命令" },
  { name: "斜体", keys: ["Ctrl+I"] },
  { name: "行内代码", keys: ["Ctrl+E"] },
  { name: "删除线", keys: ["Ctrl+Alt+X"] },
  { name: "引用", keys: ["Ctrl+Shift+B"] },
  { name: "代码块", keys: ["Ctrl+Alt+C"] },
  { name: "标题 1~6", keys: [1, 2, 3, 4, 5, 6].map((n) => `Ctrl+Alt+${n}`), label: "Ctrl+Alt+1 ~ 6" },
  { name: "正文(在代码块里:变回正文)", keys: ["Ctrl+Alt+0"] },
  { name: "编号列表", keys: ["Ctrl+Alt+7"] },
  { name: "项目列表", keys: ["Ctrl+Alt+8"] },
  { name: "列表项缩进 / 取消缩进", keys: ["Ctrl+BracketRight", "Ctrl+BracketLeft"] },
  { name: "勾选待办 / 跳出代码块", keys: ["Ctrl+Enter"] },
  { name: "全选(在代码块里先选这个代码块)", keys: ["Ctrl+A"] },
  { name: "复制 / 剪切 / 粘贴", keys: ["Ctrl+C", "Ctrl+X", "Ctrl+V"] },
];

const ALL = [...COMMANDS, ...GLOBAL_COMMANDS];
export const commandById = (id) => ALL.find((c) => c.id === id) || null;

export function defaultKeys(s, id) {
  const c = commandById(id);
  if (c.field) return [FIELD_DEFAULTS[c.field]];
  return typeof c.keys === "function" ? c.keys(s) : c.keys;
}

// 现在的按键:s 是设置(或者设置里正在改的那一份)
export function keysOf(s, id) {
  const c = commandById(id);
  if (c.field) return s[c.field] ? [s[c.field]] : [];
  const own = s.shortcuts?.[id];
  return Array.isArray(own) ? own : defaultKeys(s, id);
}

export const sameKeys = (a, b) => a.length === b.length && a.every((k, i) => same(k, b[i]));

// 换上新的按键;和默认的一样就不存,以后默认值变了也跟着变
export function withKeys(s, id, keys) {
  const c = commandById(id);
  if (c.field) return { ...s, [c.field]: keys[0] || "" };
  const shortcuts = { ...s.shortcuts };
  if (sameKeys(keys, defaultKeys(s, id))) delete shortcuts[id];
  else shortcuts[id] = keys;
  return { ...s, shortcuts };
}

// 按下的键对应的应用内命令,没有就是 null
export function commandOf(e, s) {
  const combo = comboOf(e);
  if (!combo || !s) return null;
  // 小键盘上的数字(NumLock 开着时)也当作上面一排的数字
  const alt = /^Numpad\d$/.test(e.code) && /^\d$/.test(e.key) ? combo.replace(/Numpad(\d)$/, "$1") : null;
  return COMMANDS.find((c) => keysOf(s, c.id).some((k) => same(k, combo) || (alt && same(k, alt))))?.id ?? null;
}

// 别的命令里已经用了这个按键的那个命令
export function holderOf(s, combo, except) {
  return ALL.find((c) => c.id !== except && keysOf(s, c.id).some((k) => same(k, combo))) || null;
}

const RESERVED = ["Alt+Tab", "Alt+Shift+Tab", "Ctrl+Alt+Tab", "Alt+F4", "Alt+Escape", "Ctrl+Escape", "Ctrl+Shift+Escape", "Ctrl+Alt+Delete", "Alt+Space"];
const IME = { "Ctrl+Space": "切换中英文", "Ctrl+Period": "切换中英文标点", "Ctrl+Shift+F": "切换简体和繁体(微软拼音)" };

// 容易出问题的组合:Windows 保留的、中文输入法占用的、等于 AltGr 的,还有编辑区自己的按键
export function warningsOf(combo) {
  const out = [];
  if (/(^|\+)Super\+/.test(combo)) out.push("带 Win 键的组合大多被 Windows 占用,按了可能没反应");
  else if (RESERVED.some((k) => same(k, combo))) out.push("这是 Windows 保留的组合键,按了会是系统的功能");
  const ime = Object.keys(IME).find((k) => same(k, combo));
  if (ime) out.push(`中文输入法常用它${IME[ime]},打字时按可能被输入法拿走`);
  if (/^Ctrl\+Alt\+(Shift\+)?[A-Z0-9]$/.test(combo)) out.push("德语、波兰语等键盘布局里 Ctrl+Alt 等于 AltGr,用来打特殊字符,按这个组合时可能打出字来");
  const editor = EDITOR_KEYS.find((x) => x.keys.some((k) => same(k, combo)));
  if (editor) out.push(editor.warn || `编辑区里 ${keyLabel(combo)} 是「${editor.name}」,在编辑区里按时还是${editor.name}`);
  return out;
}

const NAMES = {
  Equal: "=", Minus: "-", NumpadAdd: "小键盘+", NumpadSubtract: "小键盘-", NumpadMultiply: "小键盘*", NumpadDivide: "小键盘/",
  NumpadDecimal: "小键盘.", NumpadEnter: "小键盘回车", Escape: "Esc", Space: "空格", Enter: "回车", Backquote: "`",
  BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", PageUp: "PgUp", PageDown: "PgDn", Delete: "Del", Insert: "Ins", Super: "Win",
};
// 给人看的写法:Ctrl+Equal 写成 Ctrl+=
export const keyLabel = (combo) => (combo ? combo.split("+").map((k) => NAMES[k] || k.replace(/^Numpad(\d)$/, "小键盘$1")).join("+") : "");

// ---- 导出、导入(JSON) ----

export function exportKeys(s) {
  const keys = Object.fromEntries(ALL.map((c) => [c.id, keysOf(s, c.id)]));
  return JSON.stringify({ minipad_shortcuts: 1, keys }, null, 2) + "\n";
}

// 读导入的文件,算出导入后的样子:{ next, changes: [{ name, from, to }], skipped, duplicates },读不了时 { error }
export function importKeys(s, text) {
  let keys;
  try {
    keys = JSON.parse(text)?.keys;
  } catch {
    return { error: "这个文件不是 JSON" };
  }
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) return { error: "这个文件里没有快捷键(要用这里「导出」的文件)" };
  let next = s;
  let skipped = 0;
  const changes = [];
  for (const [id, value] of Object.entries(keys)) {
    const c = commandById(id);
    const list = (Array.isArray(value) ? value : [value]).filter((k) => typeof k === "string").map((k) => k.trim());
    const ok = list.filter((k, i) => k.length <= 40 && usable(k) && list.findIndex((x) => same(x, k)) === i).slice(0, c?.field ? 1 : 4);
    if (!c || ok.length !== list.length || (c.required && !ok.length)) {
      skipped++;
      continue;
    }
    const from = keysOf(next, id);
    if (sameKeys(from, ok)) continue;
    next = withKeys(next, id, ok);
    changes.push({ name: c.name, from, to: ok });
  }
  // 导入以后有两个命令用同一个按键
  const seen = new Map();
  for (const c of ALL) {
    for (const k of keysOf(next, c.id)) {
      const hit = seen.get(k.toLowerCase()) || { key: k, names: [] };
      hit.names.push(c.name);
      seen.set(k.toLowerCase(), hit);
    }
  }
  const duplicates = [...seen.values()].filter((x) => x.names.length > 1).map((x) => `${keyLabel(x.key)}(${x.names.join("、")})`);
  return { next, changes, skipped, duplicates };
}
