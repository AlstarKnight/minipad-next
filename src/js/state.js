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
};

// 页面:{ name, content, mode, dirty, scroll, disk, state, snap, group }
// disk 是最近一次从磁盘读到或写到磁盘的内容,用来判断文件有没有在别处被改过;
// scroll 是阅读模式的滚动位置;state / snap 是编辑器的状态(光标、撤销记录)和滚动位置,第一次编辑时才有;
// group 是所在标签分组的 id,不在分组里是空的;pinned 是固定在标签栏最前面
export function makeNote(name, content, mode = "edit", unreadable = false, reason = null, group = "") {
  return { name, content, mode, unreadable, reason, dirty: false, scroll: 0, disk: content, state: null, snap: null, group, pinned: false };
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
  return makeBook(d.name, notes, Math.max(0, notes.findIndex((n) => n.name === d.active)), (d.groups || []).map((g) => ({ ...g })), d.icon || "", d.icon_color || "");
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
