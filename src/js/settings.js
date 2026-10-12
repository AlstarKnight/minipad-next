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
  $("#set-backup").checked = s.backup_enabled;
  $("#set-backup-keep").value = s.backup_keep;
  $("#set-backup-dir").value = s.backup_dir;
  updateEdgeOptions();
  $("#set-error").hidden = true;
  $("#set-version").textContent = state.version ? `Minipad Next ${state.version}` : "Minipad Next";
  backupInfo = null;
  updateBackup();
  $("#settings").hidden = false;
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
function colorPicker(prefix, box, options, firstSwatch) {
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
  };
  picker.custom = () => {
    const from = $(`#set-${prefix}-from`).value;
    picker.show($(`#set-${prefix}-grad`).checked ? gradient(from, $(`#set-${prefix}-to`).value) : from);
  };
  return picker;
}
const accentColor = colorPicker("accent", "#set-accent", ACCENTS, "#d9822b");
const edgeColor = colorPicker(
  "edge",
  "#set-edge-color",
  [{ name: "跟随强调色", value: "" }, ...ACCENTS.filter((a) => a.value)],
  "var(--accent-grad)",
);

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
  $("#set-edge").addEventListener("change", updateEdgeOptions);
  $("#set-dir").addEventListener("input", updateMigration);
  $("#set-cancel").addEventListener("click", () => closeOverlays());
  for (const id of ["#set-accent-from", "#set-accent-to", "#set-accent-grad"]) $(id).addEventListener("input", accentColor.custom);
  for (const id of ["#set-edge-from", "#set-edge-to", "#set-edge-grad"]) $(id).addEventListener("input", edgeColor.custom);
  $("#set-pick-dir").addEventListener("click", () => pickFolder("#set-dir", "选择笔记文件夹"));
  $("#set-open-dir").addEventListener("click", () => api.invoke("open_notes_dir").catch((e) => toast(String(e))));
  $("#set-date-format").placeholder = DEFAULT_DATE_FORMAT;
  $("#set-date-format").addEventListener("input", updateDatePreview);
  $("#set-backup").addEventListener("change", updateBackup);
  $("#set-pick-backup").addEventListener("click", () => pickFolder("#set-backup-dir", "选择备份位置"));
  $("#set-open-backup").addEventListener("click", () => api.invoke("open_backup_dir").catch((e) => toast(String(e))));
  $("#set-repo").addEventListener("click", () => api.invoke("open_link", { url: REPO_URL }).catch((e) => toast(String(e))));
}
