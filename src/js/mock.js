// ---------- 浏览器预览用的模拟后端 ----------
// 数据存在 localStorage 里,命令和真正的后端一一对应
import { toast } from "./ui.js";
import { DEFAULT_DATE_FORMAT } from "./datetime.js";
import { parseAccent, tidyAccent } from "./accent.js";

const KEY = "minipad-next-demo";
const WELCOME =
  "# 欢迎使用 Minipad Next\n\n这是浏览器里的界面预览,真正的程序在 Windows 上运行。选中文字试试上面出来的按钮。\n\n- [ ] 点方框勾选任务\n- [x] 已经做完的事\n\n```js 试试复制\nconsole.log('点右上角的复制按钮试试');\n```\n";
const DEFAULT_SETTINGS = {
  hotkey: "Ctrl+M",
  always_on_top: true,
  edge_hide: true,
  edge_style: "arrow",
  edge_line_width: 2,
  edge_line_length: 100,
  edge_line_glow: false,
  edge_color: "",
  ball_enabled: false,
  ball_size: 48,
  ball_icon: "app",
  ball_color: "",
  ball_opacity: 100,
  ball_open: "click",
  ball_pos: null,
  show_in_taskbar: false,
  autostart: false,
  theme: "system",
  font_size: 14,
  notes_dir: "",
  line_numbers: false,
  date_format: DEFAULT_DATE_FORMAT,
  code_line_numbers: true,
  format_bar: true,
  format_bar_hidden: [],
  format_bar_order: [],
  tab_style: "line",
  accent: "",
  book_color_presets: [],
  backup_enabled: true,
  backup_keep: 14,
  backup_dir: "",
  ctrl_f: "page",
  find_bar_pos: "top",
  find_color: "",
  conflict_mode: "copy",
  settings_nav: "left",
  outline_enabled: false,
  outline_mode: "hover",
  outline_side: "right",
  outline_depth: 3,
  outline_width: 200,
  outline_opacity: 100,
  outline_color: "",
  tab_overflow: "scroll",
  tab_fade: true,
  tab_list_button: true,
  tab_rows: 4,
  tab_drawer_side: "left",
  tab_drawer_width: 200,
  tab_drawer_hover: false,
  tab_drawer_pinned: false,
  tab_groups: false,
  tab_group_style: "line",
  sel_bar: "always",
  sel_bar_items: ["block", "strong", "em", "strike", "code", "link", "sep3", "color", "bg"],
  sel_bar_pos: "above",
};

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const emptyMeta = () => ({ order: [], active: "", modes: {} });

// 测试会直接往 __mockBooks 里放笔记本,缺的字段补上
function fixBook(b) {
  b.files ||= {};
  b.meta ||= emptyMeta();
  b.meta.order ||= [];
  b.meta.modes ||= {};
  return b;
}

function load() {
  let db = null;
  try {
    db = JSON.parse(localStorage.getItem(KEY));
  } catch (_) {}
  if (!db || typeof db !== "object") db = {};
  // 0.2.0 的数据只有一个笔记本:{ settings, files, meta }
  if (!db.books) db.books = { "": { files: db.files, meta: db.meta } };
  delete db.files;
  delete db.meta;
  // 旧数据里没有的新设置用默认值
  db.settings = { ...DEFAULT_SETTINGS, ...db.settings };
  if (!has(db.books, "")) db.books[""] = {};
  for (const b of Object.values(db.books)) fixBook(b);
  if (typeof db.book !== "string") db.book = "";
  if (!Array.isArray(db.backups)) db.backups = [];
  return db;
}

// 把名字变成合法的 Windows 文件名,清理完是空的就用 fallback
function clean(name, fallback) {
  let s = String(name).replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g, "_");
  s = s.trim().replace(/[. ]+$/, "");
  if (s.startsWith(".")) s = "_" + s.slice(1);
  s = [...s].slice(0, 80).join("");
  if (!s) s = fallback;
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s += "_";
  return s;
}

// base 没被占用就用它,否则依次试 "base (2)"、"base (3)"……
function firstFree(base, taken) {
  if (!taken(base)) return base;
  for (let i = 2; ; i++) if (!taken(`${base} (${i})`)) return `${base} (${i})`;
}

// 统一成小写、反斜杠,用来比较路径
const normPath = (p) => p.toLowerCase().replace(/\//g, "\\").replace(/\\+$/, "");

// 只能是几个选项之一的设置:不认识的值换成第一个(和后端的 pick_one 一样)
const pickOne = (value, options) => (options.includes(value) ? value : options[0]);

// 冲突副本的名字,比如「周报 (冲突 2026-10-12 18.30)」;和后端的 notes::conflict_name 一样
function conflictName(name) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const suffix = ` (冲突 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())})`;
  return [...name].slice(0, 80 - [...suffix].length).join("").trimEnd() + suffix;
}

// 和后端一样整理 F5 的日期格式:去掉首尾空格,最多 64 个字(按字算),空着就用默认的
const tidyDateFormat = (f) => [...String(f ?? "").trim()].slice(0, 64).join("").trimEnd() || DEFAULT_DATE_FORMAT;

export function mockApi() {
  const db = load();
  const persist = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(db));
    } catch (_) {}
  };

  // 模拟每日自动备份:今天第一次改笔记时记一份,只留最近几份
  const backup = () => {
    if (!db.settings.backup_enabled) return;
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (db.backups.includes(today)) return;
    db.backups = [...db.backups, today].sort().slice(-Math.max(1, db.settings.backup_keep));
  };

  // 笔记本文件夹不在了就重新建出来(和真的写文件一样)
  const bookOf = (name) => (has(db.books, name) ? fixBook(db.books[name]) : (db.books[name] = fixBook({})));
  const bookNames = () => Object.keys(db.books).filter((n) => n && !n.startsWith(".")).sort();

  // Windows 文件名不区分大小写,这里也按不区分处理;except 是改名时的原名
  const uniqPage = (b, base, except) => {
    const names = Object.keys(b.files).map((n) => n.toLowerCase());
    const ex = except?.toLowerCase();
    return firstFree(clean(base, "新页面"), (n) => n.toLowerCase() !== ex && names.includes(n.toLowerCase()));
  };
  // 「默认」留给根目录
  const uniqBook = (base, except) => {
    const names = bookNames().map((n) => n.toLowerCase());
    const ex = except?.toLowerCase();
    return firstFree(clean(base, "新笔记本"), (n) => {
      n = n.toLowerCase();
      return n === "默认" || (n !== ex && names.includes(n));
    });
  };

  // 按保存过的顺序读出一个笔记本,新出现的页面排在后面
  const readBook = (name) => {
    const { files, meta } = fixBook(db.books[name]);
    const names = Object.keys(files).sort();
    const order = meta.order.filter((n) => names.includes(n)).concat(names.filter((n) => !meta.order.includes(n)));
    return {
      name,
      notes: order.map((n) => {
        const reason = window.__mockControl?.unreadable?.[name]?.[n] || null;
        const g = meta.note_groups?.[n];
        const group = g && (meta.groups || []).some((x) => x.id === g) ? g : "";
        return { name: n, content: reason ? "" : files[n], mode: meta.modes[n] || "edit", unreadable: !!reason, reason, group };
      }),
      active: order.includes(meta.active) ? meta.active : (order[0] ?? ""),
      groups: (meta.groups || []).filter((x) => order.some((n) => meta.note_groups?.[n] === x.id)),
      icon: meta.icon || "",
      icon_color: meta.icon_color || "",
    };
  };
  const readBooks = () => ["", ...bookNames()].filter((name) => !window.__mockControl?.unreadableBook?.includes(name)).map(readBook);

  const cmds = {
    load_state: () => {
      // 第一次用(既没有页面也没有笔记本)时放一页说明
      const root = bookOf("");
      if (!Object.keys(root.files).length && !bookNames().length) {
        root.files["欢迎"] = WELCOME;
        root.meta = { order: ["欢迎"], active: "欢迎", modes: {} };
      }
      return {
        settings: db.settings,
        notes_dir: "(浏览器预览)",
        books: readBooks(),
        book: bookNames().includes(db.book) ? db.book : "",
        hotkey_error: null,
        settings_error: null,
        version: "预览",
        debug: true,
      };
    },
    read_notes: () => readBooks(),
    book_exists: ({ book }) => has(db.books, book),
    // 和后端一样:文件在别处被改过(既不是上次读到的 expected,也不是要写的内容),
    // 先把别处的版本另存成冲突副本(设置里选了直接覆盖就不留)
    save_note: ({ book, name, content, expected }) => {
      backup();
      const b = bookOf(book);
      const now = has(b.files, name) ? b.files[name] : null;
      let conflict = null;
      if (db.settings.conflict_mode !== "overwrite" && expected != null && now != null && now !== expected && now !== content) {
        const copy = uniqPage(b, conflictName(name));
        b.files[copy] = now;
        conflict = { name: copy, content: now };
      }
      b.files[name] = content;
      return { conflict };
    },
    create_note: ({ book, name }) => {
      backup();
      const b = bookOf(book);
      const n = uniqPage(b, name);
      b.files[n] = "";
      return n;
    },
    rename_note: ({ book, old, new: nw }) => {
      const b = has(db.books, book) ? fixBook(db.books[book]) : fixBook({});
      const n = uniqPage(b, nw, old);
      if (n === old) return n;
      if (!has(b.files, old)) throw `找不到页面「${old}」`;
      backup();
      const content = b.files[old];
      delete b.files[old];
      b.files[n] = content;
      return n;
    },
    delete_note: ({ book, name }) => {
      backup();
      if (has(db.books, book)) delete db.books[book].files[name];
    },
    move_note: ({ book, name, target }) => {
      backup();
      if (book === target) return name;
      if (!has(db.books, book) || !has(db.books[book].files, name)) throw `找不到页面「${name}」`;
      const src = db.books[book];
      const dst = bookOf(target);
      const n = uniqPage(dst, name);
      dst.files[n] = src.files[name];
      delete src.files[name];
      return n;
    },
    // 笔记本已经不在了就不写,免得把删掉的笔记本又建出来
    // 带了 groups 才改分组(和 Rust 一样只记还有页面的分组)
    save_meta: ({ book, order, active, modes, groups, note_groups }) => {
      if (!has(db.books, book)) return;
      const old = db.books[book].meta || {};
      const meta = { ...old, order, active, modes, groups: old.groups || [], note_groups: old.note_groups || {} };
      if (groups) {
        const ng = Object.fromEntries(
          Object.entries(note_groups || {}).filter(([n, id]) => id && order.includes(n) && groups.some((g) => g.id === id)),
        );
        meta.groups = groups.filter((g) => g.id && Object.values(ng).includes(g.id));
        meta.note_groups = ng;
      }
      db.books[book].meta = meta;
    },
    create_book: ({ name }) => {
      backup();
      const n = uniqBook(name);
      db.books[n] = fixBook({});
      return n;
    },
    rename_book: ({ old, new: nw }) => {
      backup();
      if (!old) throw "「默认」笔记本不能改名";
      if (!has(db.books, old)) throw `找不到笔记本「${old}」`;
      const n = uniqBook(nw, old);
      if (n !== old) {
        const b = db.books[old];
        delete db.books[old];
        db.books[n] = b;
        if (db.book === old) db.book = n;
      }
      return n;
    },
    set_book_appearance: ({ book, icon, color }) => {
      if (!["book", "folder", "briefcase", "heart", "star", "lightbulb", "code", "bookmark"].includes(icon)) throw "不支持的笔记本图标";
      if (color && !parseAccent(color)) throw "图标颜色格式无效";
      if (!has(db.books, book)) throw "笔记本不存在";
      const meta = bookOf(book).meta;
      meta.icon = icon === "book" ? "" : icon;
      meta.icon_color = tidyAccent(color);
    },
    delete_book: ({ name }) => {
      backup();
      if (!name) throw "「默认」笔记本不能删除";
      if (!has(db.books, name)) return;
      delete db.books[name];
      if (db.book === name) db.book = "";
    },
    set_current_book: ({ book }) => void (db.book = book),
    backup_info: () => ({ dir: "(浏览器预览)", latest: db.backups.at(-1) ?? null, count: db.backups.length }),
    open_backup_dir: () => toast("(预览)会在资源管理器里打开备份文件夹"),
    save_settings: ({ settings, migrateNotes }) => {
      if (migrateNotes && window.__mockControl?.migrationError) throw new Error(window.__mockControl.migrationError);
      if (migrateNotes && window.__mockControl) window.__mockControl.migrationRequested = true;
      const s = {
        ...settings,
        hotkey: String(settings.hotkey ?? "").trim(),
        notes_dir: String(settings.notes_dir ?? "").trim(),
        backup_dir: String(settings.backup_dir ?? "").trim(),
        backup_keep: Math.min(365, Math.max(1, Math.round(Number(settings.backup_keep)) || 1)),
        date_format: tidyDateFormat(settings.date_format),
        ctrl_f: pickOne(settings.ctrl_f, ["page", "all"]),
        find_bar_pos: pickOne(settings.find_bar_pos, ["top", "bottom"]),
        conflict_mode: pickOne(settings.conflict_mode, ["copy", "overwrite"]),
        settings_nav: pickOne(settings.settings_nav, ["left", "top"]),
        book_color_presets: Array.isArray(settings.book_color_presets)
          ? [...new Set(settings.book_color_presets
              .filter((v) => typeof v === "string" && (/^#[0-9a-f]{6}$/i.test(v) || /^linear-gradient\(\d{1,3}deg,\s*#[0-9a-f]{6}(?:,\s*#[0-9a-f]{6}){1,6}\)$/i.test(v)))
              .map((v) => v.toLowerCase()))].slice(0, 20)
          : [],
        outline_mode: pickOne(settings.outline_mode, ["hover", "pinned"]),
        outline_side: pickOne(settings.outline_side, ["right", "left"]),
        outline_depth: Math.min(6, Math.max(1, Math.round(Number(settings.outline_depth)) || 3)),
        outline_width: Math.min(360, Math.max(140, Math.round(Number(settings.outline_width)) || 200)),
        outline_opacity: Math.min(100, Math.max(40, Math.round(Number(settings.outline_opacity)) || 100)),
        tab_overflow: pickOne(settings.tab_overflow, ["scroll", "wrap", "drawer"]),
        tab_drawer_side: pickOne(settings.tab_drawer_side, ["left", "right"]),
        tab_group_style: pickOne(settings.tab_group_style, ["line", "tint"]),
        sel_bar: pickOne(settings.sel_bar, ["always", "nobar", "off"]),
        sel_bar_pos: pickOne(settings.sel_bar_pos, ["above", "below"]),
        sel_bar_items: Array.isArray(settings.sel_bar_items)
          ? settings.sel_bar_items.filter((id, i, a) => typeof id === "string" && id && id.length <= 32 && a.indexOf(id) === i).slice(0, 64)
          : DEFAULT_SETTINGS.sel_bar_items,
        tab_rows: Math.min(8, Math.max(2, Math.round(Number(settings.tab_rows)) || 4)),
        tab_drawer_width: Math.min(360, Math.max(140, Math.round(Number(settings.tab_drawer_width)) || 200)),
      };
      const notes = normPath(s.notes_dir);
      const dest = normPath(s.backup_dir);
      if (s.backup_enabled && notes && dest && (dest === notes || dest.startsWith(notes + "\\"))) {
        throw "备份位置不能放在笔记文件夹里面,请换一个文件夹";
      }
      return (db.settings = s);
    },
    pause_hotkey: () => {},
    resume_hotkey: () => {},
    note_activity: () => {},
    start_window_drag: () => {
      if (window.__mockControl) window.__mockControl.dragStarted = (window.__mockControl.dragStarted || 0) + 1;
    },
    // 测试可以用 __mockControl.pickFolder 指定"选中"的文件夹
    pick_folder: ({ title }) => {
      if (window.__mockControl && has(window.__mockControl, "pickFolder")) return window.__mockControl.pickFolder;
      toast(`(预览)会弹出「${title || "选择文件夹"}」对话框`);
      return null;
    },
    // 从 minipad2 导入:浏览器里读不了文件,测试用 __mockControl.minipad2 = { path, preview, books, skipped, warnings } 模拟
    minipad2_preview: ({ path }) => {
      const m = window.__mockControl?.minipad2;
      if (!m || normPath(path) !== normPath(m.path)) {
        throw `「${path}」里没有找到 minipad2 的数据。请选 minipad2 的程序文件夹(里面有 data 文件夹),或者它的 data 文件夹`;
      }
      return { folder: m.path, warnings: [], ...m.preview };
    },
    minipad2_import: ({ path, options }) => {
      const m = window.__mockControl?.minipad2;
      if (!m || normPath(path) !== normPath(m.path)) throw `「${path}」里没有找到 minipad2 的数据`;
      m.options = options;
      backup();
      const books = [];
      let pages = 0;
      for (const plan of m.books) {
        if (!plan.pages.length) continue;
        const name = uniqBook(plan.name);
        const b = (db.books[name] = fixBook({}));
        for (const [page, content] of plan.pages) {
          const n = uniqPage(b, page);
          b.files[n] = content;
          b.meta.order.push(n);
          pages++;
        }
        b.meta.active = b.meta.order[0];
        books.push(name);
      }
      return { books, pages, skipped: m.skipped ?? 0, warnings: m.importWarnings ?? [] };
    },
    hide_window: () => toast("(预览)窗口会隐藏到托盘,按 Ctrl+M 再呼出"),
    expand_edge: () => window.__mockEmit?.("edge-shown"),
    ball_info: () => {
      const s = db.settings || DEFAULT_SETTINGS;
      return { size: s.ball_size ?? 48, icon: s.ball_icon || "app", color: s.ball_color || "", opacity: s.ball_opacity ?? 100, open: s.ball_open || "click", image: window.__mockControl?.ballImage || null };
    },
    pick_ball_icon: () => window.__mockControl?.pickBallImage ?? null,
    collapse_to_ball: () => {
      if (window.__mockControl) window.__mockControl.collapsed = (window.__mockControl.collapsed || 0) + 1;
      toast("(预览)窗口会缩成悬浮图标,点图标再放出来");
    },
    expand_from_ball: () => {},
    open_notes_dir: () => toast("(预览)会在资源管理器里打开笔记文件夹"),
    open_link: ({ url }) => void window.open(url, "_blank", "noopener"),
    quit_ack: () => true,
    quit_cancel: () => {},
    show_window: () => {},
    quit_app: () => {},
  };

  // 方便在浏览器控制台(和界面测试)里模拟"文件在别处被改了":直接改这两个对象,不要整个换掉
  window.__mockBooks = db.books;
  window.__mockFiles = db.books[""].files;
  // 模拟后端发来的事件(比如贴边隐藏):window.__mockEmit("edge-hidden", "top")
  const listeners = {};
  window.__mockEmit = (ev, payload) => (listeners[ev] || []).forEach((cb) => cb({ event: ev, payload }));
  return {
    invoke: async (cmd, args = {}) => {
      // 测试专用：在页面控制台可模拟慢磁盘与写入失败。
      const test = window.__mockControl;
      if (Array.isArray(test?.calls)) test.calls.push(cmd);
      if (test?.delay?.[cmd]) await new Promise((resolve) => setTimeout(resolve, test.delay[cmd]));
      if (test?.fail?.[cmd]) throw new Error(test.fail[cmd]);
      if (cmd === "save_note" && test?.failNote?.[args.name]) throw new Error(test.failNote[args.name]);
      try {
        return cmds[cmd](args);
      } finally {
        persist();
      }
    },
    listen: async (ev, cb) => {
      (listeners[ev] ||= []).push(cb);
      return () => (listeners[ev] = listeners[ev].filter((c) => c !== cb));
    },
  };
}
