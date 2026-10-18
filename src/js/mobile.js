// Android-only Milkdown editor. Persist Markdown; binary images go to the book's assets folder.
import { Editor, rootCtx, editorViewCtx, parserCtx, serializerCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { $prose } from "@milkdown/kit/utils";
import { Plugin, EditorState } from "@milkdown/kit/prose/state";
import { toggleMark, setBlockType, wrapIn } from "@milkdown/kit/prose/commands";
import { wrapInList } from "@milkdown/kit/prose/schema-list";
import { undo, redo } from "@milkdown/kit/prose/history";

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
let editorCtx = null;
let view = null;
let dirty = false;
let saving = null;
let timer = null;
let loading = false;
let busy = false;
let reading = false;

const notify = (message) => { status.textContent = message; };
const markdown = () => editorCtx.get(serializerCtx)(view.state.doc);
const allowedImage = { "image/jpeg": true, "image/png": true, "image/gif": true, "image/webp": true, "image/bmp": true };

// These desktop extensions cannot yet be faithfully round-tripped by basic mobile Milkdown.
// Show raw Markdown for these notes rather than risking silent loss of fold/code metadata.
const needsSource = (markdown) => /(^|\n)[ \t]*>[ \t]*\[!fold\][+-](?:[ \t]|$)|(^|\n)[ \t]{0,3}(?:`{3,}|~{3,})[^\n]*[ \t]+\S|<span\b[^>]*\bstyle\s*=/i.test(markdown);

function scheduleSave() {
  if (loading || !selected || selected.unreadable || reading) return;
  dirty = true;
  notify("尚未保存");
  clearTimeout(timer);
  timer = setTimeout(() => { void flush().catch(() => {}); }, 500);
}

const changes = $prose(() => new Plugin({
  view: () => ({
    update(v, prev) {
      if (!prev.doc.eq(v.state.doc)) scheduleSave();
    },
  }),
}));

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

function render() {
  const bookName = selected?.book ?? books[0]?.name ?? "";
  const book = books.find((b) => b.name === bookName);
  options(booksSelect, books.map((b) => [b.name, b.name || "默认"]), bookName);
  options(notesSelect, (book?.notes || []).map((n) => [n.name, n.name]), selected?.name);
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
    const state = view.state;
    view.updateState(EditorState.create({
      schema: state.schema,
      doc: editorCtx.get(parserCtx)(selected?.sourceOnly ? "" : (note?.content ?? "")),
      plugins: state.plugins,
    }));
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

function dispatch(command) {
  if (!view || !selected || selected.unreadable || reading) return false;
  const handled = command(view.state, view.dispatch);
  if (handled) view.focus();
  return handled;
}

function format(kind) {
  const state = view.state;
  const { nodes, marks } = state.schema;
  if (kind === "bold") return dispatch(toggleMark(marks.strong));
  if (kind === "italic") return dispatch(toggleMark(marks.em));
  if (kind === "inline-code") return dispatch(toggleMark(marks.inlineCode));
  if (kind === "heading") return dispatch(setBlockType(nodes.heading, { level: 2 }));
  if (kind === "paragraph") return dispatch(setBlockType(nodes.paragraph));
  if (kind === "bullet") return dispatch(wrapInList(nodes.bullet_list));
  if (kind === "ordered") return dispatch(wrapInList(nodes.ordered_list));
  if (kind === "quote") return dispatch(wrapIn(nodes.blockquote));
  if (kind === "undo") return dispatch(undo);
  if (kind === "redo") return dispatch(redo);
  if (kind === "image") return fileInput.click();
  if (kind === "link") {
    const url = prompt("输入链接地址（https:// 或 mailto:）");
    if (!url) return;
    if (!/^(https:\/\/|http:\/\/|mailto:)/i.test(url)) {
      notify("不支持的链接地址");
      return;
    }
    const { from, to } = state.selection;
    const tr = state.tr;
    const mark = marks.link.create({ href: url });
    if (from === to) {
      const label = prompt("链接文字") || url;
      tr.insertText(label, from, to);
      tr.addMark(from, from + label.length, mark);
    } else {
      tr.addMark(from, to, mark);
    }
    view.dispatch(tr.scrollIntoView());
    view.focus();
  }
}

// Keep the text selection intact when touch-pressing a toolbar button.
toolbar.addEventListener("pointerdown", (event) => {
  if (event.target.closest("button")) event.preventDefault();
});
toolbar.addEventListener("click", (event) => {
  const kind = event.target.closest("button")?.dataset.command;
  if (kind) format(kind);
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
    const editor = await Editor.make()
      .config((ctx) => ctx.set(rootCtx, el("editor")))
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(clipboard)
      .use(changes)
      .use(images)
      .create();
    editor.action((ctx) => {
      editorCtx = ctx;
      view = ctx.get(editorViewCtx);
    });
    view.dom.spellcheck = false;
    if (!invoke) throw new Error("请使用 Android 应用打开");
    await refresh(null, null);
  } catch (error) {
    notify("编辑器初始化失败：" + error);
  }
}
void start();
