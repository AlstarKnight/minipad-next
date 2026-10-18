// Android-only Milkdown editor. Persist Markdown; binary images go to the book's assets folder.
import { $prose, Plugin, TextSelection } from "../vendor/milkdown.js";
import { createEditor, editorDebug, showInEditor, syncContent } from "./editor.js";
import { state as desktopState } from "./state.js";

const invoke = window.__TAURI__?.core?.invoke;
const el = (id) => document.getElementById(id);
const status = el("status");
const booksSelect = el("book");
const notesSelect = el("note");
const toolbar = el("toolbar");
const fileInput = el("image-file");
const source = el("source");

let books = [];
let selected = null; // { book, name, disk, unreadable }
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

// These desktop extensions cannot yet be faithfully round-tripped by basic mobile Milkdown.
// Show raw Markdown for these notes rather than risking silent loss of fold/code metadata.
// Desktop folds, styled spans and titled code are handled by the shared editor.
const needsSource = (md) => /<(?!\/?span\b)[A-Za-z][^>]*>/i.test(md);

function scheduleSave() {
  if (loading || !selected || selected.unreadable || reading) return;
  dirty = true;
  notify("尚未保存");
  clearTimeout(timer);
  timer = setTimeout(() => { void flush().catch(() => {}); }, 500);
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
      void invoke("mobile_read_image", { book, path: src })
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

const drawer = el("drawer");
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
  const bookName = selected?.book ?? books[0]?.name ?? "";
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
      await refresh(b.name, null);
      if (selected?.book === b.name || (!b.notes.length && books.some((x) => x.name === b.name))) toggleDrawer(false);
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
  const bookName = selected?.book ?? books[0]?.name ?? "";
  const book = books.find((b) => b.name === bookName);
  options(booksSelect, books.map((b) => [b.name, b.name || "默认"]), bookName);
  options(notesSelect, (book?.notes || []).map((n) => [n.name, n.name]), selected?.name);
  el("book-title").replaceChildren(document.createTextNode(book?.name || "默认笔记本"), (() => {
    const arrow = document.createElement("span");
    arrow.textContent = "⌄";
    return arrow;
  })());
  el("page-title").textContent = selected?.name || "新页面";
  renderDrawer();
  const editable = !!selected && !selected.unreadable && !reading;
  const raw = !!selected?.sourceOnly;
  if (view) view.setProps({ editable: () => editable && !raw });
  el("editor").hidden = raw;
  source.hidden = !raw;
  source.readOnly = !editable;
  el("mode").disabled = !selected || selected.unreadable;
  el("mode").textContent = reading ? "编辑" : "阅读";
  el("mode").setAttribute("aria-pressed", String(reading));
  toolbar.hidden = !editable || raw;
  for (const button of toolbar.querySelectorAll("button")) button.disabled = !editable;
  el("add-note").disabled = !book;
  el("hint").textContent = selected?.unreadable ? "文件内容无法识别，仅允许查看" :
    raw ? "该笔记包含桌面扩展，使用保真源码模式" :
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
      notify(result?.conflict_name ? "已保存，产生冲突副本" : "已保存");
    } catch (error) {
      dirty = true;
      notify("保存失败：" + error);
      throw error;
    } finally {
      saving = null;
    }
  }
}

async function refresh(bookName = selected?.book, noteName = selected?.name) {
  if (busy) return;
  busy = true;
  try {
    await flush();
    const loaded = await invoke("mobile_load_books");
    const book = loaded.find((b) => b.name === bookName) || loaded[0];
    const note = book?.notes.find((n) => n.name === noteName) || book?.notes[0];
    books = loaded;
    selected = note ? {
      book: book.name, name: note.name, disk: note.content, unreadable: note.unreadable,
      sourceOnly: needsSource(note.content),
    } : null;
    source.value = note?.content ?? "";
    loading = true;
    if (selected && !selected.sourceOnly) showInEditor(selected);
    loading = false;
    render();
    notify(note?.unreadable ? "只读：原始文件不可安全解码" : "已保存");
    el("page").scrollTop = 0;
  } catch (error) {
    loading = false;
    render();
    notify("无法切换：" + error);
  } finally {
    busy = false;
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
notesSelect.addEventListener("change", () => { void refresh(booksSelect.value, notesSelect.value); });

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
    const book = booksSelect.value;
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

async function start() {
  try {
    desktopState.settings = {};
    document.documentElement.dataset.mobile = "true";
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
