// ---------- 浏览器预览用的模拟后端 ----------
// 数据存在 localStorage 里,命令和真正的后端一一对应
import { toast } from "./ui.js";
import { DEFAULT_DATE_FORMAT } from "./datetime.js";

const KEY = "minipad-next-demo";
const WELCOME =
  "# 欢迎使用 Minipad Next\n\n这是浏览器里的界面预览,真正的程序在 Windows 上运行。选中文字试试上面出来的按钮。\n\n- [ ] 点方框勾选任务\n- [x] 已经做完的事\n\n```js 试试复制\nconsole.log('点右上角的复制按钮试试');\n```\n";
const DEFAULT_SETTINGS = {
  hotkey: "Ctrl+M",
  always_on_top: true,
  edge_hide: true,
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
  backup_enabled: true,
  backup_keep: 14,
  backup_dir: "",
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
      notes: order.map((n) => ({ name: n, content: files[n], mode: meta.modes[n] || "edit" })),
      active: order.includes(meta.active) ? meta.active : (order[0] ?? ""),
    };
  };
  const readBooks = () => ["", ...bookNames()].map(readBook);

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
        version: "预览",
        debug: true,
      };
    },
    read_notes: () => readBooks(),
    save_note: ({ book, name, content }) => {
      backup();
      bookOf(book).files[name] = content;
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
    save_meta: ({ book, order, active, modes }) => {
      if (has(db.books, book)) db.books[book].meta = { order, active, modes };
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
    save_settings: ({ settings }) => {
      const s = {
        ...settings,
        hotkey: String(settings.hotkey ?? "").trim(),
        notes_dir: String(settings.notes_dir ?? "").trim(),
        backup_dir: String(settings.backup_dir ?? "").trim(),
        backup_keep: Math.min(365, Math.max(1, Math.round(Number(settings.backup_keep)) || 1)),
        date_format: tidyDateFormat(settings.date_format),
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
    pick_folder: ({ title }) => {
      toast(`(预览)会弹出「${title || "选择文件夹"}」对话框`);
      return null;
    },
    hide_window: () => toast("(预览)窗口会隐藏到托盘,按 Ctrl+M 再呼出"),
    open_notes_dir: () => toast("(预览)会在资源管理器里打开笔记文件夹"),
    open_link: ({ url }) => void window.open(url, "_blank", "noopener"),
    quit_app: () => {},
  };

  // 方便在浏览器控制台(和界面测试)里模拟"文件在别处被改了":直接改这两个对象,不要整个换掉
  window.__mockBooks = db.books;
  window.__mockFiles = db.books[""].files;
  return {
    invoke: async (cmd, args = {}) => {
      try {
        return cmds[cmd](args);
      } finally {
        persist();
      }
    },
    listen: async () => () => {},
  };
}
