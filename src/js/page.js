// ---------- 显示当前页面 ----------
import { $, editor, preview } from "./dom.js";
import { current } from "./state.js";
import { renderPreview } from "./preview.js";
import { scheduleMeta } from "./save.js";

export function rememberView() {
  const n = current();
  if (!n) return;
  if (n.mode === "edit") {
    n.scroll = editor.scrollTop;
    n.sel = [editor.selectionStart, editor.selectionEnd];
  } else {
    n.scroll = preview.scrollTop;
  }
}

export function showNote() {
  const n = current();
  if (!n) return;
  if (n.mode === "edit") {
    preview.hidden = true;
    editor.hidden = false;
    editor.value = n.content;
    editor.setSelectionRange(n.sel[0], n.sel[1]);
    editor.scrollTop = n.scroll;
    editor.focus();
  } else {
    editor.hidden = true;
    preview.hidden = false;
    renderPreview(n.content);
    preview.scrollTop = n.scroll;
  }
  $("#btn-mode").classList.toggle("on", n.mode === "view");
  $("#st-mode").textContent = n.mode === "edit" ? "编辑" : "阅读";
  updateCount();
}

// 当前页面的内容在外面变了:换上新内容,尽量保持光标和滚动位置
export function refreshCurrent() {
  const n = current();
  if (n.mode === "edit") {
    if (editor.value !== n.content) {
      const s = editor.selectionStart;
      const e = editor.selectionEnd;
      const top = editor.scrollTop;
      editor.value = n.content;
      editor.setSelectionRange(Math.min(s, n.content.length), Math.min(e, n.content.length));
      editor.scrollTop = top;
    }
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
