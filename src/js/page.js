// ---------- 显示当前页面 ----------
import { $ } from "./dom.js";
import { current } from "./state.js";
import { showInEditor, leaveEditor, setEditorText, focusEditorView, visibleLength } from "./editor.js";

// 记下当前页面看到哪里:编辑器的状态(光标、撤销记录)和滚动位置
export function rememberView() {
  if (current()) leaveEditor();
}

export function showNote() {
  const n = current();
  if (!n) return;
  showInEditor(n);
  showReadError(n);
  focusEditorView();
  paintCount();
}

// 当前页面的内容在外面变了(n.content 已经是新内容):换上新内容,尽量保持光标和滚动位置
export function refreshCurrent() {
  setEditorText(current());
  showReadError(current());
  paintCount();
}

// 打字时状态栏的字数最多 0.2 秒算一次,很长的页面也不拖慢打字
let countTimer = 0;
export function updateCount() {
  if (!countTimer) countTimer = setTimeout(paintCount, 200);
}

function paintCount() {
  clearTimeout(countTimer);
  countTimer = 0;
  const n = current();
  $("#st-count").textContent = n && !n.unreadable ? `${visibleLength()} 字` : "";
}

// 只读横幅在窄窗口换行后高度可能继续变化。
const readErrorObserver = new ResizeObserver(() => {
  const box = $("#read-error");
  $("#main").style.setProperty("--read-error-height", box.hidden ? "0px" : box.getBoundingClientRect().height + 12 + "px");
});
readErrorObserver.observe($("#read-error"));

function showReadError(n) {
  const box = $("#read-error");
  box.hidden = !n?.unreadable;
  box.textContent = n?.unreadable ? "这一页读取失败:" + (n.reason || "未知错误") : "";
  document.documentElement.toggleAttribute("data-unreadable", !!n?.unreadable);
  // 告警可换行、选择复制；用实际高度挪开正文，避免长文件名截断提示。
  $("#main").style.setProperty("--read-error-height",
    n?.unreadable ? box.getBoundingClientRect().height + 12 + "px" : "0px");
}
