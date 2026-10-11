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
  focusEditorView();
  updateCount();
}

// 当前页面的内容在外面变了(n.content 已经是新内容):换上新内容,尽量保持光标和滚动位置
export function refreshCurrent() {
  setEditorText(current());
  updateCount();
}

export function updateCount() {
  const n = current();
  $("#st-count").textContent = n ? `${[...n.content].length} 字` : "";
}
