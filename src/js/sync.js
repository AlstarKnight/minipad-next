// ---------- 读取笔记,和磁盘同步(别处改过的文件) ----------
import { api } from "./api.js";
import { tabsEl } from "./dom.js";
import { state, book, current, makeNote, bookFromDisk, sortBooks } from "./state.js";
import { toast } from "./ui.js";
import { scheduleMeta, scheduleBooks } from "./save.js";
import { showNote, refreshCurrent } from "./page.js";
import { renderTabs, ensurePage } from "./tabs.js";
import { renderBook } from "./notebooks.js";
import { applySettings } from "./settings.js";

// 正在新建、改名、删除、移动页面或笔记本:这时不和磁盘同步
let busy = 0;
// 每次改结构前后都加一;同步读回来时变了就说明结果过时了
let gen = 0;
let syncing = false;
let lastSync = 0;

export async function mutate(fn) {
  busy++;
  gen++;
  try {
    return await fn();
  } finally {
    gen++;
    busy--;
  }
}

export function reload() {
  return mutate(async () => {
    try {
      const st = await api.invoke("load_state");
      state.settings = st.settings;
      state.notesDir = st.notes_dir;
      state.version = st.version || "";
      state.debug = !!st.debug;
      state.books = st.books.map(bookFromDisk);
      state.book = Math.max(0, state.books.findIndex((b) => b.name === st.book));
      sortBooks();
      applySettings();
      await ensurePage(book());
      renderBook();
      renderTabs();
      showNote();
      if (st.hotkey_error) toast("热键注册失败(" + st.hotkey_error + "),请在设置里换一个", 5000);
      if (st.settings_error) toast("原设置文件读取失败，已禁用设置写入；请检查 settings.json 后重启：" + st.settings_error, 9000);
    } catch (e) {
      toast("读取笔记失败:" + e, 5000);
    }
  });
}

export async function syncFromDisk(force = false) {
  if (syncing || busy || !state.books.length || tabsEl.querySelector("input")) return;
  const now = Date.now();
  if (!force && now - lastSync < 800) return;
  lastSync = now;
  syncing = true;
  const g = gen;
  try {
    const disk = await api.invoke("read_notes");
    // 读的时候页面或笔记本有变动,这次的结果就不用了
    if (busy || gen !== g || tabsEl.querySelector("input")) return;
    await applyDisk(disk);
  } catch (e) {
    console.error(e);
  } finally {
    syncing = false;
  }
}

// 有没有还没保存(或者保存失败)的修改
const edited = (n) => n.dirty || n.content !== n.disk;

export async function applyDisk(disk) {
  const cur = book();
  const before = current();
  const onDisk = new Map(disk.map((d) => [d.name, d]));
  let booksChanged = false;
  let tabsChanged = false;
  let currentChanged = false;

  // 缺失的笔记本有两种情况：目录已删除，或者仍存在但暂时读不了。
  // 仅对确实不存在且没有本地未保存修改的笔记本执行删除同步。
  const books = [];
  for (const b of state.books) {
    if (b.name === "" || onDisk.has(b.name) || b.notes.some(edited)) {
      books.push(b);
      continue;
    }
    const exists = await api.invoke("book_exists", { book: b.name }).catch(() => true);
    if (exists) books.push(b);
    else booksChanged = true;
  }

  for (const b of books) {
    const d = onDisk.get(b.name);
    if (!d) continue;
    const r = mergeBook(b, d);
    if (r.tabs) {
      booksChanged = true;
      if (b === cur) tabsChanged = true;
      scheduleMeta(b);
    }
    if (r.content && b === cur) currentChanged = true;
  }

  // 在别处新建的笔记本
  const known = new Set(books.map((b) => b.name));
  for (const d of disk) {
    if (known.has(d.name)) continue;
    books.push(bookFromDisk(d));
    booksChanged = true;
  }

  if (!booksChanged && !currentChanged) return;
  state.books = books;
  if (books.includes(cur)) {
    state.book = books.indexOf(cur);
  } else {
    // 当前笔记本在别处被删了:回到「默认」
    state.book = books.findIndex((b) => b.name === "");
    scheduleBooks();
  }
  sortBooks();
  await ensurePage(book());
  renderBook();
  if (tabsChanged || book() !== cur) renderTabs();
  if (current() !== before) showNote();
  else if (currentChanged) refreshCurrent();
}

// 同步读取失败不能覆盖本地内容，也不能把暂时不可读当作删除。
function mergeBook(b, d) {
  const onDisk = new Map(d.notes.map((n) => [n.name, n]));
  const before = b.notes[b.active];
  let tabs = false;
  let content = false;

  const kept = b.notes.filter((n) => {
    if (onDisk.has(n.name) || edited(n)) return true;
    tabs = true;
    return false;
  });

  for (const n of kept) {
    const dn = onDisk.get(n.name);
    if (!dn) continue;
    if (dn.unreadable) {
      if (!n.unreadable) {
        if (edited(n)) toast(`「${n.name}」读取失败，已保留未保存的修改`, 5000);
        n.unreadable = true;
        n.state = null;
        tabs = true;
        if (n === before) content = true;
      }
      const reason = dn.reason || "未知错误";
      if (n.reason !== reason) {
        n.reason = reason;
        tabs = true;
        if (n === before) content = true;
      }
      // 本地内容及 disk 基准都保留，禁止将读取失败占位写入磁盘。
      continue;
    }

    const recovered = n.unreadable;
    if (recovered) {
      n.unreadable = false;
      n.reason = null;
      n.state = null;
      tabs = true;
      if (n === before) content = true;
    }
    const text = dn.content;
    if (text === n.disk && !recovered) continue;
    if (!edited(n)) {
      n.content = text;
      if (n === before) content = true;
    } else if (text !== n.content) {
      toast(`「${n.name}」在别处也被修改了,这里保留了你正在编辑的内容`, 4000);
    }
    n.disk = text;
  }

  const known = new Set(kept.map((n) => n.name));
  for (const dn of d.notes) {
    if (known.has(dn.name)) continue;
    kept.push(makeNote(dn.name, dn.content, dn.mode, !!dn.unreadable, dn.reason ?? null));
    tabs = true;
  }

  if (tabs) {
    b.notes = kept;
    const idx = kept.indexOf(before);
    b.active = idx >= 0 ? idx : Math.max(0, Math.min(b.active, kept.length - 1));
  }
  return { tabs, content };
}
