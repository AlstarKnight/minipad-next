// ---------- 状态 ----------
export const state = {
  // 全部笔记本,按显示顺序:「默认」在最前,其余按名字排
  books: [],
  // 当前笔记本在 books 里的位置
  book: 0,
  settings: null,
  notesDir: "",
  version: "",
  debug: false,
  // 主窗口:正在小窗里编辑的页面 [{ book, name }](见 mini.js);小窗里是空的
  minis: [],
};

export function inMini(bookName, name) {
  return state.minis.some((m) => m.book === bookName && m.name === name);
}

// 页面:{ name, content, mode, dirty, scroll, disk, state, snap, group, mini }
// disk 是最近一次从磁盘读到或写到磁盘的内容,用来判断文件有没有在别处被改过;
// scroll 是阅读模式的滚动位置;state / snap 是编辑器的状态(光标、撤销记录)和滚动位置,第一次编辑时才有;
// group 是所在标签分组的 id,不在分组里是空的;pinned 是固定在标签栏最前面;
// mini 是这一页正在小窗里编辑(主窗口里只读,不保存)
export function makeNote(name, content, mode = "edit", unreadable = false, reason = null, group = "") {
  return { name, content, mode, unreadable, reason, dirty: false, scroll: 0, disk: content, state: null, snap: null, group, pinned: false, mini: false };
}

// 笔记本:「默认」的 name 是空字符串,active 是当前页面在 notes 里的位置;
// groups 是标签分组 [{ id, name, color, collapsed }](见 groups.js)
export function makeBook(name, notes = [], active = 0, groups = [], icon = "", icon_color = "") {
  return { name, notes, active, groups, icon, icon_color };
}

// 后端读出来的笔记本 { name, notes, active: 页面名, groups } 换成界面用的
export function noteFromDisk(n) {
  const note = makeNote(n.name, n.content, n.mode, !!n.unreadable, n.reason ?? null, n.group || "");
  note.pinned = !!n.pinned;
  return note;
}
export function bookFromDisk(d) {
  const notes = d.notes.map(noteFromDisk);
  for (const n of notes) n.mini = inMini(d.name, n.name);
  const b = makeBook(d.name, notes, Math.max(0, notes.findIndex((n) => n.name === d.active)), (d.groups || []).map((g) => ({ ...g })), d.icon || "", d.icon_color || "");
  b.diskMeta = sharedMeta(d.notes, d.groups || []);
  return b;
}

// 笔记本信息里会同步到别的设备的几项(页面顺序、固定、分组),按写进 .minipad.json 的样子比较;
// 磁盘上的笔记本和这里的笔记本都能算。固定和分组只看有哪些,不看先后(和后端 keep_disk_changes 一样)
const byKey = (key) => (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
export function sharedMeta(notes, groups) {
  return {
    order: JSON.stringify(notes.map((n) => n.name)),
    pinned: JSON.stringify(notes.filter((n) => n.pinned).map((n) => n.name).sort()),
    note_groups: JSON.stringify(notes.filter((n) => n.group).map((n) => [n.name, n.group]).sort(byKey((p) => p[0]))),
    groups: JSON.stringify(groups.filter((g) => notes.some((n) => n.group === g.id)).sort(byKey((g) => g.id))),
  };
}

export function book() {
  return state.books[state.book];
}

export function current() {
  const b = book();
  return b && b.notes[b.active];
}

export function bookLabel(b) {
  return b.name || "默认";
}

const collator = new Intl.Collator("zh-CN", { numeric: true });

// 按显示顺序排笔记本,当前笔记本跟着对象走
export function sortBooks() {
  const cur = book();
  state.books.sort((a, b) => (a.name === "" ? -1 : b.name === "" ? 1 : collator.compare(a.name, b.name)));
  state.book = Math.max(0, state.books.indexOf(cur));
}
