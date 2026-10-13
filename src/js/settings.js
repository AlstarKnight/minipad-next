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
}
// 贴边隐藏的样式:露出的宽度和 Rust 里 edge::strip_for 一致(逻辑像素,Rust 按屏幕缩放换成物理像素)
const EDGE_STYLES = ["arrow", "line", "hover"];
const EDGE_STRIP = { arrow: 18, line: 3, hover: 3 };
const EDGE_PEEK_STRIP = 32;
export function applyEdgeAppearance() {
  const s = state.settings || {};
  const root = document.documentElement;
  const style = EDGE_STYLES.includes(s.edge_style) ? s.edge_style : "arrow";
  root.dataset.edgeStyle = style;
  const peeking = style === "hover" && root.dataset.edgePeek === "on";
  const strip = peeking ? EDGE_PEEK_STRIP : EDGE_STRIP[style];
  root.style.setProperty("--edge-peek", strip + "px");
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
const PAGES = ["general", "look", "edge", "ball", "editor", "find", "storage", "backup", "import"];
const PAGE_KEY = "minipad-next-settings-page";
let page = (() => {
  try {
    const saved = localStorage.getItem(PAGE_KEY);
    return PAGES.includes(saved) ? saved : "general";
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
  if (/备份/.test(msg)) return "backup";
  if (/文件夹|笔记/.test(msg)) return "storage";
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
  $("#set-ctrl-f").value = s.ctrl_f === "all" ? "all" : "page";
  $("#set-find-pos").value = s.find_bar_pos === "bottom" ? "bottom" : "top";
  findColor.show(s.find_color || "");
  $("#set-conflict").value = s.conflict_mode === "overwrite" ? "overwrite" : "copy";
  $("#set-backup").checked = s.backup_enabled;
  $("#set-backup-keep").value = s.backup_keep;
  $("#set-backup-dir").value = s.backup_dir;
  updateEdgeOptions();
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

// 贴边样式和颜色只在开着贴边隐藏时能改
function updateEdgeOptions() {
  const off = !$("#set-edge").checked;
  for (const el of document.querySelectorAll(".edge-option")) el.classList.toggle("off", off);
  for (const el of document.querySelectorAll(".edge-option select, .edge-option input, .edge-option button")) el.disabled = off;
  if (!off) $("#set-edge-to").disabled = !$("#set-edge-grad").checked;
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
    ctrl_f: $("#set-ctrl-f").value,
    find_bar_pos: $("#set-find-pos").value,
    find_color: findColor.value,
    conflict_mode: $("#set-conflict").value,
    settings_nav: $("#set-nav-pos").value,
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
  $("#set-dir").addEventListener("input", updateMigration);
  $("#set-cancel").addEventListener("click", () => closeOverlays());
  for (const id of ["#set-accent-from", "#set-accent-to", "#set-accent-grad"]) $(id).addEventListener("input", accentColor.custom);
  for (const id of ["#set-edge-from", "#set-edge-to", "#set-edge-grad"]) $(id).addEventListener("input", edgeColor.custom);
  for (const id of ["#set-ball-from", "#set-ball-to", "#set-ball-grad"]) $(id).addEventListener("input", ballColor.custom);
  for (const id of ["#set-find-from", "#set-find-to", "#set-find-grad"]) $(id).addEventListener("input", findColor.custom);
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
