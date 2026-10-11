// ---------- 提示、对话框、右键菜单 ----------
import { $ } from "./dom.js";
import { current } from "./state.js";
import { closeBooks } from "./notebooks.js";
import { focusEditorView } from "./editor.js";

export function focusEditor() {
  if (current()?.mode === "edit") focusEditorView();
}

let toastTimer;
export function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// ---------- 对话框:确认,或者输入一个名字 ----------
let dialogResolve = null;
let dialogText = false;

export function dialogOpen() {
  return !!dialogResolve;
}

function openDialog(message, okLabel, danger, value) {
  // 笔记本列表留着:在列表里改名、删除笔记本以后还回到列表
  closeOverlays(true);
  $("#dialog-msg").textContent = message;
  const ok = $("#dialog-ok");
  ok.textContent = okLabel;
  ok.classList.toggle("danger", danger);
  const input = $("#dialog-input");
  dialogText = value != null;
  input.hidden = !dialogText;
  $("#dialog").hidden = false;
  if (dialogText) {
    input.value = value;
    input.focus();
    input.select();
  } else {
    ok.focus();
  }
  return new Promise((resolve) => (dialogResolve = resolve));
}

// 得到 true / false
export function ask(message, okLabel = "确定", danger = false) {
  return openDialog(message, okLabel, danger, null);
}

// 得到去掉首尾空白的文字,取消时得到 null
export function askText(message, value = "", okLabel = "确定") {
  return openDialog(message, okLabel, false, value);
}

export function closeDialog(ok) {
  if (!dialogResolve) return false;
  $("#dialog").hidden = true;
  const resolve = dialogResolve;
  dialogResolve = null;
  resolve(dialogText ? (ok ? $("#dialog-input").value.trim() : null) : ok);
  focusEditor();
  return true;
}

// ---------- 右键菜单 ----------
// items: [{ id, label, act, danger, disabled }]
export function openMenu(items, x, y) {
  const m = $("#ctx");
  m.replaceChildren(
    ...items.map((it) => {
      const b = document.createElement("button");
      b.dataset.act = it.id;
      b.textContent = it.label;
      b.disabled = !!it.disabled;
      if (it.danger) b.className = "danger";
      b.addEventListener("click", () => {
        closeMenu();
        it.act();
      });
      return b;
    })
  );
  m.hidden = false;
  m.style.left = Math.max(4, Math.min(x, window.innerWidth - m.offsetWidth - 4)) + "px";
  m.style.top = Math.max(4, Math.min(y, window.innerHeight - m.offsetHeight - 4)) + "px";
}

export function closeMenu() {
  $("#ctx").hidden = true;
}

// 关掉弹层,返回原来有没有开着的(Esc 先关弹层,没有弹层才隐藏窗口)
export function closeOverlays(keepBooks = false) {
  const wasOpen = !$("#search").hidden || !$("#settings").hidden || (!keepBooks && !$("#books").hidden);
  closeDialog(false);
  $("#search").hidden = true;
  $("#settings").hidden = true;
  $("#set-hotkey").classList.remove("recording");
  if (!keepBooks) closeBooks();
  closeMenu();
  if (wasOpen) focusEditor();
  return wasOpen;
}
