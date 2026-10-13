// ---------- 标签栏:标签放不下时怎么办(设置里选) ----------
// scroll(默认):一排滚动,标签的名字都完整显示;还有标签藏着的那一端淡出去,
//   放不下时标签后面多一个"全部页面"按钮,点开是能打字筛选的页面列表
// wrap:平时和 scroll 一样一排,点按钮展开成多行显示全部标签(盖在编辑区上面),选了页面就收回去
// drawer:标签收进侧拉的页面列表,顶栏只显示当前页的名字;列表可以钉住一直开在编辑区旁边,
//   窗口太窄放不下列表和正文时自动变回侧拉
import { $, tabsEl } from "./dom.js";
import { state, book } from "./state.js";
import { switchTo } from "./tabs.js";
import { focusEditor, toast } from "./ui.js";
import { groupsOn, groupOf, groupVars } from "./groups.js";
import { saveSettings } from "./settings.js";

// 钉住时正文至少要留这么宽,不然按侧拉处理
const MIN_TEXT = 220;
const MODES = ["scroll", "wrap", "drawer"];

let opts = { mode: "scroll", fade: true, list: true, rows: 4, side: "left", width: 200, hover: false, pinned: false };
// 鼠标移到边缘拉出来的(鼠标离开列表就收回去)
let byHover = false;

const bar = () => $("#bar");
const drawer = () => $("#drawer");
const root = document.documentElement;

export function tabsVertical() {
  return opts.mode === "drawer";
}

export function applyTabBarSettings(s) {
  const mode = MODES.includes(s.tab_overflow) ? s.tab_overflow : "scroll";
  opts = {
    mode,
    fade: s.tab_fade !== false,
    list: s.tab_list_button !== false,
    rows: Math.min(8, Math.max(2, Number(s.tab_rows) || 4)),
    side: s.tab_drawer_side === "right" ? "right" : "left",
    width: Math.min(360, Math.max(140, Number(s.tab_drawer_width) || 200)),
    hover: !!s.tab_drawer_hover,
    pinned: !!s.tab_drawer_pinned,
  };
  root.dataset.tabOverflow = mode;
  root.dataset.groupStyle = s.tab_group_style === "tint" ? "tint" : "line";
  root.style.setProperty("--tab-rows", String(opts.rows));
  root.style.setProperty("--dr-w", `${opts.width}px`);
  drawer().dataset.side = opts.side;
  $("#drawer-edge").dataset.side = opts.side;
  if (mode !== "wrap") setExpanded(false);
  if (mode !== "scroll") closePagesMenu();
  // 标签搬进侧拉列表,或者搬回顶栏(搬回去时还放在笔记本按钮和"全部页面"按钮中间)
  if (mode === "drawer") {
    if (tabsEl.parentElement !== $("#dr-list")) $("#dr-list").appendChild(tabsEl);
    // 列表里的空白处不能拖动窗口
    tabsEl.removeAttribute("data-tauri-drag-region");
    tabsEl.scrollLeft = 0;
  } else {
    if (tabsEl.parentElement !== bar()) bar().insertBefore(tabsEl, $("#btn-all"));
    tabsEl.setAttribute("data-tauri-drag-region", "");
    if (!drawer().hidden) closeDrawer();
  }
  drawer().hidden = mode !== "drawer";
  $("#btn-pages").hidden = mode !== "drawer";
  $("#drawer-edge").hidden = mode !== "drawer" || !opts.hover;
  $("#dr-pin").classList.toggle("on", opts.pinned);
  $("#dr-pin").setAttribute("aria-pressed", String(opts.pinned));
  $("#dr-pin").title = opts.pinned ? "取消钉住" : "钉住页面列表";
  layoutDrawer();
  refreshTabBar();
}

// 标签重画以后、窗口大小变了以后:渐隐、"全部页面"按钮、当前页的名字、列表的筛选
export function refreshTabBar() {
  const b = book();
  const count = b ? b.notes.length : 0;
  $("#all-count").textContent = String(count);
  $("#dr-count").textContent = String(count);
  const cur = b?.notes[b.active];
  $("#cur-page").firstElementChild.textContent = cur ? cur.name : "";
  $("#btn-pages").title = cur ? `${cur.name} · 页面列表` : "页面列表";
  const name = $("#cur-page");
  name.classList.toggle("long", opts.mode === "drawer" && name.scrollWidth > name.clientWidth + 1);
  updateOverflow();
  if (opts.mode === "drawer") filterDrawer();
  if (!$("#pages-menu").hidden) fillPagesMenu();
}

function updateOverflow() {
  const btn = $("#btn-all");
  const expanded = bar().dataset.expanded === "true";
  if (opts.mode === "drawer") {
    btn.hidden = true;
    tabsEl.classList.remove("fade-l", "fade-r");
    return;
  }
  const over = tabsEl.scrollWidth > tabsEl.clientWidth + 1;
  const fade = opts.fade && !expanded;
  tabsEl.classList.toggle("fade-l", fade && tabsEl.scrollLeft > 1);
  tabsEl.classList.toggle("fade-r", fade && tabsEl.scrollLeft + tabsEl.clientWidth < tabsEl.scrollWidth - 1);
  if (opts.mode === "scroll") {
    btn.hidden = !opts.list || (!over && $("#pages-menu").hidden);
    btn.title = "全部页面";
  } else {
    btn.hidden = !over && !expanded;
    btn.title = expanded ? "收起标签" : "展开全部标签";
  }
}

// ---- 换了页面以后:展开的多行收回去,没钉住的侧拉列表收回去 ----
export function afterSwitch() {
  let closed = false;
  if (bar().dataset.expanded === "true") {
    setExpanded(false);
    closed = true;
  }
  if (drawer().classList.contains("open") && !isPinned()) {
    closeDrawer();
    closed = true;
  }
  if (closed) focusEditor();
}

// Esc、打开别的弹层时关掉;有开着的就返回 true
export function closeTabPopups() {
  let was = closePagesMenu();
  if (bar().dataset.expanded === "true") {
    setExpanded(false);
    was = true;
  }
  if (drawer().classList.contains("open") && !isPinned()) {
    closeDrawer();
    was = true;
  }
  return was;
}

// ---- 多行:点按钮展开 / 收起 ----
function setExpanded(on) {
  const was = bar().dataset.expanded === "true";
  if (on && !was) {
    // 标签原来的位置留一个同样宽的空位,顶栏上的按钮不跳
    const ph = document.createElement("div");
    ph.id = "tabs-ph";
    ph.style.width = tabsEl.offsetWidth + "px";
    bar().insertBefore(ph, tabsEl);
    root.style.setProperty("--sheet-top", bar().getBoundingClientRect().bottom + "px");
    bar().dataset.expanded = "true";
  } else if (!on) {
    $("#tabs-ph")?.remove();
    delete bar().dataset.expanded;
  }
  $("#btn-all").setAttribute("aria-expanded", String(on));
  if (!on) tabsEl.scrollTop = 0;
  updateOverflow();
  if (!on) revealActive();
}

const tabAtActive = () => tabsEl.querySelector(".tab.active");

// 让当前页的标签露出来;标签比标签栏还宽时露出开头
export function revealActive() {
  const t = tabAtActive();
  if (!t) return;
  if (opts.mode !== "drawer" && bar().dataset.expanded !== "true" && t.offsetWidth > tabsEl.clientWidth) {
    tabsEl.scrollLeft += t.getBoundingClientRect().left - tabsEl.getBoundingClientRect().left;
  } else {
    t.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

// ---- 全部页面的列表 ----
function openPagesMenu() {
  const m = $("#pages-menu");
  $("#pm-filter").value = "";
  m.hidden = false;
  fillPagesMenu();
  const r = $("#btn-all").getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(r.right - m.offsetWidth, window.innerWidth - m.offsetWidth - 4)) + "px";
  m.style.top = r.bottom + 4 + "px";
  $("#btn-all").setAttribute("aria-expanded", "true");
  $("#pm-filter").focus();
  m.querySelector(".on")?.scrollIntoView({ block: "nearest" });
}

function closePagesMenu() {
  const m = $("#pages-menu");
  if (m.hidden) return false;
  m.hidden = true;
  $("#btn-all").setAttribute("aria-expanded", "false");
  updateOverflow();
  return true;
}

const matches = (name, q) => !q || name.toLowerCase().includes(q);

function fillPagesMenu() {
  const b = book();
  if (!b) return;
  const q = $("#pm-filter").value.trim().toLowerCase();
  const items = [];
  b.notes.forEach((n, i) => {
    if (!matches(n.name, q)) return;
    const it = document.createElement("button");
    it.type = "button";
    it.className = "pm-item" + (i === b.active ? " on" : "");
    it.setAttribute("role", "option");
    it.setAttribute("aria-selected", String(i === b.active));
    const g = groupsOn() ? groupOf(b, n) : null;
    if (g) {
      const dot = document.createElement("i");
      dot.className = "pm-dot";
      groupVars(dot, g.color);
      dot.title = g.name || "未命名分组";
      it.appendChild(dot);
    }
    const s = document.createElement("span");
    s.textContent = n.name;
    it.appendChild(s);
    it.addEventListener("click", () => {
      closePagesMenu();
      switchTo(book().notes.indexOf(n));
      focusEditor();
    });
    items.push(it);
  });
  if (!items.length) {
    const none = document.createElement("div");
    none.className = "menu-hint";
    none.textContent = "没有找到";
    items.push(none);
  }
  $("#pm-list").replaceChildren(...items);
}

// ---- 侧拉的页面列表 ----
function isPinned() {
  return opts.mode === "drawer" && opts.pinned && window.innerWidth >= opts.width + MIN_TEXT;
}

function layoutDrawer() {
  const pinned = isPinned();
  root.dataset.drawer = opts.mode !== "drawer" ? "" : pinned ? "pinned" : drawer().classList.contains("open") ? "open" : "closed";
  root.dataset.drawerSide = opts.side;
  drawer().style.top = bar().getBoundingClientRect().bottom + "px";
  $("#drawer-edge").style.top = drawer().style.top;
  $("#btn-pages").setAttribute("aria-expanded", String(pinned || drawer().classList.contains("open")));
}

function openDrawer(hover = false) {
  if (opts.mode !== "drawer" || isPinned()) return;
  byHover = hover;
  drawer().classList.add("open");
  layoutDrawer();
  tabAtActive()?.scrollIntoView({ block: "nearest" });
  if (!hover) (tabAtActive() || $("#dr-filter")).focus?.();
}

function closeDrawer() {
  byHover = false;
  drawer().classList.remove("open");
  $("#dr-filter").value = "";
  filterDrawer();
  layoutDrawer();
}

function filterDrawer() {
  const q = $("#dr-filter").value.trim().toLowerCase();
  const b = book();
  if (!b) return;
  for (const t of tabsEl.querySelectorAll(".tab")) {
    const n = b.notes[Number(t.dataset.index)];
    t.classList.toggle("filtered", !!n && !matches(n.name, q));
  }
  for (const c of tabsEl.querySelectorAll(".tab-group")) {
    const any = b.notes.some((n) => n.group === c.dataset.group && matches(n.name, q));
    c.classList.toggle("filtered", !any);
  }
  // 筛选时折叠起来的分组也搜进去
  tabsEl.classList.toggle("filtering", !!q);
}

async function togglePinned() {
  const pinned = !opts.pinned;
  try {
    await saveSettings({ ...state.settings, tab_drawer_pinned: pinned });
    if (pinned) drawer().classList.remove("open");
    layoutDrawer();
  } catch (e) {
    toast(String(e));
  }
}

export function bindTabBar() {
  // 一排时滚轮横向滚动;展开成多行时照常上下滚
  tabsEl.addEventListener("wheel", (e) => {
    if (!e.deltaY || opts.mode === "drawer" || bar().dataset.expanded === "true") return;
    e.preventDefault();
    tabsEl.scrollLeft += e.deltaY;
  });
  tabsEl.addEventListener("scroll", updateOverflow, { passive: true });
  new ResizeObserver(() => {
    updateOverflow();
    layoutDrawer();
  }).observe(tabsEl);
  window.addEventListener("resize", () => {
    updateOverflow();
    layoutDrawer();
  });

  $("#btn-all").addEventListener("click", () => {
    if (opts.mode === "wrap") setExpanded(bar().dataset.expanded !== "true");
    else if ($("#pages-menu").hidden) openPagesMenu();
    else closePagesMenu();
  });
  $("#pm-filter").addEventListener("input", fillPagesMenu);
  $("#pages-menu").addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    const items = [...$("#pm-list").querySelectorAll("button")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      if (!items.length) return;
      if (i < 0) (d > 0 ? items[0] : items[items.length - 1]).focus();
      else if (i + d < 0) $("#pm-filter").focus();
      else items[Math.min(items.length - 1, i + d)].focus();
    } else if (e.key === "Enter" && e.target === $("#pm-filter")) {
      e.preventDefault();
      items[0]?.click();
    }
  });

  $("#btn-pages").addEventListener("click", () => {
    if (isPinned()) return focusEditor();
    if (drawer().classList.contains("open")) closeDrawer();
    else openDrawer();
  });
  // 当前页的名字顶栏放不下时,鼠标移上去慢慢滚到末尾
  const name = $("#cur-page");
  $("#btn-pages").addEventListener("mouseenter", () => {
    const over = name.firstElementChild.offsetWidth - name.clientWidth;
    if (over <= 1) return;
    name.style.setProperty("--marquee", `${Math.max(0.4, over / 60)}s`);
    name.classList.add("rolling");
    name.firstElementChild.style.transform = `translateX(${-over}px)`;
  });
  $("#btn-pages").addEventListener("mouseleave", () => {
    name.style.setProperty("--marquee", "0.2s");
    name.classList.remove("rolling");
    name.firstElementChild.style.transform = "";
  });
  $("#dr-pin").addEventListener("click", togglePinned);
  $("#dr-filter").addEventListener("input", filterDrawer);
  $("#dr-filter").addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      const t = tabsEl.querySelector(".tab:not(.filtered)");
      if (t) switchTo(Number(t.dataset.index));
    }
  });
  $("#drawer-edge").addEventListener("mouseenter", () => openDrawer(true));
  drawer().addEventListener("mouseleave", (e) => {
    // 拖动标签、右键菜单开着时不收
    if (byHover && !e.buttons && $("#ctx").hidden && $("#group-edit").hidden) closeDrawer();
  });

  // 点到别处就关掉
  document.addEventListener("mousedown", (e) => {
    const t = e.target;
    if (!t.closest("#pages-menu, #btn-all")) closePagesMenu();
    if (bar().dataset.expanded === "true" && !t.closest("#tabs, #btn-all, #ctx, #group-edit, #dialog")) setExpanded(false);
    if (drawer().classList.contains("open") && !isPinned() && !t.closest("#drawer, #btn-pages, #ctx, #group-edit, #dialog, #books")) closeDrawer();
  });
}
