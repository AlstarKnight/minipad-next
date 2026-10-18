// Android local-first shell. PR #2 will replace the raw Markdown view with touch-ready Milkdown.
const invoke = window.__TAURI__?.core?.invoke;
const el = (id) => document.getElementById(id);
const editor = el("editor");
const preview = el("preview");
const status = el("status");
const bookSelect = el("book");
const noteSelect = el("note");

let books = [];
let selected = null; // { book, name, disk, unreadable }
let dirty = false;
let saving = null;
let timer = null;
let viewMode = false;

function message(value) {
  status.textContent = value;
}

function options(select, items, chosen) {
  select.replaceChildren();
  for (const [value, label] of items) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.add(option);
  }
  if (chosen != null) select.value = chosen;
}

function show() {
  const bookName = selected?.book ?? books[0]?.name ?? "";
  const foundBook = books.find((b) => b.name === bookName);
  options(bookSelect, books.map((b) => [b.name, b.name || "默认"]), bookName);
  options(noteSelect, (foundBook?.notes || []).map((n) => [n.name, n.name]), selected?.name);
  const hasNote = !!selected;
  editor.disabled = !hasNote || selected.unreadable;
  el("add-note").disabled = !foundBook;
  el("mode").disabled = !hasNote;
  editor.hidden = viewMode;
  preview.hidden = !viewMode;
  preview.textContent = editor.value;
  el("mode").textContent = viewMode ? "编辑" : "查看";
  el("mode").setAttribute("aria-pressed", String(viewMode));
  if (!hasNote) editor.value = "";
}

async function flush() {
  clearTimeout(timer);
  if (saving) await saving;
  while (dirty && selected) {
    const note = selected;
    const content = editor.value;
    dirty = false;
    message("保存中…");
    saving = invoke("mobile_save_note", {
      book: note.book, name: note.name, content, expected: note.disk,
    });
    try {
      const result = await saving;
      note.disk = content;
      message(result?.conflict_name ? "已保存，另有冲突副本" : "已保存");
    } catch (error) {
      dirty = true;
      message("保存失败：" + error);
      throw error;
    } finally {
      saving = null;
    }
  }
}

async function refresh(bookName = selected?.book, noteName = selected?.name) {
  try {
    await flush();
    books = await invoke("mobile_load_books");
    const foundBook = books.find((b) => b.name === bookName) || books[0];
    const note = foundBook?.notes.find((n) => n.name === noteName) || foundBook?.notes[0];
    selected = note ? {
      book: foundBook.name, name: note.name, disk: note.content, unreadable: note.unreadable,
    } : null;
    editor.value = note?.content ?? "";
    show();
    message(note?.unreadable ? "文件无法安全读取，仅查看" : "已保存");
  } catch (error) {
    message("读取失败：" + error);
    // A failed save must never silently change the selected note.
    show();
  }
}

editor.addEventListener("input", () => {
  if (!selected || selected.unreadable) return;
  dirty = true;
  message("尚未保存");
  clearTimeout(timer);
  timer = setTimeout(() => { void flush().catch(() => {}); }, 450);
});

bookSelect.addEventListener("change", () => { void refresh(bookSelect.value, null); });
noteSelect.addEventListener("change", () => { void refresh(bookSelect.value, noteSelect.value); });

el("add-book").addEventListener("click", async () => {
  const name = prompt("新笔记本名称");
  if (!name?.trim()) return;
  try {
    await flush();
    const created = await invoke("mobile_create_book", { name: name.trim() });
    await refresh(created, null);
  } catch (error) { message("新建笔记本失败：" + error); }
});

el("add-note").addEventListener("click", async () => {
  const name = prompt("新页面名称");
  if (!name?.trim()) return;
  try {
    await flush();
    const book = bookSelect.value;
    const created = await invoke("mobile_create_note", { book, name: name.trim() });
    await refresh(book, created);
  } catch (error) { message("新建页面失败：" + error); }
});

el("mode").addEventListener("click", async () => {
  if (viewMode) {
    viewMode = false;
    show();
    editor.focus();
  } else {
    try {
      await flush();
      viewMode = true;
      show();
    } catch { /* Save failure remains visible; stay in the editor. */ }
  }
});

el("refresh").addEventListener("click", () => { void refresh(); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) void flush().catch(() => {});
});

if (!invoke) message("请在 Android 应用中打开");
else void refresh(null, null);
