// ---------- 快速记录(0.5.1) ----------
// 按快速记录的热键(或托盘菜单「快速记录」):主窗口找好要写的页面(没有就建),用快速记录的方式放进小窗;
// 小窗那边在设好的地方加一条新的(可以带上时间),光标放在这一条末尾。Esc 或者再按一次热键收起。
// 加这一条不算修改,打了字才连同这一条一起保存,所以没写东西就关掉时文件不变;
// 「每次新建一页」时没写东西的那一页也删掉
import { api } from "./api.js";
import { state, book, current, makeNote, bookLabel } from "./state.js";
import { toast } from "./ui.js";
import { flushAll, scheduleMeta } from "./save.js";
import { mutate } from "./sync.js";
import { rememberView, showNote } from "./page.js";
import { renderTabs, removeNote } from "./tabs.js";
import { editorView } from "./editor.js";
import { formatDate } from "./datetime.js";
import { fillVars } from "./vars.js";
import { fileName } from "./pagelinks.js";
import { TextSelection } from "../vendor/milkdown.js";

export const DEFAULT_CAPTURE_PAGE = "收集箱";
export const DEFAULT_CAPTURE_NAME = "快速记录 {{日期}} {{时间:HH.mm}}";
// 和 editor.js 里的一样:别处来的修改,不算用户的修改,不触发保存
const EXTERNAL = "minipad-external";

// ---- 主窗口 ----

// 「每次新建一页」建出来的页面:小窗关掉时还是空的就删掉
const fresh = new Set();
const keyOf = (bookName, name) => bookName + "\n" + name;

async function newPage(b, base) {
  const n = await mutate(async () => {
    const page = makeNote(await api.invoke("create_note", { book: b.name, name: base }), "");
    b.notes.push(page);
    scheduleMeta(b);
    return page;
  });
  renderTabs();
  return n;
}

async function quickCapture() {
  const s = state.settings;
  if (!s || !state.books.length) return;
  // 设的笔记本不在了就用默认笔记本
  const b = state.books.find((x) => x.name === (s.capture_book || "")) || state.books.find((x) => x.name === "") || state.books[0];
  try {
    let n;
    if (s.capture_target === "new") {
      n = await newPage(b, fillVars(s.capture_name || DEFAULT_CAPTURE_NAME, { dateFormat: s.date_format, book: bookLabel(b) }));
      fresh.add(keyOf(b.name, n.name));
    } else {
      const page = s.capture_page || DEFAULT_CAPTURE_PAGE;
      n = b.notes.find((x) => x.name.toLowerCase() === fileName(page).toLowerCase()) || (await newPage(b, page));
    }
    if (n.unreadable) return toast(`「${n.name}」读取失败,不能快速记录`, 4000);
    if (n === current()) rememberView();
    await flushAll();
    await api.invoke("mini_open", { book: b.name, name: n.name, x: null, y: null, capture: true });
  } catch (e) {
    toast("没能打开快速记录:" + e, 4000);
  }
}

// 新建的那一页没写东西:删掉(后端只删空文件)
async function dropIfEmpty({ book: bookName, name }) {
  if (!fresh.delete(keyOf(bookName, name))) return;
  try {
    if (!(await api.invoke("delete_if_empty", { book: bookName, name }))) return;
  } catch {
    return;
  }
  const b = state.books.find((x) => x.name === bookName);
  const n = b?.notes.find((x) => x.name === name);
  if (!n) return;
  await mutate(async () => {
    removeNote(b, n);
    scheduleMeta(b);
  });
  renderTabs();
  if (b === book()) showNote();
}

export function bindCapture() {
  api.listen("quick-capture", () => void quickCapture());
  api.listen("mini-returned", (e) => void dropIfEmpty(e.payload || {}));
}

// ---- 小窗 ----

// 最近加的那一条:加完时的文档、加之前的文档、那时磁盘上的内容
let entry = null;

// 在设好的地方加一条新的,光标放在这一条末尾。上一条还没写字就不再加
export function addEntry(s) {
  const view = editorView();
  const n = current();
  if (!view || !n || n.unreadable) return;
  if (entry && view.state.doc.eq(entry.doc)) return void view.focus();
  const before = view.state.doc;
  const { tr, at } = insertEntry(view.state, s);
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, at)).setMeta(EXTERNAL, true).setMeta("addToHistory", false).scrollIntoView());
  entry = { doc: view.state.doc, before, disk: n.disk };
  view.focus();
}

// 新的一条:段落、列表项或待办;挨着列表时接在那个列表里。返回插好的事务和光标位置(这一条的末尾)
function insertEntry(st, s) {
  const { schema } = st;
  const tr = st.tr;
  const stamp = s.capture_stamp === false ? "" : formatDate(new Date(), s.date_format) + " ";
  const para = schema.nodes.paragraph.create(null, stamp ? schema.text(stamp) : null);
  const list = s.capture_format === "list" || s.capture_format === "task";
  const item = (like) => schema.nodes.list_item.create({ ...(like?.attrs || { spread: false }), checked: s.capture_format === "task" ? false : null }, para);
  const start = s.capture_where === "start";
  // 开头:页面以标题开头时放在标题下面
  let pos = start ? (st.doc.firstChild.type.name === "heading" ? st.doc.firstChild.nodeSize : 0) : st.doc.content.size;
  // 那里是个空段落就用掉它
  const empty = start ? st.doc.nodeAt(pos) : st.doc.lastChild;
  if (empty?.type.name === "paragraph" && !empty.content.size && st.doc.childCount > 1) {
    if (start) tr.delete(pos, pos + empty.nodeSize);
    else tr.delete((pos -= empty.nodeSize), pos + empty.nodeSize);
  }
  const near = start ? tr.doc.nodeAt(pos) : pos > 0 ? tr.doc.resolve(pos).nodeBefore : null;
  if (list && near?.type.name === "bullet_list") {
    // 接在挨着的列表里(末尾加在最后,开头加在最前)
    const at = start ? pos + 1 : pos - 1;
    tr.insert(at, item(start ? near.firstChild : near.lastChild));
    return { tr, at: at + 2 + para.content.size };
  }
  const block = list ? schema.nodes.bullet_list.create({ spread: false }, item(null)) : para;
  // 只有一个空段落的页面:换掉它
  if (st.doc.childCount === 1 && !st.doc.firstChild.content.size && st.doc.firstChild.type.name === "paragraph") {
    tr.replaceWith(0, st.doc.content.size, block);
    pos = 0;
  } else tr.insert(pos, block);
  return { tr, at: pos + (list ? 3 : 1) + para.content.size };
}

// 关小窗前:加的那一条还没写东西就拿掉。没打过字时什么也没存,不用动;
// 打了字又删回去的,恢复成加之前的样子(接着照常保存)
export function dropEmptyEntry() {
  const view = editorView();
  const n = current();
  const last = entry;
  entry = null;
  if (!last || !view || !n || !view.state.doc.eq(last.doc)) return;
  if (!n.dirty && !n.mdStale && n.disk === last.disk) return;
  view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, last.before.content).setMeta("addToHistory", false));
}
