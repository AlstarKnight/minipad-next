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
    bar.textContent = (states[status.state] || "○") +
      (style === "text" ? " " + (status.message || "WebDAV") : "");
    bar.title = status.message || "WebDAV 同步";
    const choice = state.settings?.webdav_status_color || "";
    const color = parseAccent(choice);
    bar.style.color = color?.from || "var(--accent)";
    bar.style.backgroundImage = color?.to ? choice : "";
    bar.style.backgroundClip = color?.to ? "text" : "";
    bar.style.webkitBackgroundClip = color?.to ? "text" : "";
    bar.style.webkitTextFillColor = color?.to ? "transparent" : "";
  }
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
    const result = await api.invoke("webdav_sync_now", { confirmDeletes: confirmed });
    await webdavStatus();
    return result;
  } catch (error) {
    const msg = String(error);
    if (msg.includes("WEB_DAV_CONFIRM_DELETE:")) {
      const match = /WEB_DAV_CONFIRM_DELETE:(\d+):(\d+)/.exec(msg);
      const count = match?.[1] || "多";
      if (await ask(`本次同步要删除 ${count} 页，确定继续吗？取消后不会删除任何文件。`, "继续同步", true, true)) {
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

export async function webdavSavePassword(password) {
  if (password) await api.invoke("webdav_set_password", { password });
}
export async function webdavTest() {
  const result = await api.invoke("webdav_test");
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
  if (isMiniWindow) return;
  $("#st-webdav")?.addEventListener("click", () => void webdavRun());
  api.listen("webdav-changed", () => {
    void syncFromDisk(true);
    void webdavStatus();
  });
  document.addEventListener("webdav-saved", scheduleWebdavSave);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && enabled() && state.settings.webdav_on_hide !== false) {
      void webdavRun();
    }
  });
  resetWebdavTimers();
  if (enabled() && state.settings.webdav_on_start !== false) void webdavRun();
}
