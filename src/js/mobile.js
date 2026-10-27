// Android-only Milkdown editor. Persist Markdown; binary images go to the book's assets folder.
import { $prose, Plugin, TextSelection } from "../vendor/milkdown.js";
import { createEditor, editorDebug, showInEditor, syncContent, setMobileLocalPathEnabled, toggleTask } from "./editor.js";
import { imageSrc } from "./images.js";
import { state as desktopState } from "./state.js";
import { setSelectionBar, setFormatBarItems } from "./formatbar.js";
import { setLinkPrompt, setTaskCommand } from "./toolbar.js";
import { ACCENTS, applyAccent, tidyAccent, parseAccent } from "./accent.js";
import { makeSharedColorTools, setColorLibrarySaver, refreshSharedColors } from "./sharedcolors.js";
import { ask, askText, closeDialog, dialogOpen, openMenu } from "./ui.js";
import { setPageLinkHost, pageNamesChanged, applyPageLinkSettings, linkIndex } from "./pagelinkview.js";
import { resolveTarget, retarget } from "./pagelinks.js";
import { BOOK_ICONS, bookIcon, iconColor } from "./bookicons.js";
import { applyExpandSettings, setExpandHost } from "./expand.js";

const invoke = window.__TAURI__?.core?.invoke;
const el = (id) => document.getElementById(id);
const status = el("status");
const booksSelect = el("book");
const notesSelect = el("note");
const toolbar = el("mobile-dock");
const fileInput = el("image-file");
const source = el("source");

let books = [];
let selected = null; // { book, name, disk, unreadable }
let currentBook = ""; // the notebook on screen; stays set while it has no pages (selected is null then)
let switching = false; // a page switch is in flight: the old page must not take new edits
let view = null;
let dirty = false;
let saving = null;
let timer = null;
let loading = false;
let busy = false;
let reading = false;
let sorting = false; // 抽屉里正在调整页面顺序(见 setSorting)

const notify = (message) => { status.textContent = message; };
const markdown = () => { syncContent(selected); return selected?.content ?? ""; };
const allowedImage = { "image/jpeg": true, "image/png": true, "image/gif": true, "image/webp": true, "image/bmp": true };

// Desktop folds, styled spans and titled code are handled by the shared editor. Any other raw
// HTML tag cannot be round-tripped by Milkdown, so those notes open as raw Markdown instead of
// risking silent loss. Tags inside code blocks and inline code are plain text, not HTML.
const CODE = /^(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?^\1[^\n]*$|[\s\S]*)|`[^`\n]+`/gm;
// <https://example.com> and <me@example.com> are Markdown autolinks, not HTML.
const AUTOLINK = /<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>]+)>/g;
// A backslash-escaped \< (what the editor writes for a literal <) is text too; an even run of
// backslashes before < escapes only itself, so that < still starts a tag.
const ESCAPED_LT = /(?<!\\)((?:\\\\)*)\\</g;
const needsSource = (md) => /<(?!\/?span\b)[A-Za-z][^>]*>/i.test(md.replace(CODE, "").replace(AUTOLINK, "").replace(ESCAPED_LT, "$1"));

// A failed save keeps the note dirty; flush() retries a few times, from whichever path called it,
// so a brief storage error heals itself.
const RETRY_MS = 5000;
const MAX_RETRIES = 5;
let retries = 0;
function saveSoon(delay) {
  clearTimeout(timer);
  timer = setTimeout(() => { void flush().catch(() => {}); }, delay);
}

function scheduleSave() {
  if (loading || switching || !selected || selected.unreadable || reading) return;
  dirty = true;
  retries = 0;
  notify("尚未保存");
  saveSoon(500);
}

// 笔记本 assets 里的图片按地址读(note 协议,和电脑一样),由 WebView 自己读取、解码,不经过 IPC
class MobileImageView {
  constructor(node) {
    this.dom = document.createElement("img");
    this.dom.addEventListener("error", () => {
      this.dom.classList.add("broken");
      if (this.local) this.dom.title = "找不到本地图片：" + this.path;
    });
    this.dom.addEventListener("load", () => {
      this.dom.classList.remove("broken");
      this.dom.removeAttribute("title");
    });
    this.update(node);
  }

  update(node) {
    if (node.type.name !== "image") return false;
    this.node = node;
    const src = node.attrs.src || "";
    const book = selected?.book ?? "";
    this.dom.alt = node.attrs.alt || "";
    if (this.path === src && this.book === book) return true;
    this.path = src;
    this.book = book;
    this.local = src.startsWith("assets/") || src.startsWith("./assets/");
    this.dom.classList.remove("broken");
    this.dom.removeAttribute("title");
    if (this.local) {
      this.dom.src = imageSrc(src, book);
    } else if (/^https:\/\//i.test(src) || /^data:image\/(?:png|jpeg|webp|gif|bmp);base64,/i.test(src)) {
      this.dom.src = src;
    } else {
      this.dom.removeAttribute("src");
      this.dom.classList.add("broken");
      this.dom.title = "不支持的图片路径";
    }
    return true;
  }

  ignoreMutation() { return true; }
}

const images = $prose(() => new Plugin({
  props: {
    nodeViews: { image: (node) => new MobileImageView(node) },
    handlePaste(v, e) {
      const file = [...(e.clipboardData?.files || [])].find((f) => allowedImage[f.type]);
      if (!file || !v.editable) return false;
      e.preventDefault();
      void insertImage(file);
      return true;
    },
  },
}));

// 选项没变时不重建:页面的选择框每换一页都要更新,几千页时重建很慢
const optionKeys = new WeakMap();
function options(select, pairs, value) {
  const list = JSON.stringify(pairs);
  if (optionKeys.get(select) !== list) {
    optionKeys.set(select, list);
    select.replaceChildren();
    for (const [key, label] of pairs) {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = label;
      select.add(option);
    }
  }
  if (value != null) select.value = value;
}

const drawer = el("mobile-drawer");
const backdrop = el("drawer-backdrop");
function toggleDrawer(open) {
  if (!open && sorting) setSorting(false);
  drawer.hidden = !open;
  backdrop.hidden = !open;
  el("open-drawer").setAttribute("aria-expanded", String(open));
  if (open) {
    renderDrawer();
    el("close-drawer").focus();
  } else {
    el("open-drawer").focus();
  }
}

// 抽屉里显示的东西(笔记本、页面名单、筛选词、界面风格)没变时不重建,只挪当前页的高亮:
// 每换一页都要画两次,几千页时重建一次要几百毫秒
let drawerKey = "";
// 抽屉里每个页面的那一行(按页面名)
const drawerRows = new Map();

function markDrawerPage() {
  const row = drawerRows.get(selected?.name);
  for (const b of el("notes-list").querySelectorAll('[aria-current="page"]')) {
    if (b === row) continue;
    b.classList.remove("active");
    b.setAttribute("aria-current", "false");
  }
  row?.classList.add("active");
  row?.setAttribute("aria-current", "page");
}

function renderDrawer() {
  const bookName = currentBook;
  const book = books.find((b) => b.name === bookName);
  // 语雀纸感:页面列表是目录树,笔记本一行一行排下来,当前笔记本的页面缩进排在它下面
  const tree = look.ui === "paper";
  const key = JSON.stringify([tree, bookName, el("note-filter").value.trim().toLowerCase(), sorting, look.accent,
    books.map((b) => [b.name, b.icon, b.icon_color]), book?.notes.map((n) => n.name)]);
  if (key === drawerKey) return markDrawerPage();
  drawerKey = key;
  drawerRows.clear();
  const bookList = el("books-list");
  const noteList = el("notes-list");
  bookList.replaceChildren();
  noteList.replaceChildren();
  el("pages-heading").textContent = tree ? "目录" : "页面";
  if (tree) {
    for (const b of books) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "tree-book";
      row.classList.toggle("open", b.name === bookName);
      row.setAttribute("aria-expanded", String(b.name === bookName));
      const name = document.createElement("span");
      name.textContent = b.name || "默认笔记本";
      row.append(bookMark(b), name);
      onLongPress(row, () => showBookManager(true, b.name));
      // 点别的笔记本:换过去,抽屉留着,好接着点它的页面
      row.addEventListener("click", () => {
        if (b.name !== currentBook) void refresh(b.name, null);
        else toggleDrawer(false);
      });
      noteList.append(row);
      if (b.name === bookName) noteList.append(...pageButtons(book, bookName, "tree-page"));
    }
    return;
  }
  for (const b of books) {
    const button = document.createElement("button");
    button.type = "button";
    button.classList.toggle("active", b.name === bookName);
    button.setAttribute("aria-current", b.name === bookName ? "true" : "false");
    const name = document.createElement("span");
    name.textContent = b.name || "默认笔记本";
    button.append(bookMark(b), name);
    onLongPress(button, () => showBookManager(true, b.name));
    button.addEventListener("click", async () => {
      // Tapping the notebook already on screen just closes the list; the open page stays.
      if (b.name !== currentBook) await refresh(b.name, null);
      if (currentBook === b.name) toggleDrawer(false);
    });
    bookList.append(button);
  }
  noteList.append(...pageButtons(book, bookName, ""));
}

// 笔记本的图标(和电脑版同一套图形和颜色),跟随强调色时用手机上选的强调色
function bookMark(b) {
  const mark = document.createElement("span");
  mark.className = "book-mark";
  mark.innerHTML = bookIcon(b.icon, b.icon_color || look.accent);
  mark.style.color = iconColor(b);
  return mark;
}

// 当前笔记本里和搜索框对得上的页面;排序时每行右边有拖动的把手,点了不打开
function pageButtons(book, bookName, className) {
  const query = sorting ? "" : el("note-filter").value.trim().toLowerCase();
  const notes = (book?.notes || []).filter((n) => n.name.toLowerCase().includes(query));
  const out = [];
  for (const n of notes) {
    const button = document.createElement("button");
    button.className = className;
    button.type = "button";
    button.dataset.page = n.name;
    button.classList.toggle("active", selected?.name === n.name);
    button.setAttribute("aria-current", selected?.name === n.name ? "page" : "false");
    const name = document.createElement("span");
    name.textContent = n.name;
    button.append(name);
    if (sorting) {
      const handle = document.createElement("span");
      handle.className = "drag-handle";
      handle.textContent = "⠿";
      handle.setAttribute("aria-hidden", "true");
      handle.addEventListener("pointerdown", (e) => dragPage(e, button));
      button.append(handle);
    }
    onLongPress(button, (at) => pageMenu(bookName, n.name, at));
    button.addEventListener("click", async () => {
      if (sorting) return;
      await refresh(bookName, n.name);
      if (selected?.name === n.name && selected?.book === bookName) toggleDrawer(false);
    });
    drawerRows.set(n.name, button);
    out.push(button);
  }
  if (!notes.length) {
    const empty = document.createElement("p");
    empty.className = "drawer-empty";
    empty.textContent = "当前没有匹配的页面";
    out.push(empty);
  }
  return out;
}

function render() {
  const bookName = currentBook;
  const book = books.find((b) => b.name === bookName);
  options(booksSelect, books.map((b) => [b.name, b.name || "默认"]), bookName);
  options(notesSelect, (book?.notes || []).map((n) => [n.name, n.name]), selected?.name);
  el("book-title").replaceChildren(document.createTextNode(book?.name || "默认笔记本"), (() => {
    const arrow = document.createElement("span");
    arrow.textContent = "⌄";
    return arrow;
  })());
  el("page-title").textContent = selected?.name || "空笔记本";
  renderDrawer();
  renderBookManager();
  // While another page loads the editor is read-only, but the toolbar stays put (it only goes
  // inert) so it does not flicker on every page switch.
  const canEdit = !!selected && !selected.unreadable && !reading;
  const editable = canEdit && !switching;
  const raw = !!selected?.sourceOnly;
  if (view) view.setProps({ editable: () => editable && !raw });
  el("editor").hidden = raw;
  source.hidden = !raw;
  source.readOnly = !editable;
  el("mode").disabled = !selected || selected.unreadable;
  el("mode").textContent = reading ? "编辑" : "阅读";
  el("mode").setAttribute("aria-pressed", String(reading));
  for (const b of el("mode-seg").children) {
    b.disabled = el("mode").disabled;
    b.setAttribute("aria-pressed", String((b.dataset.mode === "read") === reading));
  }
  toolbar.hidden = !canEdit || raw;
  toolbar.inert = switching;
  el("add-note").disabled = !book || switching;
  fab.disabled = el("add-note").disabled;
  el("delete-note").disabled = !selected || switching;
  el("insert-image").disabled = !canEdit || raw;
  el("find-open").disabled = !selected || raw;
  el("block-actions").disabled = !canEdit || raw;
  el("hint").textContent = selected?.unreadable ? "文件内容无法识别，仅允许查看" :
    !selected ? "这个笔记本还没有页面，点列表里的「＋ 新建」添加" :
    raw ? "该笔记包含无法富文本编辑的 HTML，使用保真源码模式" :
      reading ? "阅读模式" : "本地自动保存 · 支持图片和 Markdown";
}

async function flush() {
  clearTimeout(timer);
  if (saving) await saving;
  while (dirty && selected) {
    const note = selected;
    const content = note.sourceOnly ? source.value : markdown();
    dirty = false;
    notify("保存中…");
    saving = invoke("mobile_save_note", {
      book: note.book, name: note.name, content, expected: note.disk,
    });
    try {
      const result = await saving;
      note.disk = content;
      retries = 0;
      notify(result?.conflict_name ? "已保存，产生冲突副本" : "已保存");
      scheduleMobileSync();
      if (result?.conflict_name) await showNewPages();
    } catch (error) {
      dirty = true;
      notify("保存失败：" + error);
      if (++retries <= MAX_RETRIES) saveSoon(RETRY_MS);
      throw error;
    } finally {
      saving = null;
    }
  }
}

// Only names are listed; just the opened page is read, so many pages stay cheap to switch.
async function listBooks() {
  return (await invoke("mobile_list_books")).map((b) => ({
    name: b.name, notes: b.notes.map((name) => ({ name })), icon: b.icon || "", icon_color: b.icon_color || "",
  }));
}

// A conflict copy is a new page: show it in the lists without leaving the page being edited.
async function showNewPages() {
  try {
    books = await listBooks();
    pageNamesChanged();
    render();
  } catch { /* the next page switch lists them again */ }
}

let queued = null; // the latest request made while a switch was in flight
// Leaving an argument out (undefined) means "what is on screen", decided when the request runs;
// null means "the first page / first notebook".
async function refresh(bookName, noteName) {
  if (busy) {
    queued?.done();
    return new Promise((done) => { queued = { bookName, noteName, done }; });
  }
  busy = true;
  if (bookName === undefined) bookName = currentBook;
  if (noteName === undefined) noteName = selected?.name;
  try {
    await flush();
    // Nothing typed while the new page loads may land on the old page or be lost.
    switching = true;
    render();
    const loaded = await listBooks();
    const book = loaded.find((b) => b.name === bookName) || loaded[0];
    const noteInfo = book?.notes.find((n) => n.name === noteName) || book?.notes[0];
    const note = noteInfo && await invoke("mobile_read_note", { book: book.name, name: noteInfo.name });
    books = loaded;
    currentBook = book?.name ?? "";
    pageNamesChanged();
    selected = note ? {
      book: book.name, name: noteInfo.name, content: note.content, disk: note.content,
      unreadable: note.unreadable, sourceOnly: needsSource(note.content),
      state: null, mdStale: false, scroll: 0,
    } : null;
    source.value = note?.content ?? "";
    loading = true;
    // An empty notebook shows an empty page instead of the previous page's text.
    if (!selected) showInEditor({ content: "", state: null, scroll: 0 });
    else if (!selected.sourceOnly) showInEditor(selected);
    loading = false;
    switching = false;
    render();
    notify(note?.unreadable ? "只读：原始文件不可安全解码" : "已保存");
    el("page").scrollTop = 0;
  } catch (error) {
    loading = false;
    switching = false;
    render();
    notify("无法切换：" + error);
  } finally {
    busy = false;
  }
  if (queued) {
    const next = queued;
    queued = null;
    await refresh(next.bookName, next.noteName);
    next.done();
  }
}

// Preserve a rich text selection when the touch toolbar is pressed.
toolbar.addEventListener("pointerdown", (event) => {
  if (event.target.closest("button")) event.preventDefault();
});

function dataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

async function insertImage(file) {
  if (!selected || selected.unreadable || reading) return;
  if (!allowedImage[file.type] || file.size > 10 * 1024 * 1024 || !file.size) {
    notify("仅支持 PNG、JPG、GIF、WebP、BMP，且不超过 10 MB");
    return;
  }
  const note = selected;
  try {
    // Existing edits are committed before storing an attachment.
    await flush();
    const data = await dataURL(file);
    const src = await invoke("mobile_save_image", { book: note.book, mime: file.type, data });
    if (selected !== note || reading) return;
    const alt = (file.name || "").replace(/\.[^.]+$/, "").slice(0, 100);
    const image = view.state.schema.nodes.image.create({ src, alt });
    view.dispatch(view.state.tr.replaceSelectionWith(image).scrollIntoView());
    view.focus();
    notify("图片已插入");
  } catch (error) {
    notify("图片插入失败：" + error);
  }
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (file) void insertImage(file);
});
source.addEventListener("input", scheduleSave);
el("open-drawer").addEventListener("click", () => toggleDrawer(true));
el("book-title").addEventListener("click", () => toggleDrawer(true));
el("close-drawer").addEventListener("click", () => toggleDrawer(false));
backdrop.addEventListener("click", () => toggleDrawer(false));
el("note-filter").addEventListener("input", renderDrawer);
document.addEventListener("keydown", (e) => {
  // 输入法正在拼字时按的回车、Esc 是给输入法的
  if (e.isComposing || e.keyCode === 229) return;
  if (dialogOpen()) {
    if (e.key === "Escape" || e.key === "Enter") {
      e.preventDefault();
      // 焦点在「取消」上时按回车也是取消
      closeDialog(e.key === "Enter" && e.target !== el("dialog-cancel"));
    }
    return;
  }
  if (e.key === "Escape" && !settingsSheet.hidden) showSettings(false);
  else if (e.key === "Escape" && !drawer.hidden) toggleDrawer(false);
});
// 应用内对话框(代替系统的 prompt / confirm)。按按钮时不抢走输入框的焦点:
// 键盘留到对话框关掉才收起,对话框不会在手指按下和抬起之间跟着键盘挪位置
el("dialog").addEventListener("pointerdown", (e) => { if (e.target.closest("button")) e.preventDefault(); });
el("dialog-ok").addEventListener("click", () => closeDialog(true));
el("dialog-cancel").addEventListener("click", () => closeDialog(false));
el("dialog").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeDialog(false); });
// 链接交给系统浏览器(或应用内浏览器)、邮件和电话应用打开,应用自己的页面不跳走
async function openLink(href) {
  const url = (href || "").trim();
  if (!/^(https?:|mailto:|tel:)/i.test(url)) {
    notify("这个链接不能在手机上打开");
    return;
  }
  try {
    await invoke("mobile_open_url", { url, inApp: look.link_open === "inapp" });
  } catch (error) {
    notify("打不开链接：" + error);
  }
}
// 不能编辑时(阅读模式、只读页面)点链接就打开;编辑时默认只放光标,外观设置里可以改成也打开。
// Ctrl / ⌘ + 点击(接了实体键盘时)由编辑器自己交给 openLink
el("editor").addEventListener("click", (e) => {
  const link = e.target.closest?.("a[href]");
  if (!link || e.ctrlKey || e.metaKey) return;
  e.preventDefault();
  if (view?.editable && !look.link_tap_edit) return;
  void openLink(link.getAttribute("href"));
}, true);
// 页面链接 [[页面名]](0.5.0):名单就是抽屉里的页面名单;点了换到那一页,还没有的页面先新建
setPageLinkHost({
  home: () => (selected ? currentBook : null),
  books: () => books.map((b) => ({ name: b.name, pages: b.notes.map((n) => n.name) })),
  // 补全没打字时:当前笔记本的页面在前,当前页面不列
  candidates: () => [...books.filter((b) => b.name === currentBook), ...books.filter((b) => b.name !== currentBook)]
    .flatMap((b) => b.notes.filter((n) => b.name !== currentBook || n.name !== selected?.name).map((n) => ({ book: b.name, name: n.name }))),
  open: (target) => void openPageLink(target),
});
async function openPageLink(target) {
  const r = resolveTarget(linkIndex(), target, currentBook);
  if (r.book == null) return notify(`没有「${r.bookLabel}」这个笔记本`);
  if (r.exists) return refresh(r.book, r.page);
  try {
    await flush();
    await refresh(r.book, await invoke("mobile_create_note", { book: r.book, name: r.page }));
  } catch (error) { notify("新建页面失败：" + error); }
}
el("insert-image").addEventListener("click", () => {
  if (view?.editable && selected && !selected.sourceOnly) fileInput.click();
});
const findPanel = el("find-panel");
const findInput = el("find-input");
const replaceInput = el("replace-input");
let findIndex = -1;
function findHits() {
  if (!view || !findInput.value) return [];
  const query = findInput.value.toLowerCase();
  const matches = [];
  view.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = "";
    const positions = [];
    node.forEach((child, offset) => {
      const part = child.isText ? child.text : child.type.name === "hardbreak" ? "\n" : "\uFFFC";
      for (let i = 0; i < part.length; i++) positions.push(pos + 1 + offset + (child.isText ? i : 0));
      text += part;
    });
    const lower = text.toLowerCase();
    for (let i = lower.indexOf(query); i >= 0; i = lower.indexOf(query, i + query.length))
      matches.push({ from: positions[i], to: positions[i + query.length - 1] + 1 });
    return false;
  });
  return matches;
}
function showFind(open) {
  findPanel.hidden = !open;
  if (open) findInput.focus();
  else view?.focus();
}
function navigateFind(delta = 1) {
  const hits = findHits();
  if (!hits.length) { el("find-count").textContent = "没有匹配的内容"; return; }
  findIndex = (findIndex + delta + hits.length) % hits.length;
  const hit = hits[findIndex];
  view.dispatch(view.state.tr.setSelection(
    TextSelection.create(view.state.doc, hit.from, hit.to)
  ).scrollIntoView());
  el("find-count").textContent = `${findIndex + 1} / ${hits.length}`;
}
function replaceFound(all) {
  if (!view?.editable || !findInput.value) return;
  const hits = findHits();
  if (!hits.length) return;
  const chosen = all ? hits : [hits[findIndex < 0 ? 0 : Math.min(findIndex, hits.length - 1)]];
  const tr = view.state.tr;
  for (const hit of chosen.slice().reverse()) tr.insertText(replaceInput.value, hit.from, hit.to);
  view.dispatch(tr.scrollIntoView());
  findIndex = -1;
  el("find-count").textContent = `已替换 ${chosen.length} 处`;
}
el("find-open").addEventListener("click", () => showFind(findPanel.hidden));
el("find-close").addEventListener("click", () => showFind(false));
findInput.addEventListener("input", () => {
  findIndex = -1;
  el("find-count").textContent = `找到 ${findHits().length} 处`;
});
el("find-next").addEventListener("click", () => navigateFind(1));
el("find-prev").addEventListener("click", () => navigateFind(-1));
el("replace-one").addEventListener("click", () => replaceFound(false));
el("replace-all").addEventListener("click", () => replaceFound(true));
el("block-actions").addEventListener("pointerdown", (e) => e.preventDefault());
el("block-actions").addEventListener("click", () => {
  if (!view?.editable) return;
  const point = view.domAtPos(view.state.selection.from);
  const target = point.node.nodeType === 3 ? point.node.parentElement : point.node;
  const element = target?.nodeType === 1 ? target : target?.parentElement;
  if (!element?.getBoundingClientRect) return;
  const rect = element.getBoundingClientRect();
  element.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, clientX: rect.left + 5,
    clientY: Math.min(window.innerHeight - 340, rect.bottom + 6),
  }));
});
booksSelect.addEventListener("change", () => { void refresh(booksSelect.value, null); });
notesSelect.addEventListener("change", () => { void refresh(currentBook, notesSelect.value); });

el("add-book").addEventListener("click", async () => {
  try { await createBook(); } catch (error) { notify("新建笔记本失败：" + error); }
});

el("add-note").addEventListener("click", async () => {
  const name = await askText("新页面名称", "", "新建");
  if (!name?.trim()) return;
  try {
    await flush();
    const book = currentBook;
    const created = await invoke("mobile_create_note", { book, name: name.trim() });
    await refresh(book, created);
  } catch (error) { notify("新建页面失败：" + error); }
});

el("delete-note").addEventListener("click", () => { if (selected) void deletePage(selected.book, selected.name); });

// 删掉的是正在看的页面就打开相邻的一页,别的页面只从名单里拿掉,正在编辑的这页不动
async function deletePage(book, name) {
  if (switching || busy) return;
  if (!(await ask("删除页面「" + name + "」？它会移到回收站（笔记文件夹的 .trash），同步开着时网盘上的那份也会移进网盘的 .trash。", "删除", true))) return;
  try {
    await flush();
    const open = selected?.book === book && selected?.name === name;
    const pages = books.find((b) => b.name === book)?.notes || [];
    const at = pages.findIndex((n) => n.name === name);
    const next = pages[at + 1] ?? pages[at - 1];
    await invoke("mobile_delete_note", { book, name });
    if (open) await refresh(book, next?.name ?? null);
    else await showNewPages();
    notify("已删除页面「" + name + "」");
    scheduleMobileSync();
  } catch (error) { notify("删除失败：" + error); }
}

// ---- 长按(0.5.2):页面弹出菜单(删除、调整顺序),笔记本打开笔记本管理。手指挪开就是在滚动列表,不算长按 ----
const LONG_PRESS_MS = 500;
function onLongPress(target, act) {
  let timer = 0;
  let start = null;
  let fired = false;
  const cancel = () => { clearTimeout(timer); timer = 0; };
  const fire = (at) => { cancel(); fired = true; act(at); };
  target.addEventListener("pointerdown", (e) => {
    fired = false;
    cancel();
    if (e.button !== 0 || sorting) return;
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => fire(start), LONG_PRESS_MS);
  });
  target.addEventListener("pointermove", (e) => {
    if (timer && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) target.addEventListener(type, cancel);
  // 安卓的 WebView 长按时还会发 contextmenu(不弹系统菜单):先到的那个算数
  target.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!fired && !sorting) fire({ x: e.clientX, y: e.clientY });
  });
  // 长按以后松手的那一下不算点击
  target.addEventListener("click", (e) => {
    if (!fired) return;
    fired = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
}

function pageMenu(book, name, at) {
  navigator.vibrate?.(15);
  openMenu([
    { id: "open", label: "打开", act: () => { void refresh(book, name).then(() => toggleDrawer(false)); } },
    { id: "sort", label: "调整顺序", act: () => setSorting(true) },
    { id: "delete", label: "删除页面", danger: true, act: () => void deletePage(book, name) },
  ], at.x, at.y);
}

// ---- 页面排序(0.5.2):按住每行右边的把手上下拖,松手就存进笔记本的 .minipad.json(和电脑版标签的顺序是同一份,会同步) ----
function setSorting(on) {
  sorting = on;
  const button = el("sort-notes");
  button.textContent = on ? "完成" : "排序";
  button.setAttribute("aria-pressed", String(on));
  el("sort-hint").hidden = !on;
  drawer.classList.toggle("sorting", on);
  if (on) el("note-filter").value = "";
  el("note-filter").disabled = on;
  drawerKey = "";
  if (!drawer.hidden) renderDrawer();
}
el("sort-notes").addEventListener("click", () => setSorting(!sorting));

function dragPage(e, row) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const list = el("notes-list");
  const pageRows = () => [...list.querySelectorAll("button[data-page]")];
  const before = pageRows().map((r) => r.dataset.page);
  const pointer = e.pointerId;
  row.classList.add("dragging");
  // 跟着手指挪的是这一行本身;挪动 DOM 会丢掉指针捕获,所以在 window 上听
  const move = (ev) => {
    if (ev.pointerId !== pointer) return;
    const others = pageRows().filter((r) => r !== row);
    const next = others.find((r) => { const b = r.getBoundingClientRect(); return ev.clientY < b.top + b.height / 2; });
    if (next) { if (row.nextElementSibling !== next) list.insertBefore(row, next); }
    else if (others.length && others.at(-1).nextElementSibling !== row) others.at(-1).after(row);
    // 拖到抽屉的上下边缘时跟着滚
    const box = drawer.getBoundingClientRect();
    if (ev.clientY < box.top + 48) drawer.scrollTop -= 12;
    else if (ev.clientY > box.bottom - 48) drawer.scrollTop += 12;
  };
  const end = (ev) => {
    if (ev.pointerId !== pointer) return;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    row.classList.remove("dragging");
    const order = pageRows().map((r) => r.dataset.page);
    if (order.join("\n") !== before.join("\n")) void savePageOrder(order);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

async function savePageOrder(order) {
  const book = currentBook;
  try {
    await invoke("mobile_set_page_order", { book, order });
    const b = books.find((x) => x.name === book);
    if (b) b.notes = order.map((name) => b.notes.find((n) => n.name === name) || { name });
    pageNamesChanged();
    render();
    scheduleMobileSync();
  } catch (error) {
    notify("保存顺序失败：" + error);
    drawerKey = "";
    renderDrawer();
  }
}

// ---- 笔记本管理(0.5.2,和电脑版的「笔记本管理」一样):图标、颜色、改名、删除、新建 ----
const booksSheet = el("mobile-books");
const booksBackdrop = el("books-backdrop");
const bookLabel = (name) => name || "默认笔记本";
let managed = ""; // 管理页里选中的笔记本
let appearanceBusy = false;

function showBookManager(open, name = currentBook) {
  booksSheet.hidden = !open;
  booksBackdrop.hidden = !open;
  if (!open) return;
  managed = name;
  if (!drawer.hidden) toggleDrawer(false);
  el("mb-error").hidden = true;
  notebookColors.reopen();
  renderBookManager();
  el("close-books").focus();
}
el("manage-books").addEventListener("click", () => showBookManager(true));
el("close-books").addEventListener("click", () => showBookManager(false));
booksBackdrop.addEventListener("click", () => showBookManager(false));

function bookError(text) {
  el("mb-error").textContent = text;
  el("mb-error").hidden = !text;
}

function renderBookManager() {
  if (el("mobile-books").hidden) return;
  // 名单正在重新读(比如刚改完名)时选中的那个可能暂时不在里面:先显示当前笔记本,不改 managed
  const b = books.find((x) => x.name === managed) || books.find((x) => x.name === currentBook) || books[0];
  const list = el("mb-list");
  list.replaceChildren();
  for (const x of books) {
    const row = document.createElement("button");
    row.type = "button";
    row.dataset.book = x.name;
    row.setAttribute("role", "radio");
    row.setAttribute("aria-checked", String(x === b));
    const name = document.createElement("span");
    name.className = "mb-name";
    name.textContent = bookLabel(x.name);
    const count = document.createElement("span");
    count.className = "mb-count";
    count.textContent = String(x.notes.length);
    row.append(bookMark(x), name, count);
    row.addEventListener("click", () => { managed = x.name; bookError(""); renderBookManager(); });
    list.append(row);
  }
  if (!b) return;
  el("mb-selected").textContent = bookLabel(b.name);
  el("mb-rename").disabled = !b.name || appearanceBusy;
  el("mb-delete").disabled = !b.name || appearanceBusy;
  const icons = el("mb-icons");
  icons.replaceChildren();
  for (const [id, label] of BOOK_ICONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.title = label;
    button.dataset.icon = id;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-checked", String((b.icon || "book") === id));
    button.disabled = appearanceBusy;
    button.innerHTML = bookIcon(id, b.icon_color || look.accent);
    button.style.color = iconColor(b);
    button.addEventListener("click", () => void saveAppearance(b.name, id, b.icon_color));
    icons.append(button);
  }
  followBookAccent.setAttribute("aria-checked", String(!b.icon_color));
  followBookAccent.disabled = appearanceBusy;
  notebookColors.sync();
}

// 颜色:「跟随强调色」加上共用的颜色库(纯色、渐变、材质),和电脑版一样
const followBookAccent = document.createElement("button");
followBookAccent.type = "button";
followBookAccent.dataset.color = "";
followBookAccent.title = "跟随强调色";
followBookAccent.setAttribute("role", "radio");
followBookAccent.setAttribute("aria-label", "跟随强调色");
followBookAccent.style.setProperty("--sw", "var(--accent)");
const managedBook = () => books.find((x) => x.name === managed) || books.find((x) => x.name === currentBook);
followBookAccent.addEventListener("click", () => {
  const b = managedBook();
  if (b) void saveAppearance(b.name, b.icon || "book", "");
});
const followBookLabel = document.createElement("span");
followBookLabel.className = "mb-follow";
followBookLabel.textContent = "跟随强调色";
el("mb-colors").append(followBookAccent, followBookLabel);
const notebookColors = makeSharedColorTools({
  id: "mobile-notebook",
  getValue: () => managedBook()?.icon_color || getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
  onApply: (value) => {
    const b = managedBook();
    if (b) void saveAppearance(b.name, b.icon || "book", value);
  },
  compact: true,
});
el("mb-colors").closest(".sync-field").after(notebookColors.root);

async function saveAppearance(name, icon, color) {
  const b = books.find((x) => x.name === name);
  color = tidyAccent(color || "");
  if (!b || appearanceBusy || ((b.icon || "book") === icon && (b.icon_color || "") === color)) return;
  appearanceBusy = true;
  bookError("");
  try {
    await invoke("mobile_set_book_appearance", { book: name, icon, color });
    b.icon = icon === "book" ? "" : icon;
    b.icon_color = color;
    scheduleMobileSync();
  } catch (error) {
    bookError("保存图标失败：" + error);
  } finally {
    appearanceBusy = false;
    renderBookManager();
    renderDrawer();
  }
}

async function createBook() {
  const name = await askText("新笔记本名称", "", "新建");
  if (!name?.trim()) return null;
  await flush();
  const created = await invoke("mobile_create_book", { name: name.trim() });
  await refresh(created, null);
  return created;
}

el("mb-new").addEventListener("click", async () => {
  try {
    const created = await createBook();
    if (created != null) { managed = created; renderBookManager(); }
  } catch (error) { bookError("新建笔记本失败：" + error); }
});

el("mb-rename").addEventListener("click", () => void renameBook(managedBook()?.name));
el("mb-delete").addEventListener("click", () => void deleteBook(managedBook()?.name));

async function renameBook(old) {
  if (!old) return;
  const wanted = (await askText("笔记本的新名字", old, "改名"))?.trim();
  if (!wanted || wanted === old) return;
  bookError("");
  try {
    await flush();
    const renamed = await invoke("mobile_rename_book", { old, new: wanted });
    if (selected?.book === old) selected.book = renamed;
    if (currentBook === old) currentBook = renamed;
    managed = renamed;
    // 别的页面里写了「旧名/页面」的链接跟着改(用改名前的名单算)
    const changed = await updateBookLinks(old, renamed);
    await refresh(currentBook, selected?.name);
    notify(`笔记本已改名为「${renamed}」` + (changed ? `，更新了 ${changed} 个页面里的链接` : ""));
    scheduleMobileSync();
  } catch (error) {
    bookError("改名失败：" + error);
  }
  renderBookManager();
}

// 和电脑版一样:改 2 个以上页面时先问一下。只读有 [[ 的页面,不把每一页都读一遍
async function updateBookLinks(old, renamed) {
  if (!look.page_links) return 0;
  const index = linkIndex(); // 还是改名前的名单
  const edits = [];
  for (const [book, name] of await invoke("mobile_link_pages")) {
    const page = await invoke("mobile_read_note", { book, name });
    if (page.unreadable) continue;
    const home = { book: book === renamed ? old : book, page: name };
    const after = retarget(page.content, home, index, { book: [old, renamed] });
    if (after !== page.content) edits.push({ book, name, before: page.content, after });
  }
  if (!edits.length) return 0;
  if (edits.length >= 2) {
    const names = edits.slice(0, 8).map((e) => `「${e.name}」`).join("、") + (edits.length > 8 ? ` 等 ${edits.length} 个页面` : "");
    if (!(await ask(`有 ${edits.length} 个页面里有指向这个笔记本的链接：${names}\n要同时更新这些链接吗？`, "更新链接"))) return 0;
  }
  let done = 0;
  for (const e of edits) {
    try {
      await invoke("mobile_save_note", { book: e.book, name: e.name, content: e.after, expected: e.before });
      done++;
    } catch { /* 那一页刚被别处改过:不动它 */ }
  }
  return done;
}

async function deleteBook(name) {
  const b = books.find((x) => x.name === name);
  if (!b?.name) return;
  const count = b.notes.length;
  if (!(await ask(`删除笔记本「${name}」${count ? `和里面的 ${count} 个页面` : ""}？\n笔记本会移到回收站（笔记文件夹的 .trash），电脑上的回收站里可以恢复。`, "删除", true))) return;
  bookError("");
  try {
    await flush();
    await invoke("mobile_delete_book", { name });
    managed = currentBook === name ? "" : currentBook;
    if (currentBook === name) await refresh("", null);
    else await showNewPages();
    notify(`已删除笔记本「${name}」`);
    scheduleMobileSync();
  } catch (error) {
    bookError("删除失败：" + error);
  }
  renderBookManager();
}

async function toggleMode() {
  if (!reading) {
    try { await flush(); } catch { return; }
  }
  reading = !reading;
  render();
  if (!reading) (selected?.sourceOnly ? source : view).focus();
}
el("mode").addEventListener("click", toggleMode);
// 星空渐变的「阅读 | 编辑」分段:点已经选中的那一边不动
for (const b of el("mode-seg").children) {
  b.addEventListener("click", () => { if ((b.dataset.mode === "read") !== reading) void toggleMode(); });
}
// 收起键盘:编辑区失去焦点,键盘就收起来了
el("hide-keyboard").addEventListener("click", () => document.activeElement?.blur?.());
// 星空渐变的分类工具栏:文字 / 段落 / 插入 / 颜色,格式栏只显示这一类的按钮
for (const b of el("dock-cats").children) {
  b.addEventListener("click", () => {
    toolbar.dataset.cat = b.dataset.cat;
    for (const x of el("dock-cats").children) x.setAttribute("aria-selected", String(x === b));
  });
}
toolbar.dataset.cat = "text";
el("refresh").addEventListener("click", () => {
  if (syncSettings.enabled) void mobileSync();
  else void refresh();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) void flush().catch(() => {});
});

// 颜色库（纯色、渐变、材质和快捷色）和电脑版是同一套界面。存在笔记文件夹的 .minipad-colors.json 里，
// 通过 WebDAV 和电脑共用一份；手机上另存一份，读不到那个文件时用。
const COLOR_KEY = "minipad-mobile-colors";
const COLORS_FILE = ".minipad-colors.json";
const COLOR_FIELDS = ["color_library", "material_library", "quick_colors", "color_library_rev"];
const colorsOf = (source) => ({
  ...Object.fromEntries(COLOR_FIELDS.map((key) => [key, source?.[key] ?? null])),
  color_library_rev: Number(source?.color_library_rev) || 0,
});
function loadColors() {
  try {
    const saved = JSON.parse(localStorage.getItem(COLOR_KEY) || "{}") || {};
    return Object.fromEntries(COLOR_FIELDS.filter((key) => key in saved).map((key) => [key, saved[key]]));
  } catch { return {}; }
}
function keepColors(colors) {
  try { localStorage.setItem(COLOR_KEY, JSON.stringify(colors)); } catch { /* 存不了就只在这次运行里用 */ }
  desktopState.settings = { ...desktopState.settings, ...colors };
}
async function writeSharedColors(colors) {
  try {
    if (await invoke("mobile_write_colors", { colors })) scheduleMobileSync();
  } catch (error) {
    notify("颜色库没能存进笔记文件夹：" + error);
  }
}
desktopState.settings = loadColors();
setColorLibrarySaver(async (next) => {
  const colors = colorsOf(next);
  keepColors(colors);
  await writeSharedColors(colors);
});
// 笔记文件夹里有颜色库（电脑上改的、同步下来的）就换上；没有而这台手机改过颜色库，就把自己的写进去。
async function adoptSharedColors() {
  let shared;
  try { shared = await invoke("mobile_read_colors"); } catch { return; }
  const mine = colorsOf(desktopState.settings);
  if (!shared) {
    if (["color_library", "material_library", "quick_colors"].some((key) => Array.isArray(mine[key]))) await writeSharedColors(mine);
    return;
  }
  if (JSON.stringify(colorsOf(shared)) === JSON.stringify(mine)) return;
  keepColors(colorsOf(shared));
  refreshSharedColors();
}

// WebDAV 同步配置只存手机外观以外的本地设置，密码由 Rust 私有存储保管。
const SYNC_KEY = "minipad-mobile-webdav";
const syncDefaults = {
  enabled: false, server: "", user: "", folder: "/MinipadNext/",
  allow_http: false, images: true, first_mode: "merge",
  on_start: true, after_save: true, delay: 30, interval: 5,
  on_hide: true, display: "icon", status_color: "",
  delete_limit: 20, delete_divisor: 3,
};
let syncSettings = (() => {
  try { return { ...syncDefaults, ...JSON.parse(localStorage.getItem(SYNC_KEY) || "{}") }; }
  catch { return { ...syncDefaults }; }
})();
let syncing = null;
let syncQueued = false;
let syncTimer = null;
let syncDelay = null;
function updateSyncForm() {
  for (const [id, value] of Object.entries({
    "ms-enable": syncSettings.enabled, "ms-server": syncSettings.server,
    "ms-user": syncSettings.user, "ms-folder": syncSettings.folder,
    "ms-http": syncSettings.allow_http, "ms-first": syncSettings.first_mode,
    "ms-images": syncSettings.images, "ms-start": syncSettings.on_start,
    "ms-save": syncSettings.after_save, "ms-delay": syncSettings.delay,
    "ms-interval": syncSettings.interval, "ms-hide": syncSettings.on_hide,
    "ms-display": syncSettings.display,
    "ms-delete-limit": syncSettings.delete_limit,
    "ms-delete-divisor": syncSettings.delete_divisor,
  })) {
    if (el(id).type === "checkbox") el(id).checked = value;
    else el(id).value = String(value);
  }
  el("ms-password").value = "";
  showSyncColor(syncSettings.status_color || "");
}
function readSyncForm() {
  return {
    enabled: el("ms-enable").checked,
    server: el("ms-server").value.trim(),
    user: el("ms-user").value.trim(),
    folder: el("ms-folder").value.trim() || "/MinipadNext/",
    allow_http: el("ms-http").checked,
    first_mode: el("ms-first").value,
    images: el("ms-images").checked,
    on_start: el("ms-start").checked,
    after_save: el("ms-save").checked,
    delay: Math.min(300, Math.max(10, Number(el("ms-delay").value) || 30)),
    interval: Number(el("ms-interval").value),
    on_hide: el("ms-hide").checked,
    display: el("ms-display").value,
    status_color: el("ms-color").dataset.selected || "",
    delete_limit: Math.max(1, Math.min(1000, Math.round(Number(el("ms-delete-limit").value) || 20))),
    delete_divisor: Math.max(1, Math.min(10, Math.round(Number(el("ms-delete-divisor").value) || 3))),
  };
}
async function saveSyncForm() {
  const config = readSyncForm();
  if (el("ms-password").value) {
    await invoke("mobile_webdav_set_password", { config, password: el("ms-password").value });
    el("ms-password").value = "";
  }
  syncSettings = config;
  localStorage.setItem(SYNC_KEY, JSON.stringify(config));
  updateSyncTimers();
  await showSyncStatus();
  el("ms-result").textContent = "同步设置已保存";
}
const SYNC_LABELS = { synced: "已同步", syncing: "同步中", conflict: "有冲突", offline: "离线", error: "出错", confirm: "需要确认", off: "未同步" };
const SYNC_SYMBOLS = { synced: "✓", syncing: "⟳", conflict: "!", offline: "○", error: "!", confirm: "?", off: "○" };
// 同步状态就显示在右下角的同步按钮上(同步开着时点它就是立即同步):同步时图标转,同步完角上的小圆点
// 弹一下显示结果(✓ ! ? ○),「图标和文字」时按钮左边再写上一句。跟随 同步设置 → 状态显示 和状态颜色
const SYNC_MARKS = { synced: "✓", conflict: "!", offline: "○", error: "!", confirm: "?", off: "○" };
let shownSync = "";
function showSyncBadge(kind) {
  const button = el("refresh");
  const label = el("sync-label");
  const mark = el("sync-mark");
  const on = syncSettings.enabled && syncSettings.display !== "none";
  const k = SYNC_LABELS[kind] ? kind : "off";
  if (!on) {
    delete button.dataset.sync;
    delete label.dataset.sync;
    label.hidden = mark.hidden = true;
    button.setAttribute("aria-label", syncSettings.enabled ? "立即同步" : "重新读取页面");
    button.title = syncSettings.enabled ? "立即同步" : "重新读取";
    shownSync = "";
    return;
  }
  button.dataset.sync = label.dataset.sync = k;
  button.setAttribute("aria-label", "立即同步（" + SYNC_LABELS[k] + "）");
  button.title = "同步：" + SYNC_LABELS[k] + "，点一下立即同步";
  label.hidden = syncSettings.display !== "text";
  label.textContent = SYNC_LABELS[k];
  mark.hidden = k === "syncing";
  mark.textContent = SYNC_MARKS[k] || "";
  // 从「同步中」变成别的状态时圆点弹一下
  if (shownSync === "syncing" && k !== "syncing") {
    mark.classList.remove("pop");
    void mark.offsetWidth;
    mark.classList.add("pop");
  }
  shownSync = k;
  // 状态颜色:纯色直接用;渐变给图标的线条一个 SVG 渐变,文字用渐变填充
  const color = parseAccent(syncSettings.status_color);
  for (const node of [button, label]) {
    if (color?.from) node.style.setProperty("--sync-color", color.from);
    else node.style.removeProperty("--sync-color");
  }
  const grad = el("sync-grad");
  const stroke = button.querySelector("svg");
  if (color?.to) {
    const stops = color.stops || [color.from, color.to];
    grad.replaceChildren(...stops.map((hex, i) => {
      const stop = document.createElementNS("http://www.w3.org/2000/svg", "stop");
      stop.setAttribute("offset", (color.positions?.[i] ?? (i / (stops.length - 1)) * 100) + "%");
      stop.setAttribute("stop-color", hex);
      return stop;
    }));
    stroke.style.stroke = "url(#sync-grad)";
    label.style.backgroundImage = syncSettings.status_color;
    label.style.webkitBackgroundClip = label.style.backgroundClip = "text";
    label.style.webkitTextFillColor = "transparent";
  } else {
    stroke.style.stroke = "";
    label.style.backgroundImage = label.style.backgroundClip = label.style.webkitBackgroundClip = label.style.webkitTextFillColor = "";
  }
}
async function showSyncStatus() {
  if (!invoke) return;
  try {
    const result = await invoke("mobile_webdav_status");
    const labels = SYNC_LABELS;
    const symbols = SYNC_SYMBOLS;
    const kind = result.state || "off";
    showSyncBadge(kind);
    const icon = symbols[kind] || "○";
    el("mobile-sync-state").textContent = syncSettings.enabled
      ? icon + (syncSettings.display === "text" ? " " + (labels[kind] || "未同步") : "")
      : "同步未开启";
    const color = parseAccent(syncSettings.status_color);
    const syncState = el("mobile-sync-state");
    syncState.style.color = color?.from || "var(--accent)";
    syncState.style.backgroundImage = color?.to ? syncSettings.status_color : "";
    syncState.style.backgroundClip = color?.to ? "text" : "";
    syncState.style.webkitBackgroundClip = color?.to ? "text" : "";
    syncState.style.webkitTextFillColor = color?.to ? "transparent" : "";
    el("mobile-sync-message").textContent = result.message || "尚无同步记录";
    el("ms-history").textContent = (result.history || []).join("\n");
    el("ms-result").textContent = result.message || "";
    el("mobile-sync-state").hidden = syncSettings.enabled && syncSettings.display === "none";
  } catch (e) { el("ms-result").textContent = String(e); }
}
async function performMobileSync(confirmed) {
  try {
    await flush();
    showSyncBadge("syncing");
    const result = await invoke("mobile_webdav_sync_now", { config: syncSettings, confirmDeletes: confirmed });
    if (result?.rescan_needed) scheduleMobileSync(true);
    await showSyncStatus();
    // 有尚未保存的输入时保持原状态；下次保存会按 expected 留冲突副本。
    // webdav-changed 监听器统一刷新，避免同一次下载重复加载页面。
    return result;
  } catch (e) {
    const text = String(e);
    if (text.includes("WEB_DAV_CONFIRM_DELETE:")) {
      const match = /WEB_DAV_CONFIRM_DELETE:(\d+):(\d+):(\d+):(\d+)/.exec(text);
      const where = "手机 " + (match?.[3] || 0) + " 页移进回收站，网盘 " + (match?.[4] || 0) + " 页移进 .trash。";
      if (await ask("同步涉及大量删除：" + where + "确定继续吗？取消后不会删除任何文件。", "继续同步", true)) {
        return performMobileSync(true);
      }
    } else if (!text.includes("离线")) {
      el("ms-result").textContent = text;
    }
    await showSyncStatus();
  }
}

async function mobileSync(confirmed = false) {
  if (!syncSettings.enabled || !invoke) return;
  if (syncing) {
    syncQueued = true;
    return syncing;
  }
  syncing = (async () => {
    do {
      syncQueued = false;
      await performMobileSync(confirmed);
      confirmed = false;
    } while (syncQueued && syncSettings.enabled);
  })();
  try { return await syncing; }
  finally { syncing = null; }
}

function scheduleMobileSync(force = false) {
  if (!syncSettings.enabled || (!force && !syncSettings.after_save)) return;
  clearTimeout(syncDelay);
  syncDelay = setTimeout(() => { void mobileSync(); }, (syncSettings.delay || 30) * 1000);
}
function updateSyncTimers() {
  clearInterval(syncTimer);
  clearTimeout(syncDelay);
  const min = Number(syncSettings.interval);
  if (syncSettings.enabled && [1, 5, 15, 30].includes(min)) {
    syncTimer = setInterval(() => { if (!document.hidden) void mobileSync(); }, min * 60_000);
  }
}
// 状态颜色：「跟随强调色」加上共用的颜色库，和电脑版的设置一样。
const followAccent = document.createElement("button");
followAccent.type = "button";
followAccent.dataset.color = "";
followAccent.title = "跟随强调色";
followAccent.setAttribute("aria-label", "跟随强调色");
followAccent.style.setProperty("--sw", "var(--accent)");
followAccent.addEventListener("click", () => showSyncColor(""));
el("ms-color").append(followAccent);
const syncColorTool = makeSharedColorTools({
  id: "mobile-sync-status",
  getValue: () => el("ms-color").dataset.selected || getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
  onApply: (value) => showSyncColor(value),
  compact: true,
});
// 放在 .sync-field 外面，编辑器里的小输入框不套用表单输入框的大尺寸。
el("ms-color").closest(".sync-field").after(syncColorTool.root);
function showSyncColor(value) {
  el("ms-color").dataset.selected = tidyAccent(value);
  followAccent.setAttribute("aria-checked", String(!el("ms-color").dataset.selected));
  syncColorTool.sync();
}
el("open-sync-settings").addEventListener("click", () => {
  if (!drawer.hidden) toggleDrawer(false);
  updateSyncForm();
  syncColorTool.reopen();
  el("mobile-webdav-settings").hidden = false;
  el("sync-settings-backdrop").hidden = false;
  void showSyncStatus();
});
function closeSyncSettings() {
  el("mobile-webdav-settings").hidden = true;
  el("sync-settings-backdrop").hidden = true;
}
el("close-sync-settings").addEventListener("click", closeSyncSettings);
el("sync-settings-backdrop").addEventListener("click", closeSyncSettings);
el("ms-save-config").addEventListener("click", () => void saveSyncForm().catch(e => { el("ms-result").textContent = String(e); }));
el("ms-preset").addEventListener("change", () => {
  const kind = el("ms-preset").value;
  if (kind === "jianguoyun") el("ms-server").value = "https://dav.jianguoyun.com/dav/";
  else if (kind === "infinicloud") el("ms-server").value = "https://webdav.teracloud.jp/";
  else if (kind === "nextcloud") el("ms-server").placeholder = "https://域名/remote.php/dav/files/用户名/";
});
// 测试连接只用表单里的草稿，不保存设置和密码。
el("ms-test").addEventListener("click", () => void (async () => {
  try {
    el("ms-result").textContent = await invoke("mobile_webdav_test", { config: readSyncForm(), password: el("ms-password").value });
  } catch (e) { el("ms-result").textContent = String(e); }
})());
el("ms-run").addEventListener("click", () => void mobileSync());
el("mobile-sync-now").addEventListener("click", () => void mobileSync());
el("ms-forget").addEventListener("click", () => void (async () => {
  if (!(await ask("清除当前账号的同步密码与记录？手机笔记不会删除。", "断开"))) return;
  try {
    await invoke("mobile_webdav_forget", { config: syncSettings });
    syncSettings.enabled = false;
    localStorage.setItem(SYNC_KEY, JSON.stringify(syncSettings));
    updateSyncForm();
    updateSyncTimers();
    await showSyncStatus();
  } catch (e) { el("ms-result").textContent = String(e); }
})());
document.addEventListener("visibilitychange", () => {
  if (document.hidden && syncSettings.enabled && syncSettings.on_hide) {
    void flush().then(() => mobileSync()).catch(() => {});
  } else if (!document.hidden && syncSettings.enabled && syncSettings.on_start) {
    void mobileSync();
  }
});
// ---- 外观(0.4.4):界面风格、明暗、强调色,只存在这台手机上 ----
// 界面风格写在 <html data-ui>,和 data-theme 一起决定整套颜色(共用的菜单和浮条也跟着变);
// 经典是原来的绿色样子,不加 data-ui。
const LOOK_KEY = "minipad-mobile-look";
const UI_STYLES = ["starry", "material", "paper", "classic"];
const THEMES = ["system", "light", "dark"];
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
const settingsSheet = el("mobile-settings");
const settingsBackdrop = el("settings-backdrop");
let look = loadLook();
// 页面链接的两种颜色:第一个色块是默认的(跟随强调色 / 灰色),别的颜色来自共用的颜色库,和电脑版一样
const pageLinkColors = [
  ["page_link_color", "look-page-link-color", "跟随强调色", "var(--accent)"],
  ["page_link_broken_color", "look-page-link-broken-color", "灰色", "var(--muted)"],
].map(([field, box, name, swatch]) => {
  const first = document.createElement("button");
  first.type = "button";
  first.dataset.color = "";
  first.title = name;
  first.setAttribute("aria-label", name);
  first.style.setProperty("--sw", swatch);
  first.addEventListener("click", () => setLook({ [field]: "" }));
  el(box).append(first);
  const tool = makeSharedColorTools({
    id: "mobile-" + box,
    getValue: () => look[field] || getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
    onApply: (value) => setLook({ [field]: tidyAccent(value) }),
    compact: true,
  });
  el(box).closest(".sync-field").after(tool.root);
  return {
    show() {
      first.setAttribute("aria-checked", String(!look[field]));
      tool.sync();
    },
    reopen: () => tool.reopen(),
  };
});

function loadLook() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LOOK_KEY) || "{}") || {}; } catch { /* 用默认 */ }
  return {
    ui: UI_STYLES.includes(saved.ui) ? saved.ui : "starry",
    theme: THEMES.includes(saved.theme) ? saved.theme : "system",
    accent: tidyAccent(typeof saved.accent === "string" ? saved.accent : ""),
    stars: saved.stars !== false,
    cats: saved.cats !== false,
    fab: saved.fab !== false,
    debug: saved.debug === true,
    local_path_enabled: saved.local_path_enabled === true,
    // 格式栏右边「自定义」挑的按钮和顺序(和电脑版设置里的同名字段一样)
    format_bar_hidden: Array.isArray(saved.format_bar_hidden) ? saved.format_bar_hidden : [],
    format_bar_order: Array.isArray(saved.format_bar_order) ? saved.format_bar_order : [],
    // 网页链接用系统浏览器(system)还是应用内浏览器(inapp)打开;编辑时点链接要不要也直接打开
    link_open: saved.link_open === "inapp" ? "inapp" : "system",
    link_tap_edit: saved.link_tap_edit === true,
    // 页面链接(和电脑版设置里的同名字段一样)
    page_links: saved.page_links !== false,
    page_link_suggest: ["typing", "off"].includes(saved.page_link_suggest) ? saved.page_link_suggest : "brackets",
    page_link_cn_brackets: saved.page_link_cn_brackets !== false,
    page_link_color: tidyAccent(typeof saved.page_link_color === "string" ? saved.page_link_color : ""),
    page_link_broken_color: tidyAccent(typeof saved.page_link_broken_color === "string" ? saved.page_link_broken_color : ""),
    // 行内计算:手机上只有「打 = 就算」,默认不开
    calc_key: saved.calc_key === "equals" ? "equals" : "off",
  };
}

function setLook(change) {
  look = { ...look, ...change };
  try { localStorage.setItem(LOOK_KEY, JSON.stringify(look)); } catch { /* 这次照样生效,只是下次打开不记得 */ }
  applyLook();
  setMobileLocalPathEnabled(look.local_path_enabled);
}

function applyLook() {
  const root = document.documentElement;
  if (look.ui === "classic") delete root.dataset.ui;
  else root.dataset.ui = look.ui;
  root.dataset.theme = look.theme === "system" ? (systemDark.matches ? "dark" : "light") : look.theme;
  root.toggleAttribute("data-stars", look.stars);
  root.toggleAttribute("data-cats", look.cats);
  root.toggleAttribute("data-fab", look.fab);
  applyAccent(look.accent);
  // 自选的强调色也给按钮的浅底换色(经典风格的浅底是写死的绿色)
  if (look.accent) root.style.setProperty("--soft-accent", "var(--accent-soft)");
  else root.style.removeProperty("--soft-accent");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", getComputedStyle(root).getPropertyValue("--paper").trim());
  for (const b of el("ui-styles").children) b.setAttribute("aria-checked", String(b.dataset.ui === look.ui));
  for (const b of document.querySelectorAll("[data-theme-choice]")) b.setAttribute("aria-pressed", String(b.dataset.themeChoice === look.theme));
  for (const b of el("look-accent").children) b.setAttribute("aria-checked", String(b.dataset.color === look.accent));
  for (const row of settingsSheet.querySelectorAll("[data-ui-only]")) row.hidden = row.dataset.uiOnly !== look.ui;
  el("look-stars").checked = look.stars;
  el("look-cats").checked = look.cats;
  el("look-fab").checked = look.fab;
  el("look-debug").checked = look.debug;
  el("look-local-path").checked = look.local_path_enabled;
  for (const b of el("look-link-open").children) b.setAttribute("aria-pressed", String(b.dataset.linkOpen === look.link_open));
  el("look-link-tap-edit").checked = look.link_tap_edit;
  el("look-page-links").checked = look.page_links;
  for (const b of el("look-page-link-suggest").children) b.setAttribute("aria-pressed", String(b.dataset.suggest === look.page_link_suggest));
  el("look-page-link-cn").checked = look.page_link_cn_brackets;
  for (const c of pageLinkColors) c.show();
  applyPageLinkSettings(look, { mobile: true, tapEdit: look.link_tap_edit });
  el("look-calc").checked = look.calc_key === "equals";
  applyExpandSettings({ calc_key: look.calc_key });
  el("viewport-debug").hidden = !look.debug;
  if (look.debug) requestAnimationFrame(fitViewport);
  renderDrawer();
}

for (const a of ACCENTS) {
  const b = document.createElement("button");
  b.type = "button";
  b.setAttribute("role", "radio");
  b.dataset.color = a.value;
  b.title = a.name;
  b.setAttribute("aria-label", a.name);
  b.style.setProperty("--sw", a.value || "var(--style-accent)");
  b.addEventListener("click", () => setLook({ accent: a.value }));
  el("look-accent").append(b);
}
for (const b of el("ui-styles").children) b.addEventListener("click", () => setLook({ ui: b.dataset.ui }));
for (const b of document.querySelectorAll("[data-theme-choice]")) b.addEventListener("click", () => setLook({ theme: b.dataset.themeChoice }));
el("look-stars").addEventListener("change", (e) => setLook({ stars: e.target.checked }));
el("look-cats").addEventListener("change", (e) => setLook({ cats: e.target.checked }));
el("look-fab").addEventListener("change", (e) => setLook({ fab: e.target.checked }));
el("look-debug").addEventListener("change", (e) => setLook({ debug: e.target.checked }));
el("look-local-path").addEventListener("change", (e) => setLook({ local_path_enabled: e.target.checked }));
for (const b of el("look-link-open").children) b.addEventListener("click", () => setLook({ link_open: b.dataset.linkOpen }));
el("look-link-tap-edit").addEventListener("change", (e) => setLook({ link_tap_edit: e.target.checked }));
el("look-page-links").addEventListener("change", (e) => setLook({ page_links: e.target.checked }));
for (const b of el("look-page-link-suggest").children) b.addEventListener("click", () => setLook({ page_link_suggest: b.dataset.suggest }));
el("look-page-link-cn").addEventListener("change", (e) => setLook({ page_link_cn_brackets: e.target.checked }));
el("look-calc").addEventListener("change", (e) => setLook({ calc_key: e.target.checked ? "equals" : "off" }));
// 算不出来时在状态栏说一句
setExpandHost({ notify });
systemDark.addEventListener("change", applyLook);
// 格式栏「自定义」改了就记下来,重启后照旧
el("format-bar").addEventListener("format-bar-items", (e) => setLook(e.detail));

function showSettings(open) {
  settingsSheet.hidden = !open;
  settingsBackdrop.hidden = !open;
  if (open) {
    for (const c of pageLinkColors) c.reopen();
    if (!drawer.hidden) toggleDrawer(false);
    el("close-settings").focus();
  }
}
el("open-settings").addEventListener("click", () => showSettings(true));
el("close-settings").addEventListener("click", () => showSettings(false));
settingsBackdrop.addEventListener("click", () => showSettings(false));
applyLook();

// ---- 返回键(0.4.5):按一次关掉最上面开着的一层,顺序是 对话框 → 菜单和弹窗 → 查找栏 → 笔记本管理 → 同步设置 → 外观设置 → 抽屉。
// 只在有东西开着时才接管返回键(Tauri 的 onBackButtonPress),全关了就交还,返回键照常让应用退到后台。
const syncSheet = el("mobile-webdav-settings");
const openMenus = () => [...document.querySelectorAll(".menu:not([hidden])")];
const layerOpen = () => dialogOpen() || openMenus().length > 0 || !findPanel.hidden || !booksSheet.hidden || !syncSheet.hidden || !settingsSheet.hidden || !drawer.hidden;
function closeTopLayer() {
  if (dialogOpen()) closeDialog(false);
  else if (openMenus().length) for (const menu of openMenus()) menu.hidden = true;
  else if (!findPanel.hidden) showFind(false);
  else if (!booksSheet.hidden) showBookManager(false);
  else if (!syncSheet.hidden) closeSyncSettings();
  else if (!settingsSheet.hidden) showSettings(false);
  else if (!drawer.hidden) toggleDrawer(false);
}
let backListener = null; // 正在用的那一次登记;换掉以后旧的即使晚一步注销,也不会多关一层
function watchBackButton() {
  const app = window.__TAURI__?.app;
  if (!app?.onBackButtonPress) return;
  if (layerOpen() && !backListener) {
    const mine = {};
    mine.listener = app.onBackButtonPress(() => { if (backListener === mine) closeTopLayer(); }).catch(() => null);
    backListener = mine;
  } else if (!layerOpen() && backListener) {
    const old = backListener;
    backListener = null;
    void old.listener.then((listener) => listener?.unregister()).catch(() => {});
  }
}
// 各层开关时都会改 hidden;菜单和弹窗第一次用到时才放进 body
new MutationObserver(watchBackButton).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["hidden"] });
new MutationObserver(watchBackButton).observe(document.body, { childList: true });

// The soft keyboard must not cover the toolbar. Some WebViews shrink only the visual viewport,
// so the page height follows it, and the status line steps aside while the keyboard is up.
// Others resize the whole page for the keyboard and still shrink the visual viewport on top of
// that: following the visual viewport there would leave a keyboard-sized gap under the toolbar,
// so once the page itself got shorter its own height wins.
// When only the visual viewport shrinks, the WebView also pans it down (offsetTop) to show the
// caret. The page is fixed to the layout viewport, so it moves down by the same amount: otherwise
// its top slides out of sight and an offsetTop-sized gap opens between the toolbar and keyboard.
let fullHeight = 0;
let fullWidth = 0;
let fullInner = 0;
function fitViewport() {
  const vv = window.visualViewport;
  // Pinch-zooming shrinks the visual viewport in CSS pixels too; scale puts it back to screen size.
  const scale = vv?.scale ?? 1;
  const width = Math.round((vv?.width ?? window.innerWidth) * scale);
  const height = Math.round((vv?.height ?? window.innerHeight) * scale);
  if (width !== fullWidth) { fullWidth = width; fullHeight = 0; fullInner = 0; } // rotated: measure again
  fullHeight = Math.max(fullHeight, height);
  fullInner = Math.max(fullInner, window.innerHeight);
  const root = document.documentElement;
  const resized = fullInner - window.innerHeight > 120;
  const keyboard = resized || fullHeight - height > 120;
  root.style.setProperty("--app-height", (resized ? window.innerHeight : height) + "px");
  // Pinch-zoom panning is the reader moving around the page, not the keyboard: leave it alone.
  const panned = !resized && Math.abs(scale - 1) < 0.01 ? Math.max(0, Math.round(vv?.offsetTop ?? 0)) : 0;
  root.style.setProperty("--app-top", panned + "px");
  // How much of the layout viewport the keyboard covers (0 when the layout already shrank).
  // offsetTop is already in layout-viewport pixels, so it is not scaled.
  root.style.setProperty("--keyboard-inset", (resized ? 0 : Math.max(0, window.innerHeight - height - Math.round(vv?.offsetTop ?? 0))) + "px");
  const was = root.hasAttribute("data-keyboard");
  root.toggleAttribute("data-keyboard", keyboard);
  if (keyboard && !was && view?.hasFocus()) requestAnimationFrame(() => view.dispatch(view.state.tr.scrollIntoView()));
  placeFab();
  if (look.debug) showDebug({ resized, keyboard, panned });
}

// 外观设置里打开“键盘调试信息”时,右上角显示这些数字:键盘弹出时截一张图,就能看出空隙是哪来的
function showDebug(d) {
  const vv = window.visualViewport;
  const dock = el("mobile-dock").getBoundingClientRect();
  const round = (v) => (v == null ? "-" : Math.round(v * 10) / 10);
  el("viewport-debug").textContent = [
    `innerHeight ${window.innerHeight} (最大 ${fullInner})`,
    `visualViewport ${round(vv?.height)} · top ${round(vv?.offsetTop)} · scale ${round(vv?.scale)}`,
    `screen ${screen.height} · dpr ${round(devicePixelRatio)}`,
    `body ${round(document.body.getBoundingClientRect().height)} · top ${d.panned}`,
    `工具栏底边 ${round(dock.bottom)} · 可见底边 ${round((vv?.offsetTop ?? 0) + (vv?.height ?? window.innerHeight))}`,
    `键盘 ${d.keyboard ? "是" : "否"} · 页面被缩 ${d.resized ? "是" : "否"} · 遮住 ${document.documentElement.style.getPropertyValue("--keyboard-inset")}`,
  ].join("\n");
}

// 新建页面的悬浮按钮停在页面区域的右下角,工具栏和状态栏变高变矮时跟着挪
const fab = el("new-page");
function placeFab() {
  const bottom = el("page").getBoundingClientRect().bottom;
  document.documentElement.style.setProperty("--fab-bottom", Math.max(0, Math.round(window.innerHeight - bottom)) + 16 + "px");
}
fab.addEventListener("click", () => el("add-note").click());
new ResizeObserver(placeFab).observe(el("page"));
window.visualViewport?.addEventListener("resize", fitViewport);
window.visualViewport?.addEventListener("scroll", fitViewport);
window.addEventListener("resize", fitViewport);
fitViewport();

// Touching a toolbar button must not take the focus (and the selection) away from the editor.
document.addEventListener("pointerdown", (event) => {
  if (event.target.closest("#toolbar button")) event.preventDefault();
});

async function start() {
  try {
    document.documentElement.dataset.mobile = "true";
    // The floating selection bar sits below the selection: the system's own copy/paste popup
    // and the selection handles use the space above it.
    setSelectionBar({ sel_bar: "always", sel_bar_pos: "below" });
    const { applyBlockSettings } = await import("./blocks.js");
    applyBlockSettings({ block_enabled: true, block_context_menu: "block" });
    // 格式栏的「链接」「任务」按钮和电脑版一样:链接地址用应用内对话框问
    setLinkPrompt(() => askText("链接地址", "https://"));
    setTaskCommand(toggleTask);
    setFormatBarItems(look.format_bar_hidden, look.format_bar_order);
    await createEditor({
      mobile: true,
      mobileImagePlugin: images,
      onChange: (note) => { if (note === selected) scheduleSave(); },
      openLink,
      emptyBold: () => {},
    });
    view = editorDebug().view;
    setMobileLocalPathEnabled(look.local_path_enabled);
    view.dom.addEventListener("open-find", () => showFind(true));
    if (!invoke) throw new Error("请使用 Android 应用打开");
    await refresh(null, null);
    await adoptSharedColors();
    updateSyncTimers();
    if (window.__TAURI__?.event?.listen) {
      await window.__TAURI__.event.listen("webdav-changed", async (event) => {
        if (event?.payload?.includes?.(COLORS_FILE)) await adoptSharedColors();
        if (!dirty && !saving && !switching) {
          await refresh();
        } else {
          // 正在编辑：只重新列出页面，当前页不动，保存时 expected 不符会自动留冲突副本
          notify("网盘有更新，保存当前编辑后会安全处理冲突");
          await showNewPages();
        }
        await showSyncStatus();
      });
    }
    if (syncSettings.enabled) void showSyncStatus();
    if (syncSettings.enabled && syncSettings.on_start) void mobileSync();
  } catch (error) {
    notify("编辑器初始化失败：" + error);
  }
}
void start();
