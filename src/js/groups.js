// ---------- 标签分组(设置里打开,默认关闭):像 Edge 那样把几页标签放进一个分组 ----------
// 分组有名字和颜色,排在组里第一个标签前面;点分组的名字折叠 / 展开,右键打开分组设置(名字、颜色、取消分组)。
// 右键标签可以加进新分组、移到别的分组、移出分组;把标签拖到组里的标签旁边也就进了这个分组。
// 分组存在每个笔记本的 .minipad.json 里(save_meta 的 groups / note_groups),关掉分组功能时分组还留着,再打开就回来
import { $ } from "./dom.js";
import { state, book } from "./state.js";
import { scheduleMeta } from "./save.js";
import { renderTabs, newNote } from "./tabs.js";
import { gradientOf, parseAccent, tidyAccent } from "./accent.js";
import { makeSharedColorTools } from "./sharedcolors.js";

// 这份颜色用于给新建分组自动分配不重复的默认色，仍有实际调用。
const GROUP_COLORS = [
  ["灰色", "#8a8f98"], ["蓝色", "#4c8bf5"], ["红色", "#e5534b"],
  ["黄色", "#d4a72c"], ["绿色", "#3fa66b"], ["粉色", "#e0609e"],
  ["紫色", "#8e6bf0"], ["青色", "#2fa8b8"], ["橙色", "#e8833a"],
];

// 分组的颜色放到元素上:--g 是纯色(渐变取起点),--g-grad 是整条颜色(纯色或渐变),
// --g-soft / --g-soft2 / --g-tint 是淡一些的同样的颜色(分组名字的底色、鼠标移上去、整个标签染色)
export function groupVars(el, color) {
  const a = parseAccent(color) || parseAccent(GROUP_COLORS[0][1]);
  const stops = a.to ? a.stops : [a.from, a.from];
  const angle = a.deg ?? 90;
  const fade = (p) => gradientOf(stops.map((c) => `color-mix(in srgb, ${c} ${p}%, transparent)`), angle, a.positions);
  el.style.setProperty("--g", a.from);
  // 细线和淡色背景使用相同角度，保留自定义节点位置。
  el.style.setProperty("--g-grad", gradientOf(stops, angle, a.positions));
  el.style.setProperty("--g-soft", fade(24));
  el.style.setProperty("--g-soft2", fade(36));
  el.style.setProperty("--g-tint", fade(15));
}

export const groupsOn = () => !!state.settings?.tab_groups;

export function groupOf(b, n) {
  return (n?.group && b.groups.find((g) => g.id === n.group)) || null;
}

export const groupLabel = (g) => g.name || "未命名分组";

// 同一组的页面排在一起(组的位置是组里第一页原来的位置),没有页面的分组去掉;当前页面跟着对象走
export function tidyGroups(b) {
  const active = b.notes[b.active];
  const out = [];
  const seen = new Set();
  for (const n of b.notes) {
    const g = groupOf(b, n);
    if (!g) {
      out.push(n);
    } else if (!seen.has(g.id)) {
      seen.add(g.id);
      out.push(...b.notes.filter((x) => x.group === g.id));
    }
  }
  b.notes.splice(0, b.notes.length, ...out);
  b.groups = b.groups.filter((g) => seen.has(g.id));
  b.active = Math.max(0, out.indexOf(active));
}

function changed(b) {
  tidyGroups(b);
  renderTabs();
  scheduleMeta(b);
}

// 把 n 放到分组 g 最后一页的后面(g 是 null 时放到原来那组的最后一页后面,也就出了那组)
function placeAfterGroup(b, n, g) {
  const active = b.notes[b.active];
  const from = groupOf(b, n);
  b.notes.splice(b.notes.indexOf(n), 1);
  const ref = g || from;
  let at = -1;
  if (ref) b.notes.forEach((x, i) => x.group === ref.id && (at = i));
  b.notes.splice(at >= 0 ? at + 1 : b.notes.length, 0, n);
  n.group = g ? g.id : "";
  b.active = Math.max(0, b.notes.indexOf(active));
}

function nextColor(b) {
  const used = new Set(b.groups.map((g) => g.color));
  return (GROUP_COLORS.find(([, c]) => !used.has(c)) || GROUP_COLORS[b.groups.length % GROUP_COLORS.length])[1];
}

export function newGroup(n) {
  const b = book();
  if (!b.notes.includes(n)) return;
  const g = { id: "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: "", color: nextColor(b), collapsed: false };
  b.groups.push(g);
  // 原来在别的组里就先出来,放到那组后面
  if (n.group) placeAfterGroup(b, n, null);
  n.group = g.id;
  changed(b);
  openGroupEditor(g, { focusName: true });
}

export function moveToGroup(n, g) {
  const b = book();
  if (!b.notes.includes(n) || n.group === g.id) return;
  placeAfterGroup(b, n, g);
  changed(b);
}

export function leaveGroup(n) {
  const b = book();
  if (!groupOf(b, n)) return;
  placeAfterGroup(b, n, null);
  changed(b);
}

export function ungroup(g) {
  const b = book();
  for (const n of b.notes) if (n.group === g.id) n.group = "";
  changed(b);
}

export function toggleGroup(g, collapsed = !g.collapsed) {
  if (g.collapsed === collapsed) return;
  g.collapsed = collapsed;
  renderTabs();
  scheduleMeta(book());
}

// 换到折叠起来的分组里的页面时,把分组展开
export function revealNote(b, n) {
  const g = groupsOn() && groupOf(b, n);
  if (g && g.collapsed) {
    g.collapsed = false;
    scheduleMeta(b);
  }
}

// 拖动的标签放到 target 旁边以后,跟 target 进同一个分组(target 不在分组里就出组)
export function joinNeighbour(b, n, target) {
  if (!groupsOn()) return;
  n.group = groupOf(b, target) ? target.group : "";
  tidyGroups(b);
}

// 右键标签时菜单里分组的几项
export function groupMenuItems(n) {
  if (!groupsOn()) return [];
  const b = book();
  const mine = groupOf(b, n);
  const items = [{ id: "group-new", label: "添加到新分组", act: () => newGroup(n) }];
  for (const g of b.groups) {
    if (g !== mine) items.push({ id: `group-move-${g.id}`, label: `移到分组「${groupLabel(g)}」`, act: () => moveToGroup(n, g) });
  }
  if (mine) items.push({ id: "group-leave", label: "移出分组", act: () => leaveGroup(n) });
  return items;
}

// 标签栏里分组的名字:点了折叠 / 展开,右键打开分组设置,标签拖到上面就进了这个分组
export function groupChip(b, g, count) {
  const c = document.createElement("button");
  c.type = "button";
  c.className = "tab-group" + (g.collapsed ? " collapsed" : "") + (g.name ? "" : " unnamed");
  c.dataset.group = g.id;
  groupVars(c, g.color);
  c.setAttribute("aria-expanded", String(!g.collapsed));
  c.title = `${groupLabel(g)}(${count} 页)· 点一下${g.collapsed ? "展开" : "折叠"},右键改名字和颜色`;
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = g.name;
  c.appendChild(name);
  if (g.collapsed) {
    const k = document.createElement("span");
    k.className = "count";
    k.textContent = String(count);
    c.appendChild(k);
  }
  c.addEventListener("click", () => toggleGroup(g));
  c.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openGroupEditor(g);
  });
  c.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("text/x-tab")) return;
    e.preventDefault();
    c.classList.add("drop-into");
  });
  c.addEventListener("dragleave", () => c.classList.remove("drop-into"));
  c.addEventListener("drop", (e) => {
    e.preventDefault();
    c.classList.remove("drop-into");
    const i = Number(e.dataTransfer.getData("text/x-tab"));
    const n = b.notes[i];
    if (n) moveToGroup(n, g);
  });
  return c;
}

// ---- 分组设置(右键分组的名字) ----
let editing = null;

export function openGroupEditor(g, { focusName = false } = {}) {
  const box = $("#group-edit");
  editing = g;
  $("#ge-name").value = g.name;
  $("#ge-collapse").textContent = g.collapsed ? "展开分组" : "折叠分组";
  paintColors();
  box.hidden = false;
  const chip = document.querySelector(`.tab-group[data-group="${g.id}"]`);
  const r = (chip || $("#tabs")).getBoundingClientRect();
  box.style.left = Math.max(4, Math.min(r.left, window.innerWidth - box.offsetWidth - 4)) + "px";
  const below = r.bottom + 4;
  box.style.top = (below + box.offsetHeight > window.innerHeight - 4 ? Math.max(4, r.top - box.offsetHeight - 4) : below) + "px";
  if (focusName) {
    $("#ge-name").focus();
    $("#ge-name").select();
  } else {
    box.querySelector(".uc-swatch.on, .uc-swatch")?.focus();
  }
}

export function closeGroupEditor() {
  const was = !$("#group-edit").hidden;
  $("#group-edit").hidden = true;
  editing = null;
  return was;
}

function paintColors() {
  const g = editing;
  const shared = makeSharedColorTools({
    getValue: () => editing?.color || "#d9822b",
    onApply: (value) => setColor(value),
  });
  $("#ge-colors").replaceChildren(shared.root);
}

function setColor(c, repaint = true) {
  if (!editing) return;
  editing.color = tidyAccent(c) || c;
  renderTabs();
  scheduleMeta(book());
  if (repaint) paintColors();
}

export function bindGroups() {
  const panel = $("#group-edit");
  new ResizeObserver(() => {
    if (panel.hidden) return;
    const top = Number.parseFloat(panel.style.top) || 4;
    panel.style.top = Math.max(4, Math.min(top, window.innerHeight - panel.offsetHeight - 4)) + "px";
  }).observe(panel);
  $("#ge-name").addEventListener("input", () => {
    if (!editing) return;
    editing.name = $("#ge-name").value.trim();
    renderTabs();
    scheduleMeta(book());
  });
  $("#ge-name").addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      closeGroupEditor();
    }
  });
  $("#ge-collapse").addEventListener("click", () => {
    const g = editing;
    closeGroupEditor();
    if (g) toggleGroup(g);
  });
  $("#ge-ungroup").addEventListener("click", () => {
    const g = editing;
    closeGroupEditor();
    if (g) ungroup(g);
  });
  $("#ge-new").addEventListener("click", () => {
    const g = editing;
    closeGroupEditor();
    if (g) newNote(g);
  });
  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest("#group-edit")) closeGroupEditor();
  });
}
