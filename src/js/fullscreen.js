// ---------- 全屏编辑(0.5.5) ----------
// 只留正文:顶栏、侧栏和状态栏藏起来(设置里可以留着标签栏和格式栏),正文居中、限宽,也可以单独设字号。
// 默认铺满整个屏幕(后端把主窗口变成全屏),也可以窗口大小不变。快捷键默认 F11,Esc 或右上角的按钮退出
import { api } from "./api.js";
import { $ } from "./dom.js";
import { state } from "./state.js";
import { toast, focusEditor } from "./ui.js";
import { keysOf, keyLabel } from "./shortcuts.js";

// 正文宽度滑块拉到最右是不限宽度
export const FS_WIDTH_MAX = 2000;

let on = false;
// 现在后端是不是铺满了屏幕(退出时、换成「窗口大小不变」时要告诉后端)
let screen = false;

export const inFullscreen = () => on;

export function setFullscreen(next) {
  if (next && state.settings?.fullscreen_enabled === false) return;
  on = next;
  applyFullscreen();
  focusEditor();
}

// 设置变了也走这里:关掉全屏编辑时退出,宽度、字号、留不留标签栏马上换上
export function applyFullscreen() {
  const s = state.settings || {};
  const root = document.documentElement;
  if (s.fullscreen_enabled === false) on = false;
  root.toggleAttribute("data-fullscreen", on);
  root.toggleAttribute("data-fs-tabs", !!s.fullscreen_tabs);
  root.toggleAttribute("data-fs-format", !!s.fullscreen_format_bar);
  const width = Number(s.fullscreen_width) || 860;
  root.style.setProperty("--fs-width", width >= FS_WIDTH_MAX ? "none" : width + "px");
  const size = Number(s.fullscreen_font_size) || 0;
  if (size) root.style.setProperty("--fs-font-size", size + "px");
  else root.style.removeProperty("--fs-font-size");
  $("#fs-exit").hidden = !on || s.fullscreen_exit_button === false;
  const btn = $("#btn-fullscreen");
  btn.hidden = s.fullscreen_enabled === false || s.fullscreen_button === false;
  const key = keysOf(s, "fullscreen")[0];
  btn.title = "全屏编辑" + (key ? ` (${keyLabel(key)})` : "");
  const want = on && s.fullscreen_mode !== "window";
  if (want !== screen) {
    screen = want;
    api.invoke("set_fullscreen", { on: want }).catch((e) => toast("全屏没能切换:" + e, 4000));
  }
}

export function bindFullscreen() {
  $("#btn-fullscreen").addEventListener("click", () => setFullscreen(true));
  $("#fs-exit").addEventListener("click", () => setFullscreen(false));
}
