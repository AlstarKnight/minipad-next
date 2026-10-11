// Minipad Next 前端入口:启动、全局快捷键、按钮
import { api, isMock } from "./api.js";
import { $, preview, tabsEl } from "./dom.js";
import { state, book, current } from "./state.js";
import { toast, dialogOpen, closeDialog, closeMenu, closeOverlays, focusEditor } from "./ui.js";
import { markDirty, flushAll, saveMeta, resetActivity } from "./save.js";
import { reload, syncFromDisk } from "./sync.js";
import { rememberView, toggleMode } from "./page.js";
import { switchTo, newNote, deleteNote } from "./tabs.js";
import { toggleBooks, closeBooks, bindBooks } from "./notebooks.js";
import { setupMarkdown } from "./preview.js";
import { openSearch, bindSearch } from "./search.js";
import { openSettings, saveSettings, bindSettings } from "./settings.js";
import { createEditor, editorView, insertText } from "./editor.js";
import { formatDate } from "./datetime.js";

// ---------- 启动 ----------
async function init() {
  setupMarkdown();
  createEditor({ onChange: markDirty });
  bindUi();
  await reload();
  api.listen("flush", () => flushAll());
  api.listen("before-quit", async () => {
    await flushAll();
    await saveMeta();
    api.invoke("quit_app");
  });
  api.listen("shown", () => {
    focusEditor();
    syncFromDisk();
  });
  api.listen("window-focus", () => {
    resetActivity();
    syncFromDisk();
  });
  api.listen("backup-error", (e) => toast("自动备份失败:" + e.payload, 5000));
}

// 有没有开着的弹层、菜单或对话框
function anyOverlay() {
  return dialogOpen() || ["#search", "#settings", "#books", "#ctx"].some((sel) => !$(sel).hidden);
}

async function hideWindow() {
  rememberView();
  await flushAll();
  await saveMeta();
  api.invoke("hide_window");
}

function bindUi() {
  preview.addEventListener("click", (e) => {
    const a = e.target.closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") || "";
    if (/^(https?:|mailto:)/i.test(href)) api.invoke("open_link", { url: href }).catch((err) => toast(String(err)));
  });
  preview.addEventListener("dblclick", (e) => {
    if (e.target.closest(".codeblock, a")) return;
    toggleMode();
  });

  $("#btn-book").addEventListener("click", () => toggleBooks());
  $("#btn-new").addEventListener("click", newNote);
  $("#btn-search").addEventListener("click", openSearch);
  $("#btn-mode").addEventListener("click", toggleMode);
  $("#btn-settings").addEventListener("click", openSettings);
  $("#btn-hide").addEventListener("click", hideWindow);
  $("#btn-pin").addEventListener("click", async () => {
    try {
      await saveSettings({ ...state.settings, always_on_top: !state.settings.always_on_top });
    } catch (e) {
      toast(String(e));
    }
  });

  bindBooks();
  bindSearch();
  bindSettings();

  $("#dialog-ok").addEventListener("click", () => closeDialog(true));
  $("#dialog-cancel").addEventListener("click", () => closeDialog(false));

  document.querySelectorAll(".overlay").forEach((o) =>
    o.addEventListener("mousedown", (e) => {
      if (e.target !== o) return;
      // 点对话框外面只取消对话框,底下的笔记本列表留着
      if (o.id === "dialog") closeDialog(false);
      else closeOverlays();
    })
  );

  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest("#ctx")) closeMenu();
    if (!e.target.closest("#books, #btn-book, #ctx, #dialog")) closeBooks();
  });
  // 只在编辑区、输入框和阅读区保留系统右键菜单
  document.addEventListener("contextmenu", (e) => {
    if (!e.target.closest("#editor, textarea, input, #preview")) e.preventDefault();
  });
  // 标签栏上滚轮横向滚动
  tabsEl.addEventListener("wheel", (e) => {
    if (e.deltaY) {
      e.preventDefault();
      tabsEl.scrollLeft += e.deltaY;
    }
  });

  document.addEventListener("keydown", (e) => {
    // 输入法正在拼字时按的回车、Esc 是给输入法的
    if (e.isComposing || e.keyCode === 229) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    // F5 和记事本一样在光标处插入当前的日期时间;弹层、对话框开着或者在输入框里时什么也不做(也不刷新页面)
    if (e.key === "F5") {
      e.preventDefault();
      if (!ctrl && !e.altKey && !anyOverlay() && !e.target.closest?.("input, textarea, select") && current()?.mode === "edit") {
        insertText(formatDate(new Date(), state.settings?.date_format));
      }
      return;
    }
    // 正式版里屏蔽浏览器自带的刷新和打印,免得误按
    if (!state.debug && ctrl && (k === "r" || k === "p")) {
      e.preventDefault();
      return;
    }
    if (dialogOpen()) {
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        // 焦点在"取消"上时按回车也是取消
        closeDialog(e.key === "Enter" && e.target !== $("#dialog-cancel"));
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      // 一次关一层:先关右键菜单,再关弹层,都没有才隐藏窗口
      if (!$("#ctx").hidden) closeMenu();
      else if (!closeOverlays()) hideWindow();
      return;
    }
    if (!ctrl) return;
    if (k === "b") (e.preventDefault(), toggleBooks());
    else if (k === "t" || k === "n") (e.preventDefault(), newNote());
    else if (k === "e") (e.preventDefault(), toggleMode());
    else if (k === "f") (e.preventDefault(), openSearch());
    else if (k === "s") (e.preventDefault(), flushAll());
    else if (k === "w") (e.preventDefault(), deleteNote(current()));
    else if (e.key === "Tab") {
      e.preventDefault();
      const b = book();
      const len = b.notes.length;
      switchTo((b.active + (e.shiftKey ? -1 : 1) + len) % len);
    } else if (/^[1-9]$/.test(e.key)) {
      e.preventDefault();
      const i = Number(e.key) - 1;
      switchTo(e.key === "9" ? book().notes.length - 1 : i);
    } else if (k === "=" || k === "+" || k === "-") {
      e.preventDefault();
      const fs = Math.min(28, Math.max(10, (state.settings.font_size || 14) + (k === "-" ? -1 : 1)));
      saveSettings({ ...state.settings, font_size: fs }).catch(() => {});
    }
    // 用了别的快捷键就收起笔记本列表
    if (k !== "b" && e.defaultPrevented) closeBooks();
  });

  window.addEventListener("blur", () => {
    rememberView();
    flushAll();
  });
  window.addEventListener("beforeunload", () => {
    flushAll();
    saveMeta();
  });
}

// 浏览器预览里给界面测试用
if (isMock) {
  window.__minipad = {
    state,
    sync: () => syncFromDisk(true),
    get view() {
      return editorView();
    },
  };
}

init();
