// ---------- 显示当前页面 ----------
import { $ } from "./dom.js";
import { current } from "./state.js";
import { showInEditor, leaveEditor, setEditorText, focusEditorView } from "./editor.js";

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
  updateCount();
}

// 当前页面的内容在外面变了(n.content 已经是新内容):换上新内容,尽量保持光标和滚动位置
export function refreshCurrent() {
  setEditorText(current());
  showReadError(current());
  updateCount();
}

export function updateCount() {
  const n = current();
  $("#st-count").textContent = n && !n.unreadable ? `${[...n.content].length} 字` : "";
}

function showReadError(n) {
  const box = $("#read-error");
  box.hidden = !n?.unreadable;
  box.textContent = n?.unreadable ? "这一页读取失败:" + (n.reason || "未知错误") : "";
  document.documentElement.toggleAttribute("data-unreadable", !!n?.unreadable);
}
