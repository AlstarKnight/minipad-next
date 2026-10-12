// ---------- 设置 ----------
import { api } from "./api.js";
import { $ } from "./dom.js";
import { state } from "./state.js";
import { toast, closeOverlays } from "./ui.js";
import { flushAll, saveMeta } from "./save.js";
import { reload } from "./sync.js";
import { applyEditorSettings } from "./editor.js";
import { DEFAULT_DATE_FORMAT, formatDate } from "./datetime.js";

const REPO_URL = "https://github.com/AlstarKnight/minipad-next";

export function applySettings() {
  const s = state.settings;
  const theme =
    s.theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : s.theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.setProperty("--font-size", (s.font_size || 14) + "px");
  $("#btn-pin").classList.toggle("on", s.always_on_top);
  $("#btn-pin").title = s.always_on_top ? "取消置顶" : "窗口置顶";
  applyEditorSettings(s);
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
  $("#set-taskbar").checked = s.show_in_taskbar;
  $("#set-autostart").checked = s.autostart;
  $("#set-theme").value = s.theme;
  $("#set-font").value = s.font_size;
  $("#set-dir").value = s.notes_dir;
  $("#set-dir").placeholder = state.notesDir;
  $("#set-date-format").value = s.date_format;
  updateDatePreview();
  $("#set-code-lines").checked = s.code_line_numbers;
  $("#set-format-bar").checked = s.format_bar !== false;
  $("#set-backup").checked = s.backup_enabled;
  $("#set-backup-keep").value = s.backup_keep;
  $("#set-backup-dir").value = s.backup_dir;
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

export async function saveSettings(next) {
  const dirChanged = next.notes_dir.trim() !== (state.settings.notes_dir || "").trim();
  if (dirChanged) {
    await flushAll();
    await saveMeta();
  }
  state.settings = await api.invoke("save_settings", { settings: next });
  applySettings();
  if (dirChanged) await reload();
}

async function submitSettings() {
  const next = {
    ...state.settings,
    hotkey: $("#set-hotkey").value || state.settings.hotkey,
    always_on_top: $("#set-top").checked,
    edge_hide: $("#set-edge").checked,
    show_in_taskbar: $("#set-taskbar").checked,
    autostart: $("#set-autostart").checked,
    theme: $("#set-theme").value,
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
    await saveSettings(next);
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
    if (dir) $(input).value = dir;
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
  $("#set-cancel").addEventListener("click", () => closeOverlays());
  $("#set-pick-dir").addEventListener("click", () => pickFolder("#set-dir", "选择笔记文件夹"));
  $("#set-open-dir").addEventListener("click", () => api.invoke("open_notes_dir").catch((e) => toast(String(e))));
  $("#set-date-format").placeholder = DEFAULT_DATE_FORMAT;
  $("#set-date-format").addEventListener("input", updateDatePreview);
  $("#set-backup").addEventListener("change", updateBackup);
  $("#set-pick-backup").addEventListener("click", () => pickFolder("#set-backup-dir", "选择备份位置"));
  $("#set-open-backup").addEventListener("click", () => api.invoke("open_backup_dir").catch((e) => toast(String(e))));
  $("#set-repo").addEventListener("click", () => api.invoke("open_link", { url: REPO_URL }).catch((e) => toast(String(e))));
}
