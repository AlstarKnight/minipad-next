// ---------- 界面风格的侧栏(0.4.4) ----------
// B · 语雀纸感:左边是笔记本和页面的目录树,点顶栏的笔记本按钮展开 / 收起;
// C · 星空渐变:左边一列笔记本图标,点一下切换笔记本。设置 → 外观 里可以各自关掉。
// 窗口太窄时不显示,笔记本按钮照旧弹出列表。小窗里没有侧栏。
import { isMiniWindow } from "./api.js";
import { $ } from "./dom.js";
import { state, book, bookLabel } from "./state.js";
import { bookIcon, iconColor } from "./bookicons.js";

const TREE_MIN = 560;
const RAIL_MIN = 400;
let treeOpen = true;
// 目录树里展开着的笔记本(按名字记);当前笔记本总是展开
const expanded = new Set();
let actions = null;

// 现在该显示哪种侧栏:"tree"、"rail" 或 ""
function mode() {
  const s = state.settings;
  if (isMiniWindow || !s) return "";
  const ui = document.documentElement.dataset.ui;
  if (ui === "paper" && s.ui_tree !== false) return treeOpen && innerWidth >= TREE_MIN ? "tree" : "";
  if (ui === "starry" && s.ui_rail !== false) return innerWidth >= RAIL_MIN ? "rail" : "";
  return "";
}

// 目录侧栏开着时,笔记本按钮用来展开 / 收起它;返回 false 表示照旧弹出笔记本列表
export function toggleTree() {
  const s = state.settings;
  if (isMiniWindow || document.documentElement.dataset.ui !== "paper" || s?.ui_tree === false || innerWidth < TREE_MIN) return false;
  treeOpen = !treeOpen;
  renderSidebar();
  return true;
}

function item(cls, label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.addEventListener("click", onClick);
  if (label) b.title = label;
  return b;
}

function icon(b) {
  const span = document.createElement("span");
  span.className = "side-icon";
  span.innerHTML = bookIcon(b.icon, b.icon_color || state.settings?.accent);
  span.style.color = iconColor(b);
  return span;
}

function text(cls, value) {
  const span = document.createElement("span");
  span.className = cls;
  span.textContent = value;
  return span;
}

function renderTree(el) {
  const current = book();
  for (const b of state.books) {
    const open = b === current || expanded.has(b.name);
    const row = item("side-book" + (b === current ? " current" : ""), bookLabel(b), () => {
      if (b === current) {
        if (expanded.has(b.name)) expanded.delete(b.name);
        else expanded.add(b.name);
        // 当前笔记本收不起来:点它只是回到编辑区
        renderSidebar();
      } else {
        expanded.add(b.name);
        void actions.switchBook(b);
      }
    });
    row.setAttribute("aria-expanded", String(open));
    const chev = text("side-chev", "");
    chev.innerHTML = '<svg viewBox="0 0 16 16"><path d="' + (open ? "M4.5 6.5 8 10l3.5-3.5" : "M6.5 4.5 10 8l-3.5 3.5") + '"/></svg>';
    row.append(chev, icon(b), text("side-name", bookLabel(b)));
    el.append(row);
    if (!open) continue;
    b.notes.forEach((n, i) => {
      const active = b === current && i === b.active;
      const page = item("side-page" + (active ? " current" : ""), n.name, () => actions.goTo(b, n));
      if (active) page.setAttribute("aria-current", "page");
      page.append(text("side-name", n.name));
      el.append(page);
    });
  }
  // 笔记本按钮在这里用来收起目录,改名、删除、导入这些还在原来的笔记本列表里
  const more = item("side-more", "", () => actions.openBooks());
  more.textContent = "笔记本列表…";
  el.append(more);
}

function renderRail(el) {
  const current = book();
  for (const b of state.books) {
    const row = item("side-rail-book" + (b === current ? " current" : ""), bookLabel(b), () => void actions.switchBook(b));
    if (b === current) row.setAttribute("aria-current", "true");
    row.append(icon(b), text("side-name", bookLabel(b)));
    el.append(row);
  }
  const add = item("side-add", "新建笔记本", () => void actions.createBook());
  add.setAttribute("aria-label", "新建笔记本");
  add.innerHTML = '<svg viewBox="0 0 16 16"><path d="M8 3.5v9M3.5 8h9"/></svg>';
  el.append(add);
}

export function renderSidebar() {
  const el = $("#side");
  if (!el) return;
  const m = mode();
  const root = document.documentElement;
  if (m) root.dataset.side = m;
  else delete root.dataset.side;
  el.hidden = !m;
  if (!m) return el.replaceChildren();
  const list = document.createElement("div");
  list.className = "side-list";
  if (m === "tree") renderTree(list);
  else renderRail(list);
  el.replaceChildren(list);
  el.setAttribute("aria-label", m === "tree" ? "目录" : "笔记本");
  el.querySelector(".current")?.scrollIntoView({ block: "nearest" });
}

// switchBook / goTo / createBook / openBooks 由 main.js 传进来,免得这里和 notebooks.js、tabs.js 互相引用
export function bindSidebar(fns) {
  actions = fns;
  addEventListener("resize", () => {
    const was = document.documentElement.dataset.side || "";
    if (mode() !== was) renderSidebar();
  });
}
