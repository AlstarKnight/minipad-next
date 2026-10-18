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
  edge_line_length_unit: "percent",
  edge_line_length_px: 120,
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
  ui_style: "starry",
  ui_tree: true,
  ui_rail: true,
  ui_stars: true,
  font_size: 14,
  notes_dir: "",
  line_numbers: false,
  date_format: DEFAULT_DATE_FORMAT,
  code_line_numbers: true,
  code_lang_menu: true,
  code_title_color: true,
  update_check: true,
  email_auto_link: false,
  block_enabled: true,
  block_context_menu: "system",
  code_exit_mode: "blank3",
  fold_save_state: true,
  format_bar: true,
  format_bar_hidden: [],
  format_bar_order: [],
  tab_style: "line",
  accent: "",
  book_color_presets: [],
  color_presets: null,
  color_library: null,
  quick_color_count: 5,
  quick_colors: null,
  color_library_rev: 0,
  quick_color_limit: 0,
  quick_gradient_limit: 0,
  quick_material_limit: 0,
  material_library: null,
  color_layout: "tabs",
  color_open_tab: "remember",
  gradient_shape: "square",
  gradient_names: true,
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
  pin_style: "icon",
  quick_switch_key: "Ctrl+P",
  quick_switch_scope: "all",
  edge_button: true,
  sel_bar: "always",
  sel_bar_items: ["block", "strong", "em", "strike", "code", "link", "sep3", "color", "bg"],
  sel_bar_pos: "above",
  image_paste: true,
  image_size: "full",
  mini_enabled: true,
  mini_on_top: true,
  mini_hotkey: "follow",
  mini_opacity: 100,
  mini_restore: true,
  mini_max: 0,
  mini_tab_button: true,
  mini_windows: [],
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
  if (!Array.isArray(db.trash)) db.trash = [];
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
// 和 lib.rs 一样：整理、去重，纯色和渐变各自最多 128 个
const perKind = (list) => {
  const count = { solid: 0, gradient: 0 };
  return [...new Set(list.map((v) => tidyAccent(v)).filter(Boolean))]
    .filter((v) => ++count[v.startsWith("linear-gradient(") ? "gradient" : "solid"] <= 128);
};

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

  // 删掉的页面、笔记本放进回收站
  const toTrash = (item) => {
    db.trash.unshift({ id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, deleted: Math.floor(Date.now() / 1000), ...item });
  };
  // 导入的暂存区:有页面的笔记本,页面名字去重;content 只在模拟里带着,导入时用
  const stagedBooks = (m) =>
    m.books
      .filter((plan) => plan.pages.length)
      .map((plan) => {
        const taken = [];
        return {
          name: plan.name,
          pages: plan.pages.map(([page, content]) => {
            const name = firstFree(clean(page, "新页面"), (n) => taken.includes(n.toLowerCase()));
            taken.push(name.toLowerCase());
            return { name, chars: [...content].length, preview: content.split(/\s+/).filter(Boolean).join(" ").slice(0, 80), content };
          }),
        };
      });
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
        return { name: n, content: reason && !window.__mockControl?.keepUnreadableContent ? "" : files[n],
          mode: meta.modes[n] || "edit", unreadable: !!reason, reason, group, pinned: (meta.pinned || []).includes(n) };
      }),
      active: order.includes(meta.active) ? meta.active : (order[0] ?? ""),
      groups: (meta.groups || []).filter((x) => order.some((n) => meta.note_groups?.[n] === x.id)),
      icon: meta.icon || "",
      icon_color: meta.icon_color || "",
    };
  };
  const readBooks = () => ["", ...bookNames()].filter((name) => !window.__mockControl?.unreadableBook?.includes(name)).map(readBook);

  // 开着的小窗 [{ book, name }]
  let minis = [];
  const emitMinis = () => window.__mockEmit?.("mini-changed", minis.map((m) => ({ ...m })));
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
        // 测试用 __mockControl.settingsNotice 模拟后端的提示(比如设置文件损坏、已改名留底)
        settings_notice: window.__mockControl?.settingsNotice ?? null,
        // 测试用 __mockControl.version 模拟正式版本号(新版本提醒只在版本号像 0.4.3 时检查)
        version: window.__mockControl?.version ?? "预览",
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
      if (!has(db.books, book) || !has(db.books[book].files, name)) return;
      const content = db.books[book].files[name];
      toTrash({ kind: "page", book, name, preview: content.split(/\s+/).filter(Boolean).join(" ").slice(0, 120), pages: 0, content });
      delete db.books[book].files[name];
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
      // 页面用到的图片也复制过去(和后端一样,原来的留着)
      for (const [, rel] of String(dst.files[n]).matchAll(/\]\(<?(assets\/[^)\s>]+)/g)) {
        const from = db.images?.[book + "\n" + rel];
        if (from && !db.images[target + "\n" + rel]) db.images[target + "\n" + rel] = from;
      }
      return n;
    },
    // 笔记本已经不在了就不写,免得把删掉的笔记本又建出来
    // 带了 groups 才改分组(和 Rust 一样只记还有页面的分组);带了 pinned 才改固定的页面
    save_meta: ({ book, order, active, modes, groups, note_groups, pinned }) => {
      if (!has(db.books, book)) return;
      const old = db.books[book].meta || {};
      const meta = { ...old, order, active, modes, groups: old.groups || [], note_groups: old.note_groups || {} };
      if (pinned) meta.pinned = pinned.filter((n, i, a) => order.includes(n) && a.indexOf(n) === i);
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
      toTrash({ kind: "book", book: "", name, preview: "", pages: Object.keys(db.books[name].files).length, data: db.books[name] });
      delete db.books[name];
      if (db.book === name) db.book = "";
    },
    // 回收站:和后端一样,页面恢复到原来的笔记本(不在了就重新建),重名时加编号
    trash_list: () => db.trash.map(({ content, data, ...item }) => item),
    trash_restore: ({ id }) => {
      const item = db.trash.find((t) => t.id === id);
      if (!item) throw "回收站里已经没有这一项了";
      db.trash = db.trash.filter((t) => t !== item);
      backup();
      if (item.kind === "book") {
        const name = uniqBook(item.name);
        db.books[name] = fixBook(item.data);
        return { book: name, name: "" };
      }
      const b = bookOf(item.book);
      const name = uniqPage(b, item.name);
      b.files[name] = item.content;
      return { book: item.book, name };
    },
    trash_purge: ({ id }) => {
      if (!db.trash.some((t) => t.id === id)) throw "回收站里已经没有这一项了";
      db.trash = db.trash.filter((t) => t.id !== id);
    },
    trash_empty: () => {
      const n = db.trash.length;
      db.trash = [];
      return n;
    },
    set_current_book: ({ book }) => void (db.book = book),
    // 测试用 __mockControl.backupSkipped 模拟最近一份备份跳过的文件
    backup_info: () => ({ dir: "(浏览器预览)", latest: db.backups.at(-1) ?? null, count: db.backups.length, skipped: window.__mockControl?.backupSkipped ?? [] }),
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
        block_context_menu: pickOne(settings.block_context_menu, ["system", "block"]),
        code_exit_mode: pickOne(settings.code_exit_mode, ["blank3", "blank2", "ctrl"]),
        conflict_mode: pickOne(settings.conflict_mode, ["copy", "overwrite"]),
        settings_nav: pickOne(settings.settings_nav, ["left", "top"]),
        color_presets: [...new Set(
          (Array.isArray(settings.color_presets) ? settings.color_presets : settings.book_color_presets || [])
            .map((v) => tidyAccent(v))
            .filter(Boolean)
        )].slice(0, 20),
        color_library: Array.isArray(settings.color_library) ? perKind(settings.color_library) : null,
        quick_color_count: Math.min(128, Math.max(1, Math.round(Number(settings.quick_color_count) || 5))),
        quick_colors: Array.isArray(settings.quick_colors) ? perKind(settings.quick_colors) : null,
        color_library_rev: Math.max(0, Math.round(Number(settings.color_library_rev) || 0)),
        quick_color_limit: Math.min(128, Math.max(0, Math.round(Number(settings.quick_color_limit) || 0))),
        quick_gradient_limit: Math.min(128, Math.max(0, Math.round(Number(settings.quick_gradient_limit) || 0))),
        quick_material_limit: Math.min(128, Math.max(0, Math.round(Number(settings.quick_material_limit) || 0))),
        material_library: Array.isArray(settings.material_library)
          ? [...new Set(settings.material_library.map((v) => tidyAccent(v)).filter(Boolean))].slice(0, 128) : null,
        color_layout: pickOne(settings.color_layout, ["tabs", "rows"]),
        color_open_tab: pickOne(settings.color_open_tab, ["remember", "solid", "gradient", "material", "follow"]),
        gradient_shape: pickOne(settings.gradient_shape, ["square", "bar", "round"]),
        gradient_names: settings.gradient_names !== false,
        edge_line_length_unit: settings.edge_line_length_unit === "px" ? "px" : "percent",
        edge_line_length: Math.min(100, Math.max(10, Number(settings.edge_line_length) || 100)),
        edge_line_length_px: Math.min(600, Math.max(24, Number(settings.edge_line_length_px) || 120)),
        outline_mode: pickOne(settings.outline_mode, ["hover", "pinned"]),
        outline_side: pickOne(settings.outline_side, ["right", "left"]),
        outline_depth: Math.min(6, Math.max(1, Math.round(Number(settings.outline_depth)) || 3)),
        outline_width: Math.min(360, Math.max(140, Math.round(Number(settings.outline_width)) || 200)),
        outline_opacity: Math.min(100, Math.max(40, Math.round(Number(settings.outline_opacity)) || 100)),
        tab_overflow: pickOne(settings.tab_overflow, ["scroll", "wrap", "drawer"]),
        tab_drawer_side: pickOne(settings.tab_drawer_side, ["left", "right"]),
        tab_group_style: pickOne(settings.tab_group_style, ["line", "tint"]),
        pin_style: pickOne(settings.pin_style, ["icon", "tint", "none"]),
        quick_switch_scope: pickOne(settings.quick_switch_scope, ["all", "book"]),
        quick_switch_key: [...String(settings.quick_switch_key ?? "").trim()].slice(0, 40).join(""),
        sel_bar: pickOne(settings.sel_bar, ["always", "nobar", "off"]),
        sel_bar_pos: pickOne(settings.sel_bar_pos, ["above", "below"]),
        sel_bar_items: Array.isArray(settings.sel_bar_items)
          ? settings.sel_bar_items.filter((id, i, a) => typeof id === "string" && id && id.length <= 32 && a.indexOf(id) === i).slice(0, 64)
          : DEFAULT_SETTINGS.sel_bar_items,
        tab_rows: Math.min(8, Math.max(2, Math.round(Number(settings.tab_rows)) || 4)),
        tab_drawer_width: Math.min(360, Math.max(140, Math.round(Number(settings.tab_drawer_width)) || 200)),
        mini_hotkey: pickOne(settings.mini_hotkey, ["follow", "independent"]),
        image_size: pickOne(settings.image_size, ["full", "medium", "small"]),
        mini_opacity: Math.min(100, Math.max(40, Math.round(Number(settings.mini_opacity)) || 100)),
        mini_max: Math.min(20, Math.max(0, Math.round(Number(settings.mini_max)) || 0)),
        mini_windows: db.settings.mini_windows || [],
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
    // 暂存区:m.books 里有页面的笔记本,页面重名时加编号(和后端一样)
    minipad2_stage: ({ path, options }) => {
      const m = window.__mockControl?.minipad2;
      if (!m || normPath(path) !== normPath(m.path)) throw `「${path}」里没有找到 minipad2 的数据`;
      m.stagedOptions = options;
      return { books: stagedBooks(m), skipped: m.skipped ?? 0, warnings: m.importWarnings ?? [] };
    },
    minipad2_import: ({ path, options, leave }) => {
      const m = window.__mockControl?.minipad2;
      if (!m || normPath(path) !== normPath(m.path)) throw `「${path}」里没有找到 minipad2 的数据`;
      m.options = options;
      m.leave = leave;
      backup();
      const books = [];
      let pages = 0;
      stagedBooks(m).forEach((plan, i) => {
        if (leave?.books?.includes(i)) return;
        const picked = plan.pages.filter((_, j) => !leave?.pages?.some(([bi, pj]) => bi === i && pj === j));
        if (!picked.length) return;
        const name = uniqBook(plan.name);
        const b = (db.books[name] = fixBook({}));
        for (const p of picked) {
          b.files[p.name] = p.content;
          b.meta.order.push(p.name);
          pages++;
        }
        b.meta.active = b.meta.order[0];
        books.push(name);
      });
      return { books, pages, skipped: m.skipped ?? 0, warnings: m.importWarnings ?? [] };
    },
    hide_window: () => toast("(预览)窗口会隐藏到托盘,按 Ctrl+M 再呼出"),
    expand_edge: () => window.__mockEmit?.("edge-shown"),
    ball_info: () => {
      const s = db.settings || DEFAULT_SETTINGS;
      return { size: s.ball_size ?? 48, icon: s.ball_icon || "app", color: s.ball_color || "", opacity: s.ball_opacity ?? 100, open: s.ball_open || "click", image: window.__mockControl?.ballImage || null };
    },
    pick_ball_icon: () => window.__mockControl?.pickBallImage ?? null,
    refresh_ball_icon: () => window.__mockControl?.ballImage || null,
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
    // 小窗:预览里不真的开窗口,只记下来并像后端一样发 mini-changed;
    // 小窗那边用 index.html?mini=1&book=&page= 打开(mini_self 从网址里读)
    mini_open: ({ book, name, x, y }) => {
      const s = db.settings;
      if (!s.mini_enabled) throw "小窗已经关掉了,可以在 设置 → 窗口 里打开";
      if (s.mini_max && minis.length >= s.mini_max) throw `最多同时开 ${s.mini_max} 个小窗,先关掉一个吧(设置 → 窗口 可以改)`;
      if (!has(db.books, book) || !has(db.books[book].files, name)) throw `找不到页面「${name}」`;
      if (window.__mockControl) (window.__mockControl.miniOpened ||= []).push({ book, name, x, y });
      if (!minis.some((m) => m.book === book && m.name === name)) minis.push({ book, name });
      emitMinis();
    },
    mini_self: () => {
      const q = new URLSearchParams(location.search);
      if (!q.has("mini")) return null;
      const s = db.settings;
      return { book: q.get("book") || "", name: q.get("page") || "", top: s.mini_on_top, opacity: s.mini_opacity };
    },
    mini_list: () => minis.map((m) => ({ ...m })),
    mini_focus: ({ book, name }) => {
      if (window.__mockControl) (window.__mockControl.miniFocused ||= []).push(name);
      return minis.some((m) => m.book === book && m.name === name);
    },
    mini_recall: ({ book, name }) => {
      if (window.__mockControl) (window.__mockControl.miniRecalled ||= []).push(name);
      return minis.some((m) => m.book === book && m.name === name);
    },
    mini_close: ({ back }) => {
      if (window.__mockControl) (window.__mockControl.miniClosed ||= []).push(back);
    },
    mini_set: ({ top, opacity }) => {
      if (window.__mockControl) (window.__mockControl.miniSet ||= []).push({ top, opacity });
    },
    mini_restore: () => {},
    // 图片:存成 data: 网址放在 db.images 里,显示时用 __mockImage 取回
    save_image: (bytes, { headers } = {}) => {
      const { book, ext } = JSON.parse(decodeURIComponent(headers?.["x-image"] || ""));
      if (!db.settings.image_paste) throw "粘贴图片已经关掉了,可以在 设置 → 编辑 里打开";
      if (!has(db.books, book)) throw "找不到这个笔记本";
      const type = { jpg: "jpeg" }[ext] || ext;
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      db.images ||= {};
      let n = 1;
      const stamp = window.__mockControl?.imageStamp || "20261016-101500";
      let path = `assets/img-${stamp}.${ext}`;
      while (db.images[book + "\n" + path]) path = `assets/img-${stamp}-${++n}.${ext}`;
      db.images[book + "\n" + path] = `data:image/${type};base64,${btoa(bin)}`;
      return path;
    },
    mini_flush_all: () => window.__mockControl?.miniFlushErrors ?? [],
    mini_flushed: ({ error }) => {
      if (window.__mockControl) (window.__mockControl.miniFlushed ||= []).push(error);
    },
  };

  // 方便在浏览器控制台(和界面测试)里模拟"文件在别处被改了":直接改这两个对象,不要整个换掉
  window.__mockBooks = db.books;
  window.__mockImage = (book, path) => db.images?.[book + "\n" + path.replace(/^\.\//, "")] || "";
  window.__mockFiles = db.books[""].files;
  // 模拟后端发来的事件(比如贴边隐藏):window.__mockEmit("edge-hidden", "top")
  const listeners = {};
  window.__mockEmit = (ev, payload) => (listeners[ev] || []).forEach((cb) => cb({ event: ev, payload }));
  // 测试里模拟小窗关掉:window.__mockMiniClosed("", "页面", true) 和后端一样先发 mini-changed 再发 mini-returned
  window.__mockMiniClosed = (book, name, back = false) => {
    minis = minis.filter((m) => !(m.book === book && m.name === name));
    emitMinis();
    window.__mockEmit("mini-returned", { book, name, back });
  };
  return {
    invoke: async (cmd, args = {}, options = {}) => {
      // 测试专用：在页面控制台可模拟慢磁盘与写入失败。
      const test = window.__mockControl;
      if (Array.isArray(test?.calls)) test.calls.push(cmd);
      if (test?.delay?.[cmd]) await new Promise((resolve) => setTimeout(resolve, test.delay[cmd]));
      if (test?.fail?.[cmd]) throw new Error(test.fail[cmd]);
      if (cmd === "save_note" && test?.failNote?.[args.name]) throw new Error(test.failNote[args.name]);
      try {
        return cmds[cmd](args, options);
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
