// ---------- 新版本提醒(0.4.3) ----------
// 启动时查一次 GitHub 上最新的 Release,比现在的版本新,状态栏右边就显示「新版本 x.y.z」,点它打开下载页。
// 设置 → 常规 里可以关掉
import { api, isMiniWindow } from "./api.js";
import { $ } from "./dom.js";
import { state } from "./state.js";
import { toast } from "./ui.js";

const REPO = "https://github.com/AlstarKnight/minipad-next";
const LATEST = "https://api.github.com/repos/AlstarKnight/minipad-next/releases/latest";

const parts = (v) => (/^v?(\d+)\.(\d+)\.(\d+)$/.exec((v || "").trim()) || []).slice(1).map(Number);

export function isNewer(latest, current) {
  const [a, b] = [parts(latest), parts(current)];
  if (a.length < 3 || b.length < 3) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

let found = null;
let checked = false;

function paint() {
  const btn = $("#st-update");
  btn.hidden = !found || state.settings?.update_check === false;
  if (found) btn.textContent = `新版本 ${found.version}`;
}

async function check() {
  checked = true;
  try {
    const res = await fetch(LATEST, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) return;
    const { tag_name, html_url } = await res.json();
    if (!isNewer(tag_name, state.version)) return;
    const url = typeof html_url === "string" && html_url.startsWith(REPO + "/releases/") ? html_url : REPO + "/releases/latest";
    found = { version: tag_name.replace(/^v/, ""), url };
    paint();
  } catch (_) {
    // 没网、被限流都不提示,下次启动再查
  }
}

// 启动时和改了设置以后调用:打开着、还没查过就查一次。小窗不查,只在主窗口提示
export function applyUpdateCheck() {
  if (isMiniWindow) return;
  paint();
  if (!checked && state.settings?.update_check !== false && parts(state.version).length === 3) void check();
}

export function bindUpdate() {
  $("#st-update").addEventListener("click", () => {
    if (found) api.invoke("open_link", { url: found.url }).catch((e) => toast(String(e)));
  });
}
