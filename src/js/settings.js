// ---------- 设置 ----------
import { api } from "./api.js";
import { $ } from "./dom.js";
import { state } from "./state.js";
import { toast, closeOverlays } from "./ui.js";
import { flushAll, saveMeta } from "./save.js";
import { reload } from "./sync.js";
import { applyEditorSettings } from "./editor.js";
import { DEFAULT_DATE_FORMAT, formatDate } from "./datetime.js";
// 活跃标签的高亮:顶部线条 / 整个标签 / 整圈边框(见 style.css)
const TAB_STYLES = ["line", "fill", "border"];
import { ACCENTS, applyAccent, parseAccent, tidyAccent, gradient, gradientOf } from "./accent.js";
import { APP_ICON, paintBall } from "./ballicon.js";
import { applyFindAppearance, findColors } from "./findbar.js";
import { openImport } from "./importer.js";
import { applyOutlineSettings, outlineVars } from "./outline.js";
import { applyTabBarSettings } from "./tabbar.js";
import { ALL_ITEMS, DEFAULT_SEL_ITEMS, itemChecklist, orderedItems } from "./formatbar.js";
import { renderTabs } from "./tabs.js";

const REPO_URL = "https://github.com/AlstarKnight/minipad-next";

export function applySettings() {
  const s = state.settings;
  const theme =
    s.theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : s.theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.setProperty("--font-size", (s.font_size || 14) + "px");
  $("#btn-pin").classList.toggle("on", s.always_on_top);
  $("#btn-pin").title = s.always_on_top ? "取消置顶" : "窗口置顶";
  $("#btn-theme").title = theme === "dark" ? "切换到浅色" : "切换到深色";
  applyAccent(s.accent);
  document.documentElement.dataset.tabStyle = TAB_STYLES.includes(s.tab_style) ? s.tab_style : "line";
  applyEdgeAppearance();
  $("#btn-ball").hidden = !s.ball_enabled;
  applyFindAppearance(s);
  $("#btn-search").title = s.ctrl_f === "all" ? "搜索全部页面 (Ctrl+F)" : "搜索全部页面 (Ctrl+Shift+F)";
  applyEditorSettings(s);
  applyOutlineSettings(s);
  applyTabBarSettings(s);
  // 分组开关、分组样式变了要重画标签
  renderTabs();
}
// 贴边隐藏的样式:露出的宽度和 Rust 里 edge::strip_for 一致(逻辑像素,Rust 按屏幕缩放换成物理像素)
const EDGE_STYLES = ["arrow", "line", "hover", "arrow-only"];
const EDGE_PEEK_STRIP = 32;
const EDGE_ARROW_STRIP = 18;
const edgeWidth = (s) => Math.min(12, Math.max(1, Number(s.edge_line_width) || 2));
const edgeLength = (s) => Math.min(100, Math.max(10, Number(s.edge_line_length) || 100));
export function applyEdgeAppearance() {
  const s = state.settings || {};
  const root = document.documentElement;
  const style = EDGE_STYLES.includes(s.edge_style) ? s.edge_style : "arrow";
  root.dataset.edgeStyle = style;
  const peeking = style === "hover" && root.dataset.edgePeek === "on";
  const lineStrip = s.edge_line_glow ? Math.max(10, edgeWidth(s)) : edgeWidth(s);
  const strip = peeking ? EDGE_PEEK_STRIP : style === "arrow" || style === "arrow-only" ? EDGE_ARROW_STRIP : lineStrip;
  root.style.setProperty("--edge-peek", strip + "px");
  root.style.setProperty("--edge-line-width", edgeWidth(s) + "px");
  root.style.setProperty("--edge-line-length", edgeLength(s) + "%");
  root.dataset.edgeGlow = s.edge_line_glow ? "on" : "off";
  // 空着跟随强调色(CSS 里退回 --accent / --accent-grad)
  const c = parseAccent(s.edge_color);
  if (c) {
    root.style.setProperty("--edge-c", c.from);
    root.style.setProperty("--edge-grad", c.to ? gradientOf(c.stops, c.deg) : c.from);
  } else {
    root.style.removeProperty("--edge-c");
    root.style.removeProperty("--edge-grad");
  }
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => state.settings && applySettings());

// 后端给的备份情况 { dir, latest, count },还没读到时是 null
let backupInfo = null;

// ---- 分类:点左边(或上面)的分类只显示那一类,下次打开设置还停在上次看的那一类 ----
const PAGES = ["general", "look", "window", "edit", "data"];
// 0.3.1 分成 10 类,记着的旧分类换成合并后的那一类
const OLD_PAGES = { edge: "window", ball: "window", editor: "edit", outline: "edit", find: "edit", storage: "data", backup: "data", import: "data" };
const PAGE_KEY = "minipad-next-settings-page";
let page = (() => {
  try {
    const saved = localStorage.getItem(PAGE_KEY);
    return PAGES.includes(saved) ? saved : OLD_PAGES[saved] || "general";
  } catch {
    return "general";
  }
})();

export function showSettingsPage(name, { focus = false } = {}) {
  if (!PAGES.includes(name)) return;
  page = name;
  try {
    localStorage.setItem(PAGE_KEY, name);
  } catch {}
  for (const tab of document.querySelectorAll("#set-nav [role=tab]")) {
    const on = tab.dataset.page === name;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    if (on && focus) tab.focus();
    if (on) tab.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  for (const el of document.querySelectorAll(".set-page")) el.hidden = el.dataset.page !== name;
  $(".set-pages").scrollTop = 0;
}

// 保存时出的错放在下面,同时换到出错的那一类,好看到要改的地方
function pageForError(msg) {
  if (/热键|开机启动/.test(msg)) return "general";
  if (/备份|文件夹|笔记/.test(msg)) return "data";
  return page;
}

// 分类放在左边还是上面:选了马上换,取消就回到原来的
function applyNavPos(value) {
  $("#settings").dataset.nav = value === "top" ? "top" : "left";
}

export function openSettings() {
  closeOverlays();
  const s = state.settings;
  $("#set-hotkey").value = s.hotkey;
  $("#set-top").checked = s.always_on_top;
  $("#set-edge").checked = s.edge_hide;
  $("#set-edge-style").value = EDGE_STYLES.includes(s.edge_style) ? s.edge_style : "arrow";
  $("#set-edge-line-width").value = edgeWidth(s);
  $("#set-edge-line-length").value = edgeLength(s);
  $("#set-edge-glow").checked = !!s.edge_line_glow;
  edgeColor.show(s.edge_color || "");
  $("#set-taskbar").checked = s.show_in_taskbar;
  $("#set-autostart").checked = s.autostart;
  $("#set-theme").value = s.theme;
  accentColor.show(s.accent || "");
  $("#set-ball").checked = !!s.ball_enabled;
  $("#set-ball-size").value = s.ball_size || 48;
  $("#set-ball-opacity").value = s.ball_opacity || 100;
  $("#set-ball-open").value = s.ball_open === "dblclick" ? "dblclick" : "click";
  for (const r of document.querySelectorAll('input[name="set-ball-icon"]')) r.checked = r.value === (s.ball_icon || "app");
  ballColor.show(s.ball_color || "");
  api
    .invoke("ball_info")
    .then((b) => {
      ballImage = b.image || null;
      document.querySelector('input[name="set-ball-icon"][value="custom"]').checked = s.ball_icon === "custom" && !!ballImage;
      document.querySelector('input[name="set-ball-icon"][value="app"]').checked = !(s.ball_icon === "custom" && ballImage);
      updateBall();
    })
    .catch(() => updateBall());
  $("#set-tab-style").value = TAB_STYLES.includes(s.tab_style) ? s.tab_style : "line";
  $("#set-font").value = s.font_size;
  $("#set-dir").value = s.notes_dir;
  $("#set-migrate-notes").checked = true;
  updateMigration();
  $("#set-dir").placeholder = state.notesDir;
  $("#set-date-format").value = s.date_format;
  updateDatePreview();
  $("#set-code-lines").checked = s.code_line_numbers;
  $("#set-format-bar").checked = s.format_bar !== false;
  $("#set-outline").checked = !!s.outline_enabled;
  $("#set-outline-mode").value = s.outline_mode === "pinned" ? "pinned" : "hover";
  $("#set-outline-side").value = s.outline_side === "left" ? "left" : "right";
  $("#set-outline-depth").value = String(Math.min(6, Math.max(1, Number(s.outline_depth) || 3)));
  $("#set-outline-width").value = s.outline_width || 200;
  $("#set-outline-opacity").value = s.outline_opacity || 100;
  outlineColor.show(s.outline_color || "");
  $("#set-ctrl-f").value = s.ctrl_f === "all" ? "all" : "page";
  $("#set-find-pos").value = s.find_bar_pos === "bottom" ? "bottom" : "top";
  findColor.show(s.find_color || "");
  $("#set-conflict").value = s.conflict_mode === "overwrite" ? "overwrite" : "copy";
  $("#set-backup").checked = s.backup_enabled;
  $("#set-backup-keep").value = s.backup_keep;
  $("#set-backup-dir").value = s.backup_dir;
  $("#set-tab-overflow").value = ["scroll", "wrap", "drawer"].includes(s.tab_overflow) ? s.tab_overflow : "scroll";
  $("#set-tab-fade").checked = s.tab_fade !== false;
  $("#set-tab-list").checked = s.tab_list_button !== false;
  const rows = Math.min(8, Math.max(2, Number(s.tab_rows) || 4));
  $("#set-tab-rows").value = String(rows === 7 ? 8 : rows);
  $("#set-drawer-side").value = s.tab_drawer_side === "right" ? "right" : "left";
  $("#set-drawer-width").value = s.tab_drawer_width || 200;
  $("#set-drawer-hover").checked = !!s.tab_drawer_hover;
  $("#set-drawer-pinned").checked = !!s.tab_drawer_pinned;
  $("#set-tab-groups").checked = !!s.tab_groups;
  $("#set-group-style").value = s.tab_group_style === "tint" ? "tint" : "line";
  updateEdgeOptions();
  updateOutline();
  updateTabOptions();
  $("#set-sel-bar").value = ["always", "nobar", "off"].includes(s.sel_bar) ? s.sel_bar : "always";
  $("#set-sel-pos").value = s.sel_bar_pos === "below" ? "below" : "above";
  showSelItems(Array.isArray(s.sel_bar_items) ? s.sel_bar_items : DEFAULT_SEL_ITEMS);
  $("#set-nav-pos").value = s.settings_nav === "top" ? "top" : "left";
  applyNavPos(s.settings_nav);
  $("#set-error").hidden = true;
  $("#set-version").textContent = state.version ? `Minipad Next ${state.version}` : "Minipad Next";
  backupInfo = null;
  updateBackup();
  $("#settings").hidden = false;
  showSettingsPage(page, { focus: true });
  api
    .invoke("backup_info")
    .then((info) => {
      backupInfo = info;
      $("#set-backup-dir").placeholder = info.dir;
      updateBackup();
    })
    .catch(() => {});
}

// ---- 颜色选择:一排色块(纯色和渐变),下面是自定义的两个取色框 ----
// 强调色和贴边标识的颜色共用。空字符串是第一个色块(默认橙色 / 跟随强调色)
function colorPicker(prefix, box, options, firstSwatch, onChange) {
  const picker = { value: "" };
  picker.show = (value) => {
    picker.value = tidyAccent(value);
    const el = $(box);
    if (!el.childElementCount) {
      for (const a of options) {
        const b = document.createElement("button");
        b.type = "button";
        b.title = a.name;
        b.dataset.color = a.value;
        b.style.setProperty("--sw", a.value || firstSwatch);
        b.addEventListener("click", () => picker.show(a.value));
        el.appendChild(b);
      }
    }
    for (const b of el.children) b.classList.toggle("on", b.dataset.color === picker.value);
    const a = parseAccent(picker.value) || { from: "#d9822b", to: "" };
    $(`#set-${prefix}-from`).value = a.from;
    $(`#set-${prefix}-grad`).checked = !!a.to;
    if (a.to) $(`#set-${prefix}-to`).value = a.to;
    $(`#set-${prefix}-to`).disabled = !a.to;
    onChange?.();
  };
  picker.custom = () => {
    const from = $(`#set-${prefix}-from`).value;
    picker.show($(`#set-${prefix}-grad`).checked ? gradient(from, $(`#set-${prefix}-to`).value) : from);
  };
  return picker;
}
const accentColor = colorPicker("accent", "#set-accent", ACCENTS, "#d9822b", () => updateFindPreview());
const edgeColor = colorPicker(
  "edge",
  "#set-edge-color",
  [{ name: "跟随强调色", value: "" }, ...ACCENTS.filter((a) => a.value)],
  "var(--accent-grad)",
  () => updateEdgeLinePreview(),
);

// 查找高亮的颜色,上面那句话是预览
const findColor = colorPicker(
  "find",
  "#set-find-color",
  [{ name: "跟随强调色", value: "" }, ...ACCENTS.filter((a) => a.value)],
  "var(--accent-grad)",
  () => updateFindPreview(),
);
// 跟随强调色时,预览用这里正在选的强调色
function updateFindPreview() {
  findColors($("#set-find-preview"), findColor.value || accentColor.value);
}

// 目录里当前标题的颜色,上面是预览
const outlineColor = colorPicker(
  "outline",
  "#set-outline-color",
  [{ name: "跟随强调色", value: "" }, ...ACCENTS.filter((a) => a.value)],
  "var(--accent-grad)",
  () => updateOutline(),
);
// 目录的选项只在打开目录时能改;预览跟着宽度、不透明度、颜色实时变
function updateOutline() {
  const off = !$("#set-outline").checked;
  for (const el of document.querySelectorAll(".outline-option")) el.classList.toggle("off", off);
  for (const el of document.querySelectorAll(".outline-option input, .outline-option select, .outline-option button")) el.disabled = off;
  if (!off) $("#set-outline-to").disabled = !$("#set-outline-grad").checked;
  const width = Number($("#set-outline-width").value) || 200;
  const opacity = Number($("#set-outline-opacity").value) || 100;
  $("#set-outline-width-val").textContent = width + " 像素";
  $("#set-outline-opacity-val").textContent = opacity + "%";
  outlineVars($("#set-outline-preview"), { width, opacity, color: outlineColor.value });
}

// 标签栏:只显示选中的那种方式的选项,预览跟着变;分组的样式只在打开分组时能改
function updateTabOptions() {
  const mode = $("#set-tab-overflow").value;
  for (const el of document.querySelectorAll(".tab-option")) el.hidden = el.dataset.for !== mode;
  const p = $("#set-tabs-preview");
  p.dataset.mode = mode;
  p.dataset.side = $("#set-drawer-side").value;
  p.classList.toggle("no-fade", !$("#set-tab-fade").checked);
  p.classList.toggle("no-list", !$("#set-tab-list").checked);
  $("#set-drawer-width-val").textContent = (Number($("#set-drawer-width").value) || 200) + " 像素";
  const off = !$("#set-tab-groups").checked;
  for (const el of document.querySelectorAll(".group-option")) el.classList.toggle("off", off);
  $("#set-group-style").disabled = off;
}

// 悬浮工具栏的按钮:勾选的按顺序排在前面,没勾的按默认顺序跟在后面
let selItems = DEFAULT_SEL_ITEMS;
function showSelItems(items) {
  selItems = items.slice();
  const known = new Set(ALL_ITEMS.map((it) => it.id));
  const order = [...selItems.filter((id) => known.has(id)), ...orderedItems([]).map((it) => it.id).filter((id) => !selItems.includes(id))];
  const hidden = order.filter((id) => !selItems.includes(id));
  $("#set-sel-items").replaceChildren(
    itemChecklist(order, hidden, (ids, off) => {
      selItems = ids.filter((id) => !off.includes(id));
      updateSelOptions();
    }),
  );
  updateSelOptions();
}
// 不弹出时其他选项变灰;上面是按钮的预览
function updateSelOptions() {
  const off = $("#set-sel-bar").value === "off";
  for (const el of document.querySelectorAll(".sel-option")) el.classList.toggle("off", off);
  for (const el of document.querySelectorAll(".sel-option input, .sel-option select, .sel-option button")) el.disabled = off;
  const byId = new Map(ALL_ITEMS.map((it) => [it.id, it]));
  const parts = [];
  for (const id of selItems) {
    const it = byId.get(id);
    if (!it || (it.sep && (!parts.length || parts.at(-1).sep))) continue;
    parts.push(it);
  }
  while (parts.at(-1)?.sep) parts.pop();
  $("#set-sel-preview").innerHTML = parts.length
    ? parts.map((it) => (it.sep ? '<span class="sep"></span>' : `<span class="b">${it.block ? "正文" : it.label}</span>`)).join("")
    : '<span class="muted">没有按钮</span>';
}

const ballColor = colorPicker(
  "ball",
  "#set-ball-color",
  [{ name: "原色", value: "" }, ...ACCENTS.filter((a) => a.value)],
  `url(${APP_ICON}) center / cover`,
  () => updateBall(),
);

// ---- 悬浮图标:开关、大小、图标、颜色,左边实时预览 ----
let ballImage = null; // 自定义图片(data: 网址)
function ballIcon() {
  return document.querySelector('input[name="set-ball-icon"]:checked')?.value || "app";
}
function updateBall() {
  const off = !$("#set-ball").checked;
  for (const el of document.querySelectorAll(".ball-option")) el.classList.toggle("off", off);
  for (const el of document.querySelectorAll(".ball-option input, .ball-option button, .ball-option select")) el.disabled = off;
  if (!off) $("#set-ball-to").disabled = !$("#set-ball-grad").checked;
  // 还没选过图片时不能选"自定义图片"
  const custom = document.querySelector('input[name="set-ball-icon"][value="custom"]');
  if (!ballImage) {
    custom.disabled = true;
    if (custom.checked) document.querySelector('input[name="set-ball-icon"][value="app"]').checked = true;
  }
  const size = Number($("#set-ball-size").value) || 48;
  const opacity = Number($("#set-ball-opacity").value) || 100;
  $("#set-ball-size-val").textContent = size + " 像素";
  $("#set-ball-opacity-val").textContent = opacity + "%";
  paintBall($("#set-ball-preview"), { size, opacity, icon: ballIcon(), color: ballColor.value, image: ballImage });
}
async function pickBallIcon() {
  try {
    const img = await api.invoke("pick_ball_icon");
    if (!img) return;
    ballImage = img;
    document.querySelector('input[name="set-ball-icon"][value="custom"]').disabled = false;
    document.querySelector('input[name="set-ball-icon"][value="custom"]').checked = true;
    updateBall();
  } catch (e) {
    toast(String(e), 5000);
  }
}

// 箭头独立模式不显示细线控制；其余三种模式都能调细线长度、粗细。
function updateEdgeOptions() {
  const off = !$("#set-edge").checked;
  const onlyArrow = $("#set-edge-style").value === "arrow-only";
  for (const el of document.querySelectorAll(".edge-option")) el.classList.toggle("off", off);
  for (const el of document.querySelectorAll(".edge-option select, .edge-option input, .edge-option button")) el.disabled = off;
  for (const el of document.querySelectorAll(".edge-line-option")) {
    el.hidden = onlyArrow;
    for (const input of el.querySelectorAll("input")) input.disabled = off || onlyArrow;
  }
  if (!off) $("#set-edge-to").disabled = !$("#set-edge-grad").checked;
  updateEdgeLinePreview();
}

function updateEdgeLinePreview() {
  const width = Math.min(12, Math.max(1, Number($("#set-edge-line-width").value) || 2));
  const length = Math.min(100, Math.max(10, Number($("#set-edge-line-length").value) || 100));
  $("#set-edge-line-width-val").textContent = width + " 像素";
  $("#set-edge-line-length-val").textContent = length + "%";
  const preview = $("#set-edge-line-preview");
  preview.style.setProperty("--edge-line-width", width + "px");
  preview.style.setProperty("--edge-line-length", length + "%");
  preview.classList.toggle("glow", $("#set-edge-glow").checked);
  const picked = edgeColor.value || accentColor.value;
  const col = parseAccent(picked);
  preview.style.setProperty("--preview-edge-color", col ? (col.to ? gradientOf(col.stops, col.deg) : col.from) : "var(--accent-grad)");
}

// 现在按 F5 会插入什么,跟着输入框实时变;空着就是默认格式
function updateDatePreview() {
  $("#set-date-preview").textContent = "现在按 F5 会插入:" + formatDate(new Date(), $("#set-date-format").value.trim());
}

// 备份的几个输入框跟着勾选框启用 / 停用,说明文字也跟着变
function updateBackup() {
  const on = $("#set-backup").checked;
  for (const id of ["#set-backup-keep", "#set-backup-dir", "#set-pick-backup"]) $(id).disabled = !on;
  const info = backupInfo;
  let text = "";
  if (!on) text = "自动备份已关闭";
  else if (info?.latest) text = `最近一次:${info.latest},共 ${info.count} 份`;
  else if (info) text = "还没有备份,今天第一次保存时会自动备份";
  $("#set-backup-info").textContent = text;
}

// UI 操作可能在上一笔设置仍在保存时继续发生。按触发时的状态计算差异，
// 串行合并到最新已保存的设置，避免旧快照将刚刚改变的选项覆盖。
let settingsQueue = Promise.resolve();
export function saveSettings(next, { migrateNotes = false } = {}) {
  const baseline = state.settings;
  const changed = Object.fromEntries(Object.entries(next).filter(([key, value]) =>
    JSON.stringify(value) !== JSON.stringify(baseline[key])
  ));
  const save = async () => {
    if (!Object.keys(changed).length) return state.settings;
    const merged = { ...state.settings, ...changed };
    const dirChanged = merged.notes_dir.trim() !== (state.settings.notes_dir || "").trim();
    if (dirChanged) {
      await flushAll();
      await saveMeta();
    }
    state.settings = await api.invoke("save_settings", { settings: merged, migrateNotes: dirChanged && migrateNotes });
    applySettings();
    if (dirChanged) await reload();
    return state.settings;
  };
  const task = settingsQueue.then(save);
  settingsQueue = task.catch(() => {});
  return task;
}

async function submitSettings() {
  const next = {
    ...state.settings,
    hotkey: $("#set-hotkey").value || state.settings.hotkey,
    always_on_top: $("#set-top").checked,
    edge_hide: $("#set-edge").checked,
    edge_style: $("#set-edge-style").value,
    edge_line_width: Number($("#set-edge-line-width").value) || 2,
    edge_line_length: Number($("#set-edge-line-length").value) || 100,
    edge_line_glow: $("#set-edge-glow").checked,
    edge_color: edgeColor.value,
    ball_enabled: $("#set-ball").checked,
    ball_size: Number($("#set-ball-size").value) || 48,
    ball_icon: ballIcon(),
    ball_color: ballColor.value,
    ball_opacity: Number($("#set-ball-opacity").value) || 100,
    ball_open: $("#set-ball-open").value,
    show_in_taskbar: $("#set-taskbar").checked,
    autostart: $("#set-autostart").checked,
    theme: $("#set-theme").value,
    accent: accentColor.value,
    tab_style: $("#set-tab-style").value,
    font_size: Math.min(28, Math.max(10, Number($("#set-font").value) || 14)),
    notes_dir: $("#set-dir").value.trim(),
    date_format: $("#set-date-format").value.trim(),
    code_line_numbers: $("#set-code-lines").checked,
    format_bar: $("#set-format-bar").checked,
    outline_enabled: $("#set-outline").checked,
    outline_mode: $("#set-outline-mode").value,
    outline_side: $("#set-outline-side").value,
    outline_depth: Number($("#set-outline-depth").value) || 3,
    outline_width: Number($("#set-outline-width").value) || 200,
    outline_opacity: Number($("#set-outline-opacity").value) || 100,
    outline_color: outlineColor.value,
    ctrl_f: $("#set-ctrl-f").value,
    find_bar_pos: $("#set-find-pos").value,
    find_color: findColor.value,
    conflict_mode: $("#set-conflict").value,
    settings_nav: $("#set-nav-pos").value,
    tab_overflow: $("#set-tab-overflow").value,
    tab_fade: $("#set-tab-fade").checked,
    tab_list_button: $("#set-tab-list").checked,
    tab_rows: Number($("#set-tab-rows").value) || 4,
    tab_drawer_side: $("#set-drawer-side").value,
    tab_drawer_width: Number($("#set-drawer-width").value) || 200,
    tab_drawer_hover: $("#set-drawer-hover").checked,
    tab_drawer_pinned: $("#set-drawer-pinned").checked,
    tab_groups: $("#set-tab-groups").checked,
    tab_group_style: $("#set-group-style").value,
    sel_bar: $("#set-sel-bar").value,
    sel_bar_pos: $("#set-sel-pos").value,
    sel_bar_items: selItems,
    backup_enabled: $("#set-backup").checked,
    backup_keep: Math.min(365, Math.max(1, Math.round(Number($("#set-backup-keep").value)) || 14)),
    backup_dir: $("#set-backup-dir").value.trim(),
  };
  try {
    await saveSettings(next, { migrateNotes: $("#set-migrate-notes").checked });
    closeOverlays();
    toast("设置已保存");
  } catch (e) {
    const err = $("#set-error");
    err.textContent = String(e);
    err.hidden = false;
    showSettingsPage(pageForError(String(e)));
  }
}

async function pickFolder(input, title) {
  try {
    const dir = await api.invoke("pick_folder", { title });
    if (dir) {
      $(input).value = dir;
      if (input === "#set-dir") updateMigration();
    }
  } catch (e) {
    toast(String(e));
  }
}

function hotkeyFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  const c = e.code;
  if (/^(Control|Alt|Shift|Meta|OS)/.test(c)) return null;
  let key;
  if (/^Key[A-Z]$/.test(c)) key = c.slice(3);
  else if (/^Digit\d$/.test(c)) key = c.slice(5);
  else key = c;
  if (!mods.length && !/^F\d{1,2}$/.test(key)) return null;
  return [...mods, key].join("+");
}

function updateMigration() {
  const currentDir = state.settings?.notes_dir || "";
  const changing = $("#set-dir").value.trim() !== currentDir;
  $("#set-migrate-notes").disabled = !changing;
}

export function bindSettings() {
  // 录热键时先停用全局热键,不然按下现在的热键会把窗口藏起来
  const hk = $("#set-hotkey");
  hk.addEventListener("focus", () => {
    hk.classList.add("recording");
    api.invoke("pause_hotkey").catch(() => {});
  });
  hk.addEventListener("blur", () => {
    hk.classList.remove("recording");
    api.invoke("resume_hotkey").catch(() => {});
  });
  hk.addEventListener("keydown", (e) => {
    if (e.key === "Tab") return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return hk.blur();
    const combo = hotkeyFromEvent(e);
    if (combo) hk.value = combo;
  });
  $("#set-save").addEventListener("click", submitSettings);
  // 分类:点一下换过去;焦点在分类上时,上下(分类在上面时左右)方向键换到相邻的一类,Home / End 换到第一类和最后一类
  const nav = $("#set-nav");
  nav.addEventListener("click", (e) => {
    const tab = e.target.closest("[role=tab]");
    if (tab) showSettingsPage(tab.dataset.page);
  });
  nav.addEventListener("keydown", (e) => {
    const i = PAGES.indexOf(page);
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    let next = null;
    if (step) next = PAGES[(i + step + PAGES.length) % PAGES.length];
    else if (e.key === "Home") next = PAGES[0];
    else if (e.key === "End") next = PAGES[PAGES.length - 1];
    if (!next) return;
    e.preventDefault();
    showSettingsPage(next, { focus: true });
  });
  // 分类排成一排放不下时,滚轮也能左右滑动
  nav.addEventListener(
    "wheel",
    (e) => {
      const row = getComputedStyle(nav).flexDirection === "row";
      if (!row || nav.scrollWidth <= nav.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      nav.scrollLeft += e.deltaY;
    },
    { passive: false },
  );
  $("#set-nav-pos").addEventListener("change", () => applyNavPos($("#set-nav-pos").value));
  $("#set-edge").addEventListener("change", updateEdgeOptions);
  $("#set-edge-style").addEventListener("change", updateEdgeOptions);
  for (const id of ["#set-edge-line-width", "#set-edge-line-length", "#set-edge-glow"]) $(id).addEventListener("input", updateEdgeLinePreview);
  $("#set-dir").addEventListener("input", updateMigration);
  $("#set-cancel").addEventListener("click", () => closeOverlays());
  for (const id of ["#set-accent-from", "#set-accent-to", "#set-accent-grad"]) $(id).addEventListener("input", accentColor.custom);
  for (const id of ["#set-edge-from", "#set-edge-to", "#set-edge-grad"]) $(id).addEventListener("input", edgeColor.custom);
  for (const id of ["#set-ball-from", "#set-ball-to", "#set-ball-grad"]) $(id).addEventListener("input", ballColor.custom);
  for (const id of ["#set-find-from", "#set-find-to", "#set-find-grad"]) $(id).addEventListener("input", findColor.custom);
  for (const id of ["#set-outline-from", "#set-outline-to", "#set-outline-grad"]) $(id).addEventListener("input", outlineColor.custom);
  for (const id of ["#set-outline", "#set-outline-width", "#set-outline-opacity"]) $(id).addEventListener("input", updateOutline);
  for (const id of ["#set-tab-overflow", "#set-tab-fade", "#set-tab-list", "#set-drawer-side", "#set-drawer-width", "#set-tab-groups"]) $(id).addEventListener("input", updateTabOptions);
  $("#set-sel-bar").addEventListener("input", updateSelOptions);
  $("#set-sel-reset").addEventListener("click", () => showSelItems(DEFAULT_SEL_ITEMS));
  $("#set-import").addEventListener("click", openImport);
  for (const id of ["#set-ball", "#set-ball-size", "#set-ball-opacity"]) $(id).addEventListener("input", updateBall);
  for (const r of document.querySelectorAll('input[name="set-ball-icon"]')) r.addEventListener("change", updateBall);
  $("#set-ball-pick").addEventListener("click", pickBallIcon);
  $("#set-pick-dir").addEventListener("click", () => pickFolder("#set-dir", "选择笔记文件夹"));
  $("#set-open-dir").addEventListener("click", () => api.invoke("open_notes_dir").catch((e) => toast(String(e))));
  $("#set-date-format").placeholder = DEFAULT_DATE_FORMAT;
  $("#set-date-format").addEventListener("input", updateDatePreview);
  $("#set-backup").addEventListener("change", updateBackup);
  $("#set-pick-backup").addEventListener("click", () => pickFolder("#set-backup-dir", "选择备份位置"));
  $("#set-open-backup").addEventListener("click", () => api.invoke("open_backup_dir").catch((e) => toast(String(e))));
  $("#set-repo").addEventListener("click", () => api.invoke("open_link", { url: REPO_URL }).catch((e) => toast(String(e))));
}
