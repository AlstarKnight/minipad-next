// ---------- 回收站:删掉的页面和笔记本,可以恢复,也可以彻底删除 ----------
// 从笔记本列表或者设置里打开;从设置里打开时盖在设置上面,关掉以后回到设置
import { api } from "./api.js";
import { $ } from "./dom.js";
import { state, bookLabel } from "./state.js";
import { toast, ask, focusEditor } from "./ui.js";
import { flushAll, saveMeta } from "./save.js";
import { mutate, applyDisk } from "./sync.js";
import { goTo } from "./tabs.js";
import { switchBook, closeBooks } from "./notebooks.js";

let items = [];
let busy = false;

const PAGE_ICON = '<svg viewBox="0 0 16 16"><path d="M4 1.8h5.2L12 4.6v9.6H4z"/><path d="M9 1.8v3h3M6 8h4M6 10.5h4"/></svg>';
const BOOK_ICON = '<svg viewBox="0 0 16 16"><path d="M3 2.5h8.5a1 1 0 0 1 1 1v10H4a1 1 0 0 1-1-1z"/><path d="M3 12.5a1 1 0 0 1 1-1h8.5M6 5.5h4"/></svg>';

export async function openTrash() {
  closeBooks();
  $("#trash-filter").value = "";
  showError("");
  $("#trash").hidden = false;
  await refresh();
  $("#trash-filter").focus();
}

// 关掉回收站,返回原来开着没有
export function closeTrash() {
  if ($("#trash").hidden) return false;
  if (busy) return true;
  $("#trash").hidden = true;
  if (!$("#settings").hidden) $("#set-trash").focus();
  else focusEditor();
  return true;
}

async function refresh() {
  try {
    items = await api.invoke("trash_list");
  } catch (e) {
    items = [];
    showError(String(e));
  }
  render();
}

function when(secs) {
  const d = new Date(secs * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  const year = d.getFullYear() === new Date().getFullYear() ? "" : `${d.getFullYear()}年`;
  return `${year}${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function render() {
  const q = $("#trash-filter").value.trim().toLowerCase();
  const shown = items.filter((it) => !q || it.name.toLowerCase().includes(q) || it.preview.toLowerCase().includes(q));
  const list = $("#trash-list");
  list.dataset.empty = items.length ? "没有找到" : "回收站是空的";
  list.replaceChildren(
    ...shown.map((it) => {
      const row = document.createElement("div");
      row.className = "trash-item";
      row.setAttribute("role", "listitem");
      row.dataset.kind = it.kind;
      const icon = document.createElement("span");
      icon.className = "ti-icon";
      icon.innerHTML = it.kind === "book" ? BOOK_ICON : PAGE_ICON;
      const body = document.createElement("div");
      body.className = "ti-body";
      const name = document.createElement("div");
      name.className = "ti-name";
      name.textContent = it.name;
      const meta = document.createElement("div");
      meta.className = "ti-meta";
      const from = it.kind === "book" ? `笔记本 · ${it.pages} 页` : it.kind === "file" ? "WebDAV 同步文件" : `来自「${bookLabel({ name: it.book })}」`;
      meta.textContent = `${from} · ${when(it.deleted)} 删除`;
      body.append(name, meta);
      if (it.preview) {
        const p = document.createElement("div");
        p.className = "ti-preview";
        p.textContent = it.preview;
        body.appendChild(p);
      }
      const restore = document.createElement("button");
      restore.className = "small";
      restore.dataset.act = "restore";
      restore.textContent = "恢复";
      restore.title = it.kind === "book" ? "恢复这个笔记本" : it.kind === "file" ? "恢复到原来的文件夹" : `恢复到「${bookLabel({ name: it.book })}」笔记本`;
      restore.addEventListener("click", () => restoreItem(it));
      const purge = document.createElement("button");
      purge.className = "small danger-text";
      purge.dataset.act = "purge";
      purge.textContent = "彻底删除";
      purge.addEventListener("click", () => purgeItem(it));
      const acts = document.createElement("div");
      acts.className = "ti-acts";
      acts.append(restore, purge);
      row.append(icon, body, acts);
      return row;
    }),
  );
  $("#trash-count").textContent = items.length ? `${items.length} 项` : "";
  $("#trash-empty").disabled = !items.length || busy;
}

// 改了笔记文件夹:不和磁盘同步,做完以后读回来
async function change(fn) {
  busy = true;
  showError("");
  for (const b of $("#trash").querySelectorAll("button")) b.disabled = true;
  try {
    await flushAll();
    await saveMeta();
    return await mutate(async () => {
      try {
        return await fn();
      } finally {
        await applyDisk(await api.invoke("read_notes"));
      }
    });
  } catch (e) {
    showError(String(e));
    return null;
  } finally {
    busy = false;
    for (const b of $("#trash").querySelectorAll("button")) b.disabled = false;
    await refresh();
  }
}

async function restoreItem(it) {
  const r = await change(() => api.invoke("trash_restore", { id: it.id }));
  if (!r) return;
  if (it.kind === "file") { toast(`已恢复文件「${it.name}」`); return; }
  const b = state.books.find((x) => x.name === r.book);
  const where = r.name ? `「${bookLabel({ name: r.book })}」里的「${r.name}」` : `笔记本「${r.book}」`;
  toast(`已恢复${where}`);
  if (!b || !$("#settings").hidden) return;
  if (r.name) goTo(b, b.notes.find((n) => n.name === r.name));
  else await switchBook(b);
}

async function purgeItem(it) {
  const what = it.kind === "book" ? `笔记本「${it.name}」和里面的 ${it.pages} 页` : it.kind === "file" ? `文件「${it.name}」` : `页面「${it.name}」`;
  if (!(await ask(`彻底删除${what}?\n删除以后只能从每日备份里找回。`, "彻底删除", true, true))) return;
  await change(() => api.invoke("trash_purge", { id: it.id }));
}

async function emptyTrash() {
  if (!items.length) return;
  if (!(await ask(`清空回收站,彻底删除这 ${items.length} 项?\n删除以后只能从每日备份里找回。`, "清空", true, true))) return;
  const n = await change(() => api.invoke("trash_empty"));
  if (n != null) toast(`已清空回收站(${n} 项)`);
}

function showError(msg) {
  const el = $("#trash-error");
  el.textContent = msg;
  el.hidden = !msg;
}

export function bindTrash() {
  $("#books-trash").addEventListener("click", openTrash);
  $("#set-trash").addEventListener("click", openTrash);
  $("#trash-filter").addEventListener("input", render);
  $("#trash-empty").addEventListener("click", emptyTrash);
  $("#trash-close").addEventListener("click", closeTrash);
}
