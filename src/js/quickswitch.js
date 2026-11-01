// ---------- 快速切换页面(默认 Ctrl+P,设置 → 快捷键 里可以换或者关掉) ----------
// 打几个字找页面名字(也能带上笔记本的名字,空格隔开;可以打拼音),上下键选,回车打开(Shift+回车放进小窗);
// 什么都没打时列出最近打开过的页面。设置里可以只找当前笔记本
import { $ } from "./dom.js";
import { state, book, current, bookLabel } from "./state.js";
import { closeOverlays, focusEditor } from "./ui.js";
import { recent } from "./page.js";
import { goTo } from "./tabs.js";
import { openInMini } from "./mini.js";
import { isMiniWindow } from "./api.js";
import { pageScore, termsOf } from "./match.js";
import { comboOf } from "./shortcuts.js";

// [{ b, n }]
let results = [];
let sel = 0;

export function openQuick() {
  closeOverlays();
  $("#quick").hidden = false;
  const input = $("#quick-input");
  input.value = "";
  input.placeholder = state.settings?.quick_switch_scope === "book" ? `在「${bookLabel(book())}」里找页面……` : "找页面,可以加上笔记本的名字……";
  input.focus();
  run();
}

export function closeQuick() {
  if ($("#quick").hidden) return false;
  $("#quick").hidden = true;
  focusEditor();
  return true;
}

// 要找的页面:当前笔记本在前,其余按笔记本列表的顺序
function pool() {
  const books = state.settings?.quick_switch_scope === "book" ? [book()] : [book(), ...state.books.filter((b) => b !== book())];
  return books.flatMap((b) => b.notes.map((n) => ({ b, n })));
}

// 每个词都要对上页面名字或者笔记本名字;名字一样、对上名字开头的最靠前,也能按拼音找(见 match.js)
function score({ b, n }, terms) {
  return pageScore(n.name, bookLabel(b), terms, state.settings?.pinyin_match !== false);
}

function run() {
  const terms = termsOf($("#quick-input").value);
  const all = pool();
  const order = new Map(all.map((x, i) => [x.n, i]));
  const live = new Set(all.map((x) => x.n));
  const seen = recent.filter((n) => live.has(n) && n !== current());
  const rank = (n) => {
    const i = seen.indexOf(n);
    return i < 0 ? Infinity : i;
  };
  if (!terms.length) {
    // 最近打开过的在前,然后是当前笔记本和其他笔记本的页面
    results = [...all].filter((x) => x.n !== current()).sort((x, y) => rank(x.n) - rank(y.n) || order.get(x.n) - order.get(y.n));
  } else {
    results = all
      .map((x) => ({ ...x, s: score(x, terms) }))
      .filter((x) => x.s >= 0)
      .sort((x, y) => y.s - x.s || rank(x.n) - rank(y.n) || order.get(x.n) - order.get(y.n));
  }
  results = results.slice(0, 200);
  sel = 0;
  const many = state.books.length > 1 && state.settings?.quick_switch_scope !== "book";
  const box = $("#quick-results");
  box.dataset.empty = all.length ? "没有找到" : "没有页面";
  box.replaceChildren(
    ...results.map((r, i) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "result" + (i === 0 ? " sel" : "");
      el.setAttribute("role", "option");
      const name = document.createElement("div");
      name.className = "snip title";
      name.textContent = r.n.name;
      el.appendChild(name);
      const where = [];
      if (many) where.push(bookLabel(r.b));
      if (!terms.length && rank(r.n) !== Infinity) where.push("最近打开");
      if (where.length) {
        const w = document.createElement("div");
        w.className = "where";
        w.textContent = where.join(" · ");
        el.appendChild(w);
      }
      el.addEventListener("click", () => pick(i));
      return el;
    }),
  );
}

function move(d) {
  const items = $("#quick-results").children;
  if (!items.length) return;
  items[sel]?.classList.remove("sel");
  sel = (sel + d + items.length) % items.length;
  items[sel].classList.add("sel");
  items[sel].scrollIntoView({ block: "nearest" });
}

function pick(i, mini = false) {
  const r = results[i];
  if (!r) return;
  $("#quick").hidden = true;
  if (mini) return void openInMini(r.b, r.n);
  goTo(r.b, r.n);
  focusEditor();
}

export function bindQuick() {
  const input = $("#quick-input");
  input.addEventListener("input", (e) => {
    if (!e.isComposing) run();
  });
  input.addEventListener("compositionend", run);
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown") (e.preventDefault(), move(1));
    else if (e.key === "ArrowUp") (e.preventDefault(), move(-1));
    // Shift+Enter:放进小窗打开
    else if (e.key === "Enter") (e.preventDefault(), pick(sel, e.shiftKey));
  });
  // 快捷键在编辑器之前处理,设置里选了和编辑器一样的键(比如 Ctrl+B)也是打开快速切换
  document.addEventListener(
    "keydown",
    (e) => {
      const key = state.settings?.quick_switch_key;
      if (!key || isMiniWindow || e.isComposing || e.keyCode === 229 || e.target.closest?.(".key-keys")) return;
      if (comboOf(e)?.toLowerCase() !== key.toLowerCase()) return;
      e.preventDefault();
      e.stopPropagation();
      if (!$("#quick").hidden) closeQuick();
      // 对话框、设置、导入、回收站开着时不打开,免得把里面没保存的东西关掉
      else if (!state.books.length || ["#dialog", "#settings", "#import", "#trash"].some((sel) => !$(sel).hidden)) return;
      else openQuick();
    },
    true,
  );
}
