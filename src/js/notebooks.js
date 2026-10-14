// ---------- 笔记本 ----------
import { api } from "./api.js";
import { $ } from "./dom.js";
import { state, book, bookLabel, makeBook, sortBooks } from "./state.js";
import { toast, ask, askText, openMenu, closeOverlays, focusEditor } from "./ui.js";
import { flushAll, saveMeta, scheduleMeta, scheduleBooks } from "./save.js";
import { mutate } from "./sync.js";
import { rememberView, showNote } from "./page.js";
import { renderTabs, ensurePage, removeNote } from "./tabs.js";
import { BOOK_ICONS, bookIcon, iconColor } from "./bookicons.js";
import { tidyAccent } from "./accent.js";
import { makeSharedColorTools } from "./sharedcolors.js";

// 为了"移到笔记本…"打开列表时是要移动的页面,平时是 null
let moving = null;
let selectedBook = null;
let appearanceBusy = false;
let notebookColorEditor = null;
// 列表里的按钮 -> 笔记本
const itemBook = new WeakMap();

// 更新按钮上的名字和列表
export function renderBook() {
  const currentBook = book();
  const label = bookLabel(currentBook);
  const btn = $("#btn-book");
  $("#book-name").textContent = label;
  btn.title = label;
  btn.setAttribute("aria-label", `当前笔记本：${label}，点击切换`);
  $("#book-icon").innerHTML = bookIcon(currentBook?.icon, currentBook?.icon_color || state.settings?.accent);
  $("#book-icon").style.color = iconColor(currentBook);
  renderList();
  if (!$("#book-manager").hidden) renderManager();
}

function renderList() {
  const focused = itemBook.get(document.activeElement);
  const list = $("#books-list");
  list.innerHTML = "";
  for (const b of state.books) {
    const item = document.createElement("button");
    item.className = "book-item" + (b === book() ? " current" : "");
    item.dataset.book = b.name;
    item.title = bookLabel(b);
    item.disabled = !!moving && b === book();
    const icon = document.createElement("span");
    icon.className = "book-item-icon";
    icon.innerHTML = bookIcon(b.icon, b.icon_color || state.settings?.accent);
    icon.style.color = iconColor(b);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = bookLabel(b);
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = b.notes.length;
    item.append(icon, name, count);
    item.addEventListener("click", () => pick(b));
    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (moving) return;
      openMenu(
        [
          { id: "rename", label: "改名", act: () => renameBook(b), disabled: !b.name },
          { id: "delete", label: "删除笔记本", act: () => deleteBook(b), danger: true, disabled: !b.name },
        ],
        e.clientX,
        e.clientY
      );
    });
    itemBook.set(item, b);
    list.appendChild(item);
    if (b === focused) item.focus();
  }
}

// 打开笔记本列表;传了页面就是"把这个页面移到…"
export function openBooks(note = null) {
  closeOverlays();
  moving = note;
  $("#books-title").textContent = note ? `把「${note.name}」移到…` : "笔记本";
  $("#books-new").textContent = note ? "新建笔记本并移过去…" : "新建笔记本…";
  $("#books-hint").hidden = !!note;
  $("#books-import").hidden = !!note;
  renderList();
  const m = $("#books");
  const btn = $("#btn-book");
  m.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  const r = btn.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(r.left, window.innerWidth - m.offsetWidth - 4)) + "px";
  m.style.top = r.bottom + 4 + "px";
  refocus(book());
}

export function closeBooks() {
  $("#books").hidden = true;
  $("#btn-book").setAttribute("aria-expanded", "false");
  moving = null;
}

export function toggleBooks() {
  if ($("#books").hidden) openBooks();
  else closeOverlays();
}

// 列表开着时把焦点放到 b 上,b 不能选就放到第一个能选的上
function refocus(b) {
  if ($("#books").hidden) return;
  const items = [...$("#books").querySelectorAll("button:not(:disabled)")];
  (items.find((el) => itemBook.get(el) === b) || items[0])?.focus();
}

async function pick(b) {
  const note = moving;
  closeBooks();
  if (note) await moveNoteTo(note, b);
  else await switchBook(b);
}

export async function switchBook(b) {
  if (b === book()) return focusEditor();
  rememberView();
  // 先保证那边有页面再换过去
  try {
    await ensurePage(b);
  } catch (e) {
    toast("打开笔记本失败:" + e);
    return;
  }
  if (!state.books.includes(b)) return;
  state.book = state.books.indexOf(b);
  renderBook();
  renderTabs();
  showNote();
  scheduleBooks();
}

export async function createBook() {
  const note = moving;
  const name = await askText("新笔记本的名字:", "新笔记本", "新建");
  if (name === null) {
    if (!$("#books").hidden) $("#books-new").focus();
    return;
  }
  closeBooks();
  let b;
  try {
    b = await mutate(async () => {
      const nb = makeBook(await api.invoke("create_book", { name }));
      state.books.push(nb);
      sortBooks();
      return nb;
    });
  } catch (e) {
    toast("新建笔记本失败:" + e);
    return;
  }
  if (note) await moveNoteTo(note, b);
  else await switchBook(b);
}

export async function renameBook(b) {
  if (!b.name) return;
  const name = await askText("笔记本的新名字:", b.name, "改名");
  if (name && name !== b.name) {
    try {
      await mutate(async () => {
        await flushAll();
        await saveMeta();
        b.name = await api.invoke("rename_book", { old: b.name, new: name });
        sortBooks();
      });
    } catch (e) {
      toast("改名失败:" + e);
    }
    renderBook();
  }
  refocus(b);
}

export async function deleteBook(b) {
  if (!b.name) return;
  const count = b.notes.length;
  const msg =
    `删除笔记本「${b.name}」${count ? `和里面的 ${count} 个页面` : ""}?\n` +
    "文件夹会移到笔记文件夹的 .trash 里,需要时可以找回。";
  if (await ask(msg, "删除", true)) {
    try {
      await mutate(async () => {
        await flushAll();
        await saveMeta();
        await api.invoke("delete_book", { name: b.name });
        const wasCurrent = b === book();
        const next = wasCurrent ? state.books.find((x) => x.name === "") : book();
        // 删的是当前笔记本:回到「默认」
        if (wasCurrent) await ensurePage(next);
        const i = state.books.indexOf(b);
        if (i >= 0) state.books.splice(i, 1);
        state.book = state.books.indexOf(next);
        if (wasCurrent) {
          renderTabs();
          showNote();
        }
      });
    } catch (e) {
      toast("删除失败:" + e);
    }
    renderBook();
  }
  refocus(book());
}

// 把页面移到另一个笔记本,人还留在当前笔记本
export async function moveNoteTo(n, target) {
  const src = state.books.find((b) => b.notes.includes(n));
  if (!src || src === target || !state.books.includes(target)) return;
  try {
    await mutate(async () => {
      await flushAll();
      await saveMeta();
      const name = await api.invoke("move_note", { book: src.name, name: n.name, target: target.name });
      rememberView();
      removeNote(src, n);
      n.name = name;
      // 分组是每个笔记本自己的,移过去以后不在分组里
      n.group = "";
      target.notes.push(n);
      await ensurePage(src);
      if (src === book()) {
        renderTabs();
        showNote();
      }
      scheduleMeta(src);
      scheduleMeta(target);
      toast(`已把「${name}」移到「${bookLabel(target)}」`);
    });
  } catch (e) {
    toast("移动失败:" + e);
  }
  renderBook();
}

// 单独的笔记本管理页。只更改图标元信息，不切换当前笔记或编辑状态。
export function openBookManager() {
  closeOverlays();
  selectedBook = state.books.includes(selectedBook) ? selectedBook : book();
  $("#book-manager").hidden = false;
  renderManager();
  $("#bm-close").focus();
}

export function closeBookManager() {
  if ($("#book-manager").hidden) return false;
  $("#book-manager").hidden = true;
  selectedBook = null;
  return true;
}

function renderManager() {
  if ($("#book-manager").hidden) return;
  if (!state.books.includes(selectedBook)) selectedBook = book();
  const list = $("#bm-list");
  list.replaceChildren();
  for (const b of state.books) {
    const button = document.createElement("button");
    button.className = "bm-list-item" + (b === selectedBook ? " selected" : "");
    button.dataset.book = b.name;
    button.title = bookLabel(b);
    button.setAttribute("aria-pressed", String(b === selectedBook));
    const icon = document.createElement("span");
    icon.innerHTML = bookIcon(b.icon, b.icon_color || state.settings?.accent);
    icon.style.color = iconColor(b);
    const name = document.createElement("span");
    name.textContent = bookLabel(b);
    name.className = "bm-list-name";
    const count = document.createElement("span");
    count.textContent = String(b.notes.length);
    count.className = "bm-list-count";
    button.append(icon, name, count);
    button.addEventListener("click", () => {
      selectedBook = b;
      renderManager();
    });
    list.append(button);
  }
  const b = selectedBook;
  if (!b) return;
  $("#bm-selected").textContent = bookLabel(b);
  $("#bm-rename").disabled = !b.name;
  $("#bm-delete").disabled = !b.name;
  const icons = $("#bm-icons");
  icons.replaceChildren();
  for (const [id, label] of BOOK_ICONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.title = label;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String((b.icon || "book") === id));
    button.dataset.icon = id;
    button.disabled = appearanceBusy;
    button.innerHTML = bookIcon(id);
    button.addEventListener("click", () => void saveAppearance(b, id, b.icon_color || ""));
    icons.append(button);
  }
  const addColorButton = (container, color, title) => {
    const button = document.createElement("button");
    button.type = "button";
    button.title = title;
    button.dataset.color = color;
    button.disabled = appearanceBusy;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String((b.icon_color || "") === color));
    button.style.setProperty("--book-swatch", color || "var(--accent-grad)");
    button.addEventListener("click", () => void saveAppearance(b, b.icon || "book", color));
    if (color) container.append(button);
    else {
      const row = document.createElement("div");
      row.className = "bm-follow-color";
      const label = document.createElement("span");
      label.textContent = "跟随强调色";
      row.append(button, label);
      container.append(row);
    }
    return button;
  };
  const colors = $("#bm-colors");
  colors.replaceChildren();
  // “跟随强调色”保留，其余颜色统一来自可编辑的颜色库。
  addColorButton(colors, "", "跟随强调色");
  if (!notebookColorEditor) notebookColorEditor = makeSharedColorTools({
    getValue: () => selectedBook?.icon_color || state.settings?.accent || "#d9822b",
    onApply: (value) => selectedBook && saveAppearance(selectedBook, selectedBook.icon || "book", value),
  });
  $("#bm-colors").after(notebookColorEditor.root);
  notebookColorEditor.sync();
  for (const control of notebookColorEditor.root.querySelectorAll("button, input, select")) control.disabled = appearanceBusy;
}

async function saveAppearance(b, icon, color) {
  if (appearanceBusy || !state.books.includes(b)) return;
  if ((b.icon || "book") === icon && (b.icon_color || "") === color) return;
  appearanceBusy = true;
  $("#bm-error").hidden = true;
  // 保留正在操作的 checkbox/color input 节点，避免点击后立即重绘而重置勾选。
  try {
    await mutate(async () => {
      // 与正常的页面顺序/分组元信息保存串行，避免并发改写 .minipad.json。
      await saveMeta();
      await api.invoke("set_book_appearance", { book: b.name, icon, color });
      b.icon = icon === "book" ? "" : icon;
      b.icon_color = tidyAccent(color);
    });
    renderBook();
  } catch (e) {
    $("#bm-error").textContent = "保存图标失败：" + e;
    $("#bm-error").hidden = false;
  } finally {
    appearanceBusy = false;
    renderManager();
  }
}

// 列表里的键盘操作:上下键、Home、End 换项,回车、空格选中(按钮自带),F2 改名,Delete 删除
function onKey(e) {
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const items = [...$("#books").querySelectorAll("button:not(:disabled)")];
  const i = items.indexOf(document.activeElement);
  let to = -1;
  if (e.key === "ArrowDown") to = (i + 1) % items.length;
  else if (e.key === "ArrowUp") to = i <= 0 ? items.length - 1 : i - 1;
  else if (e.key === "Home") to = 0;
  else if (e.key === "End") to = items.length - 1;
  else if ((e.key === "F2" || e.key === "Delete") && !moving) {
    const b = itemBook.get(document.activeElement);
    // 「默认」不能改名也不能删
    if (!b?.name) return;
    e.preventDefault();
    if (e.key === "F2") renameBook(b);
    else deleteBook(b);
    return;
  }
  if (to < 0) return;
  e.preventDefault();
  items[to].focus();
}

export function bindBooks() {
  $("#books-new").addEventListener("click", () => createBook());
  $("#books-manage").addEventListener("click", openBookManager);
  $("#bm-close").addEventListener("click", () => { closeBookManager(); focusEditor(); });
  $("#bm-new").addEventListener("click", async () => {
    await createBook();
    if (!$("#book-manager").hidden) selectedBook = book();
    renderManager();
  });
  $("#bm-rename").addEventListener("click", () => { if (selectedBook) void renameBook(selectedBook); });
  $("#bm-delete").addEventListener("click", () => { if (selectedBook) void deleteBook(selectedBook); });
  $("#books").addEventListener("keydown", onKey);
  // 焦点跟着鼠标走,免得键盘选中的和鼠标指着的是两项
  $("#books").addEventListener("mousemove", (e) => {
    const item = e.target.closest("button");
    if (item && !item.disabled && document.activeElement !== item) item.focus({ preventScroll: true });
  });
}
