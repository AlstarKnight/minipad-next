// ---------- 读取笔记,和磁盘同步(别处改过的文件) ----------
import { api, isMiniWindow } from "./api.js";
import { tabsEl } from "./dom.js";
import { state, book, current, makeNote, noteFromDisk, bookFromDisk, sortBooks, inMini } from "./state.js";
import { toast } from "./ui.js";
import { scheduleMeta, scheduleBooks, scheduleSave, noteDiskRevision, noteSaveInFlight } from "./save.js";
import { editorIsComposing } from "./editor.js";
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
// 窗口还没显示时(开机自启时藏在托盘里)的启动提示,等窗口第一次得到焦点再弹,免得没人看见
let pendingNotice = "";

// 主窗口和小窗都持续检查前台文件；后台仍由 shown / window-focus 事件触发。
export function startForegroundSync() {
  const timer = setInterval(() => {
    if (!document.hidden && document.hasFocus()) void syncFromDisk();
  }, 1000);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
}

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
      const notices = [
        st.hotkey_error && "热键注册失败(" + st.hotkey_error + "),请在设置里换一个",
        st.settings_error && "原设置文件读取失败，已禁用设置写入；请检查 settings.json 后重启：" + st.settings_error,
        st.settings_notice,
      ].filter(Boolean);
      if (notices.length) {
        pendingNotice = notices.join("\n");
        if (document.hasFocus()) showPendingNotice();
      }
    } catch (e) {
      toast("读取笔记失败:" + e, 5000);
    }
  });
}

export function showPendingNotice() {
  if (pendingNotice) toast(pendingNotice, 9000);
  pendingNotice = "";
}

export async function syncFromDisk(force = false) {
  if (syncing || busy || editorIsComposing() || noteSaveInFlight() || !state.books.length || tabsEl.querySelector("input")) return;
  const now = Date.now();
  if (!force && now - lastSync < 800) return;
  lastSync = now;
  syncing = true;
  const g = gen;
  const revision = noteDiskRevision();
  try {
    let disk = await api.invoke("read_notes");
    // 读的时候页面或笔记本有变动,这次的结果就不用了
    const fresh = () => !busy && gen === g && !editorIsComposing() && !noteSaveInFlight() &&
      noteDiskRevision() === revision && !tabsEl.querySelector("input");
    if (!fresh()) return;
    if (isMiniWindow) disk = onlyThisPage(disk);
    if (!disk) return;
    await applyDisk(disk, fresh);
  } catch (e) {
    console.error(e);
  } finally {
    syncing = false;
  }
}

// 小窗只看自己这一页;这一页在磁盘上找不到(别处改名或删了)时什么也不做,不建新页面
function onlyThisPage(disk) {
  const b = book();
  const n = current();
  const d = disk.find((x) => x.name === b?.name);
  const dn = d?.notes.find((x) => x.name === n?.name);
  return dn ? [{ ...d, notes: [dn] }] : null;
}

// 有没有还没保存(或者保存失败)的修改
const edited = (n) => n.dirty || n.content !== n.disk;

// fresh:读回来的结果还能不能用(等后端回话的时候页面或笔记本可能又变了)
export async function applyDisk(disk, fresh = () => true) {
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
  if (!fresh()) return;
  // 上面等后端回话的时候可能换过笔记本或页面,以现在的为准
  const cur = book();
  const before = current();

  for (const b of books) {
    const d = onDisk.get(b.name);
    if (!d) continue;
    const r = mergeBook(b, d);
    if (r.tabs) {
      booksChanged = true;
      if (b === cur) tabsChanged = true;
      scheduleMeta(b);
    }
    if (r.appearance) booksChanged = true;
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
  const appearance = b.icon !== (d.icon || "") || b.icon_color !== (d.icon_color || "");
  if (appearance) {
    b.icon = d.icon || "";
    b.icon_color = d.icon_color || "";
  }
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
      if (state.settings?.conflict_mode !== "overwrite") {
        // 两边都改过:disk 不更新,马上存一次。保存时后端发现文件和 disk 不一样,
        // 先把别处的版本另存成冲突副本(见 addConflictCopy),这里的内容照常保存
        scheduleSave(n);
        continue;
      }
      toast(`「${n.name}」在别处也被修改了,这里保留了你正在编辑的内容`, 4000);
    }
    n.disk = text;
  }

  const known = new Set(kept.map((n) => n.name));
  for (const dn of d.notes) {
    if (known.has(dn.name)) continue;
    const added = noteFromDisk(dn);
    added.mini = inMini(b.name, dn.name);
    kept.push(added);
    tabs = true;
  }
  // 别处新建的分组(这里已有的分组以这里的为准)
  for (const g of d.groups || []) {
    if (!b.groups.some((x) => x.id === g.id)) b.groups.push({ ...g });
  }

  if (tabs) {
    b.notes = kept;
    const idx = kept.indexOf(before);
    b.active = idx >= 0 ? idx : Math.max(0, Math.min(b.active, kept.length - 1));
  }
  return { tabs, content, appearance };
}

// 保存时发现页面在别处也被改过,别处的版本已经另存成同一个笔记本里的冲突副本(save.js 发来的 conflict-copy):
// 把副本放到原来那页后面,当前页面不变
export function addConflictCopy({ book: b, note, copy }) {
  toast(`「${note.name}」在别处也被修改了,别处的版本另存成了「${copy.name}」`, 6000);
  return mutate(async () => {
    if (!state.books.includes(b) || b.notes.some((x) => x.name === copy.name)) return;
    const active = b.notes[b.active];
    const at = b.notes.indexOf(note);
    // 副本和原来那页在同一个分组里
    b.notes.splice(at >= 0 ? at + 1 : b.notes.length, 0, makeNote(copy.name, copy.content, "edit", false, null, note.group || ""));
    b.active = Math.max(0, b.notes.indexOf(active));
    if (b === book()) renderTabs();
    renderBook();
    scheduleMeta(b);
  });
}
