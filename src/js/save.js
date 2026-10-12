// ---------- 保存 ----------
// 笔记与元信息各只有一个写入循环。新修改在当前写入完成后再写，
// 所有主动等待保存的操作都要等队列真正清空，失败则拒绝继续。
import { api } from "./api.js";
import { $ } from "./dom.js";
import { state, book, current } from "./state.js";
import { updateCount } from "./page.js";

let saveTimer = null;
let metaTimer = null;
let noteFlush = null;
let metaFlush = null;
const metaDirty = new Set();
let bookDirty = false;

// 防抖/重试为后台操作，错误由状态栏显示；主动 await 的调用会收到异常。
const backgroundNotes = () => { void flushAll().catch(() => {}); };
const backgroundMeta = () => { void saveMeta().catch(() => {}); };

export function markDirty(n = current()) {
  if (!n || n.unreadable) return;
  n.dirty = true;
  setSaveStatus("dirty");
  updateCount();
  noteActivity();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(backgroundNotes, 500);
}

// 同一时刻只允许一个保存循环；写入期间的新修改也会在返回前保存。
export function flushAll() {
  clearTimeout(saveTimer);
  if (!noteFlush) {
    noteFlush = writeDirtyNotes().finally(() => { noteFlush = null; });
  }
  return noteFlush;
}

async function writeDirtyNotes() {
  while (true) {
    const dirty = [];
    for (const b of state.books) for (const n of b.notes) if (n.dirty && !n.unreadable) dirty.push([b, n]);
    if (!dirty.length) {
      setSaveStatus("saved");
      return;
    }
    for (const [b, n] of dirty) {
      if (!n.dirty || n.unreadable || !state.books.includes(b) || !b.notes.includes(n)) continue;
      // 此时清除 dirty。写入进行中如有新编辑，markDirty 会再将它设为 true。
      n.dirty = false;
      const content = n.content;
      try {
        await api.invoke("save_note", { book: b.name, name: n.name, content });
        n.disk = content;
      } catch (e) {
        n.dirty = true;
        setSaveStatus("err", String(e));
        clearTimeout(saveTimer);
        saveTimer = setTimeout(backgroundNotes, 3000);
        throw e;
      }
    }
  }
}

export function scheduleMeta(b = book()) {
  if (b) metaDirty.add(b);
  clearTimeout(metaTimer);
  metaTimer = setTimeout(backgroundMeta, 300);
}

export function scheduleBooks() {
  bookDirty = true;
  clearTimeout(metaTimer);
  metaTimer = setTimeout(backgroundMeta, 300);
}

export function saveMeta() {
  clearTimeout(metaTimer);
  if (!metaFlush) {
    metaFlush = writeDirtyMeta().finally(() => { metaFlush = null; });
  }
  return metaFlush;
}

async function writeDirtyMeta() {
  while (metaDirty.size || bookDirty) {
    if (metaDirty.size) {
      const b = metaDirty.values().next().value;
      metaDirty.delete(b);
      if (!state.books.includes(b)) continue;
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
        metaDirty.add(b);
        setSaveStatus("err", String(e));
        metaTimer = setTimeout(backgroundMeta, 3000);
        throw e;
      }
    } else {
      const selected = book()?.name;
      bookDirty = false;
      if (selected == null) continue;
      try {
        await api.invoke("set_current_book", { book: selected });
      } catch (e) {
        bookDirty = true;
        setSaveStatus("err", String(e));
        metaTimer = setTimeout(backgroundMeta, 3000);
        throw e;
      }
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
