// ---------- 保存 ----------
import { api } from "./api.js";
import { $, editor } from "./dom.js";
import { state, book, current } from "./state.js";
import { updateCount } from "./page.js";

let saveTimer = null;
let metaTimer = null;
// 页面顺序、当前页面、模式改过的笔记本
const metaDirty = new Set();
// 换了当前笔记本,还没告诉后端
let bookDirty = false;

export function markDirty() {
  const n = current();
  if (!n) return;
  n.content = editor.value;
  n.dirty = true;
  setSaveStatus("dirty");
  updateCount();
  noteActivity();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushAll, 500);
}

// 保存所有笔记本里改过的页面
export async function flushAll() {
  clearTimeout(saveTimer);
  const dirty = [];
  for (const b of state.books) for (const n of b.notes) if (n.dirty) dirty.push([b, n]);
  if (!dirty.length) return;
  let failed = null;
  for (const [b, n] of dirty) {
    n.dirty = false;
    const content = n.content;
    try {
      await api.invoke("save_note", { book: b.name, name: n.name, content });
      n.disk = content;
    } catch (e) {
      n.dirty = true;
      failed = e;
    }
  }
  if (failed) {
    setSaveStatus("err", String(failed));
    // 过一会儿自动重试
    saveTimer = setTimeout(flushAll, 3000);
  } else {
    setSaveStatus("saved");
  }
}

export function scheduleMeta(b = book()) {
  if (b) metaDirty.add(b);
  clearTimeout(metaTimer);
  metaTimer = setTimeout(saveMeta, 300);
}

export function scheduleBooks() {
  bookDirty = true;
  clearTimeout(metaTimer);
  metaTimer = setTimeout(saveMeta, 300);
}

export async function saveMeta() {
  clearTimeout(metaTimer);
  // 已经删掉(或在别处消失)的笔记本不用再存
  const books = [...metaDirty].filter((b) => state.books.includes(b));
  metaDirty.clear();
  const sendBook = bookDirty;
  bookDirty = false;
  for (const b of books) {
    const modes = {};
    b.notes.forEach((n) => (modes[n.name] = n.mode));
    try {
      await api.invoke("save_meta", {
        book: b.name,
        order: b.notes.map((n) => n.name),
        active: b.notes[b.active]?.name ?? "",
        modes,
      });
    } catch (e) {
      console.error(e);
    }
  }
  if (sendBook && book()) {
    try {
      await api.invoke("set_current_book", { book: book().name });
    } catch (e) {
      console.error(e);
    }
  }
}

export function setSaveStatus(kind, msg) {
  const el = $("#st-save");
  el.className = kind === "dirty" ? "dirty" : kind === "err" ? "err" : "";
  el.textContent = kind === "dirty" ? "保存中…" : kind === "err" ? "保存失败:" + msg : "已保存";
}

// 告诉后端用户在打字:打过字的窗口在有焦点时不会自动贴边缩回去
let lastActivity = 0;
export function noteActivity() {
  const now = Date.now();
  if (now - lastActivity < 1000) return;
  lastActivity = now;
  api.invoke("note_activity").catch(() => {});
}

export function resetActivity() {
  lastActivity = 0;
}
