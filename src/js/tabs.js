// ---------- 标签(当前笔记本的页面) ----------
import { api } from "./api.js";
import { tabsEl } from "./dom.js";
import { state, book, current, makeNote } from "./state.js";
import { toast, ask, openMenu, focusEditor } from "./ui.js";
import { flushAll, scheduleMeta } from "./save.js";
import { mutate } from "./sync.js";
import { rememberView, showNote } from "./page.js";
import { openBooks } from "./notebooks.js";

// 正在拖动的标签对应的页面
let dragged = null;

export function renderTabs() {
  const b = book();
  tabsEl.innerHTML = "";
  if (!b) return;
  b.notes.forEach((n, i) => {
    const t = document.createElement("div");
    t.className = "tab" + (i === b.active ? " active" : "") + (n.unreadable ? " unreadable" : "");
    t.draggable = true;
    t.dataset.index = i;
    t.title = n.unreadable ? `${n.name}:读取失败:${n.reason || "未知错误"}` : n.name;
    const s = document.createElement("span");
    s.textContent = n.name;
    if (n.unreadable) {
      const warning = document.createElement("span");
      warning.className = "tab-warning";
      warning.textContent = "⚠";
      t.appendChild(warning);
    }
    t.appendChild(s);
    // 事件里用页面对象而不是位置,中途同步过也不会点错页面
    t.addEventListener("mousedown", (e) => {
      if (e.button === 0 && !t.querySelector("input")) switchTo(book().notes.indexOf(n));
    });
    // 按下鼠标时浏览器会把焦点从编辑区拿走,松开时再放回去,点完标签就能接着打字。
    // 换页时标签重画过,松开时鼠标下面已经是新画的标签,所以不用 click
    t.addEventListener("mouseup", (e) => {
      if (e.button === 0 && !t.querySelector("input")) focusEditor();
    });
    t.addEventListener("dblclick", () => startRename(n));
    t.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openMenu(
        [
          { id: "rename", label: "重命名", act: () => startRename(n) },
          { id: "move", label: "移到笔记本…", act: () => openBooks(n) },
          { id: "delete", label: "删除页面", act: () => deleteNote(n), danger: true },
        ],
        e.clientX,
        e.clientY
      );
    });
    t.addEventListener("dragstart", (e) => {
      dragged = n;
      e.dataTransfer.setData("text/x-tab", String(i));
      e.dataTransfer.effectAllowed = "move";
    });
    t.addEventListener("dragend", () => (dragged = null));
    t.addEventListener("dragover", (e) => {
      e.preventDefault();
      const after = e.offsetX > t.offsetWidth / 2;
      t.classList.toggle("drop-after", after);
      t.classList.toggle("drop-before", !after);
    });
    t.addEventListener("dragleave", () => t.classList.remove("drop-after", "drop-before"));
    t.addEventListener("drop", (e) => {
      e.preventDefault();
      const after = t.classList.contains("drop-after");
      t.classList.remove("drop-after", "drop-before");
      const notes = book().notes;
      if (notes.includes(n)) moveTab(notes.indexOf(dragged), notes.indexOf(n) + (after ? 1 : 0));
    });
    tabsEl.appendChild(t);
  });
  const act = tabsEl.children[b.active];
  act?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

export function moveTab(from, to) {
  const b = book();
  if (from < 0 || from === to || from + 1 === to) return;
  const activeNote = current();
  const [n] = b.notes.splice(from, 1);
  b.notes.splice(from < to ? to - 1 : to, 0, n);
  b.active = b.notes.indexOf(activeNote);
  renderTabs();
  scheduleMeta(b);
}

export function switchTo(i) {
  const b = book();
  if (i < 0 || i >= b.notes.length || i === b.active) return;
  rememberView();
  b.active = i;
  renderTabs();
  showNote();
  scheduleMeta(b);
}

export async function newNote() {
  await flushAll();
  try {
    await mutate(async () => {
      const b = book();
      const name = await api.invoke("create_note", { book: b.name, name: "新页面" });
      const n = makeNote(name, "");
      rememberView();
      const at = Math.min(b.active + 1, b.notes.length);
      b.notes.splice(at, 0, n);
      b.active = at;
      renderTabs();
      showNote();
      scheduleMeta(b);
      startRename(n);
    });
  } catch (e) {
    toast("新建失败:" + e);
  }
}

export function startRename(n) {
  const b = book();
  const t = tabsEl.children[b.notes.indexOf(n)];
  if (!t || t.querySelector("input")) return;
  const input = document.createElement("input");
  input.value = n.name;
  t.draggable = false;
  t.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const val = input.value.trim();
    if (commit && val && val !== n.name) {
      try {
        await mutate(async () => {
          await flushAll();
          n.name = await api.invoke("rename_note", { book: b.name, old: n.name, new: val });
          scheduleMeta(b);
        });
      } catch (e) {
        toast("重命名失败:" + e);
      }
    }
    renderTabs();
    focusEditor();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    // 输入法正在拼字时的回车、Esc 是给输入法的
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      finish(e.key === "Enter");
    }
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("mousedown", (e) => e.stopPropagation());
}

export async function deleteNote(n) {
  const b = state.books.find((x) => x.notes.includes(n));
  if (!b) return;
  const msg = n.content.trim()
    ? `删除页面「${n.name}」?\n文件会移到笔记文件夹的 .trash 里,需要时可以找回。`
    : `删除空白页面「${n.name}」?`;
  if (!(await ask(msg, "删除", true))) return;
  try {
    await mutate(async () => {
      await flushAll();
      await api.invoke("delete_note", { book: b.name, name: n.name });
      rememberView();
      removeNote(b, n);
      if (b === book()) {
        await ensurePage(b);
        renderTabs();
        showNote();
      }
      scheduleMeta(b);
    });
  } catch (e) {
    toast("删除失败:" + e);
  }
}

// 从笔记本里拿掉一个页面;拿掉的是当前页面就换成旁边那个
export function removeNote(b, n) {
  const idx = b.notes.indexOf(n);
  if (idx < 0) return;
  b.notes.splice(idx, 1);
  if (b.active >= b.notes.length || idx < b.active) b.active = Math.max(0, b.active - 1);
}

// 当前笔记本至少要有一个页面:空的就建一个「新页面」
export async function ensurePage(b) {
  if (!b || b.notes.length) return;
  await mutate(async () => {
    const name = await api.invoke("create_note", { book: b.name, name: "新页面" });
    b.notes.push(makeNote(name, ""));
    b.active = b.notes.length - 1;
    scheduleMeta(b);
  });
}
