// Android-only Milkdown editor. Persist Markdown; binary images go to the book's assets folder.
import { $prose, Plugin, TextSelection } from "../vendor/milkdown.js";
import { createEditor, editorDebug, showInEditor, syncContent } from "./editor.js";
import { state as desktopState } from "./state.js";
import { setSelectionBar } from "./formatbar.js";

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

const notify = (message) => { status.textContent = message; };
const markdown = () => { syncContent(selected); return selected?.content ?? ""; };
const allowedImage = { "image/jpeg": true, "image/png": true, "image/gif": true, "image/webp": true, "image/bmp": true };

// Desktop folds, styled spans and titled code are handled by the shared editor. Any other raw
// HTML tag cannot be round-tripped by Milkdown, so those notes open as raw Markdown instead of
// risking silent loss. Tags inside code blocks and inline code are plain text, not HTML.
const CODE = /^(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?^\1[^\n]*$|[\s\S]*)|`[^`\n]+`/gm;
// <https://example.com> and <me@example.com> are Markdown autolinks, not HTML.
const AUTOLINK = /<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>]+)>/g;
const needsSource = (md) => /<(?!\/?span\b)[A-Za-z][^>]*>/i.test(md.replace(CODE, "").replace(AUTOLINK, ""));

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

// Images are immutable (a new file name per save), so decoded data URLs can be kept for reuse.
// Re-rendering a page, or switching back to it, then costs no IPC round trip.
const IMAGE_CACHE_LIMIT = 24 * 1024 * 1024;
const imageCache = new Map(); // oldest first
let imageCacheSize = 0;
function cacheImage(book, path, data) {
  const key = book + "\0" + path;
  if (data.length > IMAGE_CACHE_LIMIT || imageCache.has(key)) return;
  imageCache.set(key, data);
  imageCacheSize += data.length;
  for (const [oldest, value] of imageCache) {
    if (imageCacheSize <= IMAGE_CACHE_LIMIT) break;
    imageCache.delete(oldest);
    imageCacheSize -= value.length;
  }
}
async function readImage(book, path) {
  const key = book + "\0" + path;
  const hit = imageCache.get(key);
  if (hit) {
    imageCache.delete(key); // most recently used goes last
    imageCache.set(key, hit);
    return hit;
  }
  const data = await invoke("mobile_read_image", { book, path });
  cacheImage(book, path, data);
  return data;
}

class MobileImageView {
  constructor(node) {
    this.dom = document.createElement("img");
    this.dom.addEventListener("error", () => this.dom.classList.add("broken"));
    this.dom.addEventListener("load", () => this.dom.classList.remove("broken"));
    this.token = 0;
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
    const token = ++this.token;
    this.dom.removeAttribute("src");
    if (src.startsWith("assets/") || src.startsWith("./assets/")) {
      void readImage(book, src)
        .then((data) => {
          if (token === this.token) this.dom.src = data;
        })
        .catch(() => {
          if (token === this.token) {
            this.dom.classList.add("broken");
            this.dom.title = "找不到本地图片：" + src;
          }
        });
    } else if (/^https:\/\//i.test(src) || /^data:image\/(?:png|jpeg|webp|gif|bmp);base64,/i.test(src)) {
      this.dom.src = src;
    } else {
      this.dom.classList.add("broken");
      this.dom.title = "不支持的图片路径";
    }
    return true;
  }

  ignoreMutation() { return true; }
  destroy() { this.token++; }
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

function options(select, pairs, value) {
  select.replaceChildren();
  for (const [key, label] of pairs) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = label;
    select.add(option);
  }
  if (value != null) select.value = value;
}

const drawer = el("mobile-drawer");
const backdrop = el("drawer-backdrop");
function toggleDrawer(open) {
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

function renderDrawer() {
  const bookName = currentBook;
  const book = books.find((b) => b.name === bookName);
  const bookList = el("books-list");
  const noteList = el("notes-list");
  bookList.replaceChildren();
  noteList.replaceChildren();
  for (const b of books) {
    const button = document.createElement("button");
    button.type = "button";
    button.classList.toggle("active", b.name === bookName);
    button.setAttribute("aria-current", b.name === bookName ? "true" : "false");
    const name = document.createElement("span");
    name.textContent = b.name || "默认笔记本";
    button.append(name);
    button.addEventListener("click", async () => {
      // Tapping the notebook already on screen just closes the list; the open page stays.
      if (b.name !== currentBook) await refresh(b.name, null);
      if (currentBook === b.name) toggleDrawer(false);
    });
    bookList.append(button);
  }
  const query = el("note-filter").value.trim().toLowerCase();
  const notes = (book?.notes || []).filter((n) => n.name.toLowerCase().includes(query));
  for (const n of notes) {
    const button = document.createElement("button");
    button.type = "button";
    button.classList.toggle("active", selected?.name === n.name);
    button.setAttribute("aria-current", selected?.name === n.name ? "page" : "false");
    const name = document.createElement("span");
    name.textContent = n.name;
    button.append(name);
    button.addEventListener("click", async () => {
      await refresh(bookName, n.name);
      if (selected?.name === n.name && selected?.book === bookName) toggleDrawer(false);
    });
    noteList.append(button);
  }
  if (!notes.length) {
    const empty = document.createElement("p");
    empty.className = "drawer-empty";
    empty.textContent = "当前没有匹配的页面";
    noteList.append(empty);
  }
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
  toolbar.hidden = !canEdit || raw;
  toolbar.inert = switching;
  el("add-note").disabled = !book || switching;
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
    name: b.name, notes: b.notes.map((name) => ({ name })),
  }));
}

// A conflict copy is a new page: show it in the lists without leaving the page being edited.
async function showNewPages() {
  try {
    books = await listBooks();
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
    cacheImage(note.book, src, `data:${file.type};base64,${data}`);
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
  if (e.key === "Escape" && !drawer.hidden) toggleDrawer(false);
});
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
  const name = prompt("新笔记本名称");
  if (!name?.trim()) return;
  try {
    await flush();
    const created = await invoke("mobile_create_book", { name: name.trim() });
    await refresh(created, null);
  } catch (error) { notify("新建笔记本失败：" + error); }
});

el("add-note").addEventListener("click", async () => {
  const name = prompt("新页面名称");
  if (!name?.trim()) return;
  try {
    await flush();
    const book = currentBook;
    const created = await invoke("mobile_create_note", { book, name: name.trim() });
    await refresh(book, created);
  } catch (error) { notify("新建页面失败：" + error); }
});

el("mode").addEventListener("click", async () => {
  if (!reading) {
    try { await flush(); } catch { return; }
  }
  reading = !reading;
  render();
  if (!reading) (selected?.sourceOnly ? source : view).focus();
});
el("refresh").addEventListener("click", () => { void refresh(); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) void flush().catch(() => {});
});

// The shared menus and bars are themed by data-theme; follow the system light/dark setting.
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  document.documentElement.dataset.theme = systemDark.matches ? "dark" : "light";
}
applyTheme();
systemDark.addEventListener("change", applyTheme);

// The soft keyboard must not cover the toolbar. Some WebViews shrink only the visual viewport,
// so the page height follows it, and the status line steps aside while the keyboard is up.
let fullHeight = 0;
let fullWidth = 0;
function fitViewport() {
  const vv = window.visualViewport;
  // Pinch-zooming shrinks the visual viewport in CSS pixels too; scale puts it back to screen size.
  const scale = vv?.scale ?? 1;
  const width = Math.round((vv?.width ?? window.innerWidth) * scale);
  const height = Math.round((vv?.height ?? window.innerHeight) * scale);
  if (width !== fullWidth) { fullWidth = width; fullHeight = 0; } // rotated: measure again
  fullHeight = Math.max(fullHeight, height);
  const root = document.documentElement;
  const keyboard = fullHeight - height > 120;
  root.style.setProperty("--app-height", height + "px");
  // How much of the layout viewport the keyboard covers (0 when the layout already shrank).
  // offsetTop is already in layout-viewport pixels, so it is not scaled.
  root.style.setProperty("--keyboard-inset", Math.max(0, window.innerHeight - height - Math.round(vv?.offsetTop ?? 0)) + "px");
  const was = root.hasAttribute("data-keyboard");
  root.toggleAttribute("data-keyboard", keyboard);
  if (keyboard && !was && view?.hasFocus()) requestAnimationFrame(() => view.dispatch(view.state.tr.scrollIntoView()));
}
window.visualViewport?.addEventListener("resize", fitViewport);
window.addEventListener("resize", fitViewport);
fitViewport();

// Touching a toolbar button must not take the focus (and the selection) away from the editor.
document.addEventListener("pointerdown", (event) => {
  if (event.target.closest("#toolbar button")) event.preventDefault();
});

async function start() {
  try {
    desktopState.settings = {};
    document.documentElement.dataset.mobile = "true";
    // The floating selection bar sits below the selection: the system's own copy/paste popup
    // and the selection handles use the space above it.
    setSelectionBar({ sel_bar: "always", sel_bar_pos: "below" });
    const { applyBlockSettings } = await import("./blocks.js");
    applyBlockSettings({ block_enabled: true, block_context_menu: "block" });
    await createEditor({
      mobile: true,
      mobileImagePlugin: images,
      onChange: (note) => { if (note === selected) scheduleSave(); },
      openLink: (href) => { if (/^https?:\/\//i.test(href)) window.open(href, "_blank", "noopener"); },
      emptyBold: () => {},
    });
    view = editorDebug().view;
    view.dom.addEventListener("open-find", () => showFind(true));
    if (!invoke) throw new Error("请使用 Android 应用打开");
    await refresh(null, null);
  } catch (error) {
    notify("编辑器初始化失败：" + error);
  }
}
void start();
