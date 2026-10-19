// WebDAV 网络同步由 Rust 在后台执行；前端只管触发、状态和磁盘刷新。
import { api, isMiniWindow } from "./api.js";
import { state } from "./state.js";
import { $ } from "./dom.js";
import { ask, toast } from "./ui.js";
import { syncFromDisk } from "./sync.js";
import { flushAll, saveMeta } from "./save.js";
import { parseAccent } from "./accent.js";

let deferred = null;
let periodic = null;
let running = null;
let rerun = false;
let recentConflicts = [];

const enabled = () => state.settings?.webdav_enabled === true;
const states = {
  synced: "✓", syncing: "⟳", conflict: "!", offline: "○",
  error: "!", confirm: "?", off: "○",
};

export async function webdavStatus() {
  const status = await api.invoke("webdav_status");
  const bar = $("#st-webdav");
  if (bar) {
    const style = state.settings?.webdav_status_style || "icon";
    bar.hidden = isMiniWindow || !enabled() || style === "none";
    const symbol = document.createElement("span");
    symbol.className = "webdav-state-icon";
    symbol.classList.toggle("spinning", status.state === "syncing");
    symbol.textContent = states[status.state] || "○";
    bar.replaceChildren(symbol);
    if (style === "text") bar.append(document.createTextNode(" " + (status.message || "WebDAV")));
    bar.style.whiteSpace = "normal";
    bar.style.overflowWrap = "anywhere";
    bar.title = status.message || "WebDAV 同步";
    const choice = state.settings?.webdav_status_color || "";
    const color = parseAccent(choice);
    bar.style.color = color?.from || "var(--accent)";
    bar.style.backgroundImage = color?.to ? choice : "";
    bar.style.backgroundClip = color?.to ? "text" : "";
    bar.style.webkitBackgroundClip = color?.to ? "text" : "";
    bar.style.webkitTextFillColor = color?.to ? "transparent" : "";
  }
  const last = document.getElementById("set-webdav-last");
  if (last) last.textContent = `上次成功同步：${status.last_time || "尚无"}`;
  const info = $("#set-webdav-info");
  if (info) info.textContent = status.message || "WebDAV 尚未同步";
  const history = $("#set-webdav-history");
  if (history) history.textContent = (status.history || []).join("\n");
  return status;
}

async function performWebdavSync(confirmed) {
  try {
    await flushAll();
    await saveMeta();
    const indicator = $("#st-webdav");
    if (indicator) {
      indicator.innerHTML = `<span class="webdav-state-icon spinning">⟳</span>${state.settings?.webdav_status_style === "text" ? " 同步中" : ""}`;
      
    }
    const result = await api.invoke("webdav_sync_now", { confirmDeletes: confirmed });
    recentConflicts = (result?.changed || []).filter((path) => path.includes("冲突"));
    if (result?.rescan_needed) rerun = true;
    if (indicator) 
    await webdavStatus();
    return result;
  } catch (error) {
    const msg = String(error);
    if (msg.includes("WEB_DAV_CONFIRM_DELETE:")) {
      const match = /WEB_DAV_CONFIRM_DELETE:(\d+):(\d+):(\d+):(\d+)/.exec(msg);
      const where = `本机 ${match?.[3] || 0} 页移进回收站，网盘上 ${match?.[4] || 0} 页移进远端 .trash`;
      if (await ask(`本次同步涉及大量删除：${where}。确定继续吗？取消后不会删除任何文件。`, "继续同步", true, true)) {
        return performWebdavSync(true);
      }
    } else if (!msg.includes("离线")) {
      toast(msg, 6500);
    }
    
    await webdavStatus().catch(() => {});
  }
}

export async function webdavRun(confirmed = false) {
  if (!enabled()) return;
  if (running) {
    rerun = true;
    return running;
  }
  running = (async () => {
    let initial = confirmed;
    do {
      rerun = false;
      await performWebdavSync(initial);
      initial = false;
    } while (rerun && enabled());
  })();
  try { return await running; }
  finally { running = null; }
}

async function openWebdavStatus() {
  const status = await webdavStatus();
  if (["conflict", "error", "offline", "confirm"].includes(status.state)) {
    const details = recentConflicts.length
      ? "\n冲突副本：" + recentConflicts.slice(0, 10).join("、")
      : "";
    const history = (status.history || []).slice(0, 5).join("\n");
    const summary = (status.message || "WebDAV 同步状态") + details + (history ? "\n\n最近记录：\n" + history : "");
    if (await ask(summary, "立即同步", false, true)) void webdavRun();
  } else {
    void webdavRun();
  }
}

export async function webdavSavePassword(password) {
  if (password) await api.invoke("webdav_set_password", { password });
}
export async function webdavTest(draft = {}) {
  const result = await api.invoke("webdav_test", draft);
  toast(result, 4000);
  return result;
}
export async function webdavForget() {
  if (!await ask("断开 WebDAV 并清除同步记录和已保存的密码？笔记不会被删除。", "断开")) return;
  await api.invoke("webdav_forget");
  state.settings.webdav_enabled = false;
  await webdavStatus();
  return true;
}
export function scheduleWebdavSave() {
  if (!enabled() || state.settings.webdav_after_save === false) return;
  clearTimeout(deferred);
  const seconds = Math.max(10, Math.min(300, Number(state.settings.webdav_delay_seconds) || 30));
  deferred = setTimeout(() => void webdavRun(), seconds * 1000);
}
export function resetWebdavTimers() {
  clearInterval(periodic);
  clearTimeout(deferred);
  if (!enabled() || isMiniWindow) return;
  const minutes = Number(state.settings.webdav_interval_minutes);
  if ([1, 5, 15, 30].includes(minutes)) {
    periodic = setInterval(() => void webdavRun(), minutes * 60_000);
  }
  void webdavStatus().catch(() => {});
}
export function bindWebdav() {
  api.listen("webdav-changed", () => {
    void syncFromDisk(true);
    void webdavStatus();
  });
  document.addEventListener("webdav-saved", scheduleWebdavSave);
  if (isMiniWindow) return;
  $("#st-webdav")?.addEventListener("click", () => void openWebdavStatus());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && enabled() && state.settings.webdav_on_hide !== false) {
      void webdavRun();
    }
  });
  resetWebdavTimers();
  if (enabled() && state.settings.webdav_on_start !== false) void webdavRun();
}
