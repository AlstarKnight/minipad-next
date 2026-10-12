// Minipad Next 前端入口:启动、全局快捷键、按钮
import { api, isMock } from "./api.js";
import { $, tabsEl } from "./dom.js";
import { state, book, current } from "./state.js";
import { toast, dialogOpen, closeDialog, closeMenu, closeOverlays, focusEditor, ask, askText } from "./ui.js";
import { markDirty, flushAll, saveMeta, pendingNoteCount, resetActivity } from "./save.js";
import { reload, syncFromDisk } from "./sync.js";
import { rememberView } from "./page.js";
import { switchTo, newNote, deleteNote } from "./tabs.js";
import { toggleBooks, closeBooks, bindBooks } from "./notebooks.js";
import { openSearch, bindSearch } from "./search.js";
import { openSettings, saveSettings, applyEdgeAppearance, bindSettings } from "./settings.js";
import { createEditor, editorDebug, insertText, toggleTask } from "./editor.js";
import { setLinkPrompt, setTaskCommand } from "./toolbar.js";
import { formatDate } from "./datetime.js";

// ---------- 启动 ----------
async function init() {
  setLinkPrompt(() => askText("链接地址", "https://"));
  setTaskCommand(toggleTask);
  await createEditor({ onChange: markDirty, openLink, emptyBold: () => toggleBooks() });
  bindUi();
  await reload();
  api.listen("flush", () => { void flushAll().catch(() => {}); });
  api.listen("before-quit", (e) => { void handleQuit(e.payload); });
  api.listen("shown", () => {
    focusEditor();
    syncFromDisk();
  });
  api.listen("window-focus", () => {
    resetActivity();
    syncFromDisk();
  });
  // 贴边隐藏时,在露出来的那一条上显示标识
  api.listen("edge-hidden", (e) => {
    document.documentElement.dataset.edge = e.payload;
    applyEdgeAppearance();
  });
  // 「细边 + 悬浮按钮」样式:鼠标靠近时按钮浮出(窗口多露出一点),离开后收回
  api.listen("edge-peek", (e) => {
    if (e.payload) document.documentElement.dataset.edgePeek = "on";
    else delete document.documentElement.dataset.edgePeek;
    applyEdgeAppearance();
  });
  api.listen("edge-shown", () => {
    delete document.documentElement.dataset.edge;
    delete document.documentElement.dataset.edgePeek;
  });
  api.listen("backup-error", (e) => toast("自动备份失败:" + e.payload, 5000));
}

// 托盘退出确认后，给正常保存最多 10 秒。超时只弹确认，不直接退出。
// 单个请求在取消或退出确认前不会重复弹窗。
let quitInProgress = false;
async function handleQuit(id) {
  if (quitInProgress) return;
  quitInProgress = true;
  try {
    // ack 必须先发，表示 WebView 收到了消息，绝不代表已完成保存。
    if (!(await api.invoke("quit_ack", { id }))) return;
    const timeoutMs = isMock ? (window.__mockControl?.quitTimeoutMs ?? 10000) : 10000;
    let timer;
    const completed = (async () => {
      try {
        await flushAll();
        await saveMeta();
        return { ok: true, error: "" };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    })();
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: "保存等待超过 10 秒" }), timeoutMs);
    });
    const result = await Promise.race([completed, timeout]);
    clearTimeout(timer);
    const pending = pendingNoteCount();
    if (result.ok && !pending) {
      await api.invoke("quit_app");
      return;
    }
    await api.invoke("show_window");
    const detail = result.error || "部分页面仍有未保存的修改";
    const message = pending
      ? `有 ${pending} 页没保存成功（${detail}），仍要退出吗？`
      : `笔记元信息未保存成功（${detail}），仍要退出吗？`;
    if (await ask(message, "仍要退出", true)) {
      await api.invoke("quit_app");
    } else {
      await api.invoke("quit_cancel", { id });
    }
  } catch (e) {
    toast("退出确认失败：" + String(e), 7000);
    await api.invoke("quit_cancel", { id }).catch(() => {});
  } finally {
    quitInProgress = false;
  }
}

// 用系统浏览器打开链接(编辑区里 Ctrl+点击链接)
function openLink(href) {
  if (/^(https?:|mailto:)/i.test(href || "")) api.invoke("open_link", { url: href }).catch((err) => toast(String(err)));
}

// 有没有开着的弹层、菜单或对话框
function anyOverlay() {
  return dialogOpen() || ["#search", "#settings", "#books", "#ctx"].some((sel) => !$(sel).hidden);
}

// 顶栏的 Aa 按钮、格式栏右边的收起按钮:显示 / 收起格式栏,记在设置里
async function toggleFormatBar() {
  try {
    await saveSettings({ ...state.settings, format_bar: state.settings.format_bar === false });
  } catch (e) {
    toast(String(e));
  }
  focusEditor();
}

async function hideWindow() {
  rememberView();
  try {
    await flushAll();
    await saveMeta();
    await api.invoke("hide_window");
  } catch (e) {
    toast("保存失败：" + String(e), 5000);
  }
}

function bindUi() {
  $("#btn-book").addEventListener("click", () => toggleBooks());
  $("#btn-new").addEventListener("click", newNote);
  $("#btn-search").addEventListener("click", openSearch);
  $("#btn-settings").addEventListener("click", openSettings);
  $("#btn-hide").addEventListener("click", hideWindow);
  // 缩成悬浮图标(设置里开了悬浮图标才有这个按钮)
  $("#btn-ball").addEventListener("click", () => api.invoke("collapse_to_ball").catch((e) => toast(String(e))));
  $("#edge-expand").addEventListener("click", () => api.invoke("expand_edge").catch((e) => toast(String(e))));
  $("#btn-format").addEventListener("click", toggleFormatBar);
  // 太阳 / 月亮按钮:在浅色和深色之间切换(设置里的"跟随系统"也会换成选中的这个)
  $("#btn-theme").addEventListener("click", async () => {
    const dark = document.documentElement.dataset.theme === "dark";
    try {
      await saveSettings({ ...state.settings, theme: dark ? "light" : "dark" });
    } catch (e) {
      toast(String(e));
    }
  });
  document.addEventListener("hide-format-bar", toggleFormatBar);
  document.addEventListener("format-bar-items", (e) =>
    saveSettings({ ...state.settings, ...e.detail }).catch((err) => toast(String(err)))
  );
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
    if (!e.target.closest("#editor, textarea, input")) e.preventDefault();
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
      if (!ctrl && !e.altKey && !anyOverlay() && !e.target.closest?.("input, textarea, select") && current()) {
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
    // 编辑器自己处理过的快捷键(Ctrl+Z、Ctrl+B 加粗……)不再算窗口的
    if (!ctrl || e.defaultPrevented) return;
    if (k === "b") (e.preventDefault(), toggleBooks());
    else if (k === "t" || k === "n") (e.preventDefault(), newNote());
    else if (k === "f") (e.preventDefault(), openSearch());
    else if (k === "s") (e.preventDefault(), void flushAll().catch(() => {}));
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
    void flushAll().catch(() => {});
  });
  window.addEventListener("beforeunload", () => {
    void flushAll().catch(() => {});
    void saveMeta().catch(() => {});
  });
}

// 浏览器预览里给界面测试用
if (isMock) {
  window.__minipad = {
    state,
    sync: () => syncFromDisk(true),
    editor: editorDebug,
  };
}

init();
