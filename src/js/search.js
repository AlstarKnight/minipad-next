// ---------- 搜索(全部笔记本) ----------
import { $ } from "./dom.js";
import { state, book, current, bookLabel } from "./state.js";
import { closeOverlays } from "./ui.js";
import { scheduleMeta, scheduleBooks } from "./save.js";
import { rememberView, showNote } from "./page.js";
import { renderTabs } from "./tabs.js";
import { renderBook } from "./notebooks.js";
import { editorSelectionText, selectInEditor } from "./editor.js";

// { b: 笔记本, n: 页面, pos: 匹配位置,-1 表示标题 }
let results = [];
let resultSel = 0;

export function openSearch() {
  closeOverlays();
  $("#search").hidden = false;
  const input = $("#search-input");
  // 编辑时选中了一段文字(不跨行),就拿来当搜索词
  const sel = current()?.mode === "edit" ? editorSelectionText() : "";
  if (sel && !sel.includes("\n")) input.value = sel;
  input.focus();
  input.select();
  runSearch();
}

function runSearch() {
  const q = $("#search-input").value;
  const box = $("#search-results");
  results = [];
  resultSel = 0;
  box.innerHTML = "";
  box.dataset.empty = q ? "没有找到" : "输入关键字,搜索所有笔记本里页面的内容和标题";
  if (!q) return;
  const ql = q.toLowerCase();
  // 当前笔记本的结果排在最前,其余按笔记本列表的顺序
  for (const b of [book(), ...state.books.filter((x) => x !== book())]) {
    for (const n of b.notes) {
      if (n.name.toLowerCase().includes(ql)) results.push({ b, n, pos: -1 });
      const text = n.content.toLowerCase();
      let pos = text.indexOf(ql);
      while (pos !== -1 && results.length < 300) {
        results.push({ b, n, pos });
        pos = text.indexOf(ql, pos + ql.length);
      }
    }
  }
  // 只有一个笔记本时不用写笔记本的名字
  const many = state.books.length > 1;
  results.slice(0, 300).forEach((r, idx) => {
    const n = r.n;
    const label = esc(bookLabel(r.b));
    const el = document.createElement("button");
    el.className = "result" + (idx === 0 ? " sel" : "");
    if (r.pos === -1) {
      el.innerHTML = `<div class="where">页面标题${many ? " · " + label : ""}</div><div class="snip">${mark(n.name, ql)}</div>`;
    } else {
      const lineNo = n.content.slice(0, r.pos).split("\n").length;
      const ls = n.content.lastIndexOf("\n", r.pos - 1) + 1;
      let le = n.content.indexOf("\n", r.pos);
      if (le === -1) le = n.content.length;
      const start = Math.max(ls, r.pos - 30);
      const line = (start > ls ? "…" : "") + n.content.slice(start, le);
      const where = (many ? label + " › " : "") + `${esc(n.name)} · 第 ${lineNo} 行`;
      el.innerHTML = `<div class="where">${where}</div><div class="snip">${mark(line, ql)}</div>`;
    }
    el.addEventListener("click", () => openResult(idx));
    box.appendChild(el);
  });
}

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function mark(s, ql) {
  const out = [];
  const low = s.toLowerCase();
  let i = 0;
  let p;
  while ((p = low.indexOf(ql, i)) !== -1) {
    out.push(esc(s.slice(i, p)), "<mark>", esc(s.slice(p, p + ql.length)), "</mark>");
    i = p + ql.length;
  }
  out.push(esc(s.slice(i)));
  return out.join("");
}

function moveResult(d) {
  const items = $("#search-results").children;
  if (!items.length) return;
  items[resultSel]?.classList.remove("sel");
  resultSel = (resultSel + d + items.length) % items.length;
  items[resultSel].classList.add("sel");
  items[resultSel].scrollIntoView({ block: "nearest" });
}

function openResult(idx) {
  const r = results[idx];
  if (!r) return;
  const qlen = $("#search-input").value.length;
  closeOverlays();
  // 搜索框开着的时候同步过,页面可能已经不在了
  if (!state.books.includes(r.b) || !r.b.notes.includes(r.n)) return;
  rememberView();
  if (r.b !== book()) {
    state.book = state.books.indexOf(r.b);
    renderBook();
    scheduleBooks();
  }
  const b = book();
  const n = r.n;
  b.active = b.notes.indexOf(n);
  n.mode = "edit";
  renderTabs();
  showNote();
  scheduleMeta(b);
  // 选中匹配的文字,滚到窗口中间
  if (r.pos >= 0) selectInEditor(r.pos, r.pos + qlen);
}

export function bindSearch() {
  const input = $("#search-input");
  input.addEventListener("input", runSearch);
  input.addEventListener("keydown", (e) => {
    // 输入法正在拼字时的回车是给输入法的
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown") (e.preventDefault(), moveResult(1));
    else if (e.key === "ArrowUp") (e.preventDefault(), moveResult(-1));
    else if (e.key === "Enter") (e.preventDefault(), openResult(resultSel));
  });
}
