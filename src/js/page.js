// ---------- 显示当前页面 ----------
import { $, editorEl, preview } from "./dom.js";
import { current } from "./state.js";
import { renderPreview } from "./preview.js";
import { scheduleMeta } from "./save.js";
import { showInEditor, leaveEditor, setEditorText, focusEditorView } from "./editor.js";

// 记下当前页面看到哪里:编辑模式存编辑器的状态(光标、撤销记录、滚动位置),阅读模式存滚动位置
export function rememberView() {
  const n = current();
  if (!n) return;
  if (n.mode === "edit") leaveEditor();
  else n.scroll = preview.scrollTop;
}

export function showNote() {
  const n = current();
  if (!n) return;
  if (n.mode === "edit") {
    preview.hidden = true;
    // 先显示出来再放内容,编辑器才量得出行高和滚动位置
    editorEl.hidden = false;
    showInEditor(n);
    focusEditorView();
  } else {
    leaveEditor(true);
    editorEl.hidden = true;
    preview.hidden = false;
    renderPreview(n.content);
    preview.scrollTop = n.scroll;
  }
  $("#btn-mode").classList.toggle("on", n.mode === "view");
  $("#st-mode").textContent = n.mode === "edit" ? "编辑" : "阅读";
  updateCount();
}

// 当前页面的内容在外面变了(n.content 已经是新内容):换上新内容,尽量保持光标和滚动位置
export function refreshCurrent() {
  const n = current();
  if (n.mode === "edit") {
    setEditorText(n);
  } else {
    const top = preview.scrollTop;
    renderPreview(n.content);
    preview.scrollTop = top;
  }
  updateCount();
}

export function updateCount() {
  const n = current();
  $("#st-count").textContent = n ? `${[...n.content].length} 字` : "";
}

// ---------- 编辑 / 阅读 ----------
export function toggleMode() {
  const n = current();
  if (!n) return;
  rememberView();
  n.mode = n.mode === "edit" ? "view" : "edit";
  n.scroll = 0;
  showNote();
  scheduleMeta();
}
