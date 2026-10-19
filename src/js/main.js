// Minipad Next 前端入口:启动、全局快捷键、按钮
import { api, isMock, isMiniWindow } from "./api.js";
import { $ } from "./dom.js";
import { state, book, current } from "./state.js";
import { toast, dialogOpen, closeDialog, closeMenu, closeOverlays, focusEditor, ask, askText, openMenu } from "./ui.js";
import { markDirty, flushAll, saveMeta, pendingNoteCount, resetActivity } from "./save.js";
import { reload, syncFromDisk, addConflictCopy, showPendingNotice } from "./sync.js";
import { rememberView } from "./page.js";
import { switchTo, newNote, deleteNote, goTo } from "./tabs.js";
import { bindTabBar } from "./tabbar.js";
import { bindGroups } from "./groups.js";
import { toggleBooks, closeBooks, bindBooks, switchBook, createBook, openBooks } from "./notebooks.js";
import { openSearch, bindSearch } from "./search.js";
import { openFind, closeFind, findAgain, bindFind } from "./findbar.js";
import { bindImport, closeImport } from "./importer.js";
import { bindTrash, closeTrash } from "./trash.js";
import { bindQuick } from "./quickswitch.js";
import { openSettings, saveSettings, applySettings, applyEdgeAppearance, bindSettings, skippedText } from "./settings.js";
import { bindOutline } from "./outline.js";
import { upgradeColorLibrary } from "./sharedcolors.js";
import { createEditor, editorDebug, insertText, toggleTask, markLocalPathMissing } from "./editor.js";
import { setLinkPrompt, setTaskCommand } from "./toolbar.js";
import { formatDate } from "./datetime.js";
import { initMini, bindMiniMain } from "./mini.js";
import { bindUpdate } from "./update.js";
import { bindSidebar } from "./sidebar.js";
import { bindWebdav, resetWebdavTimers, webdavRun } from "./webdav.js";

// ---------- 启动 ----------
async function init() {
  setLinkPrompt(() => askText("链接地址", "https://"));
  setTaskCommand(toggleTask);
  await createEditor({
    onChange: markDirty, openLink, emptyBold: () => isMiniWindow || toggleBooks(),
    openLocalPath: (path) => void openLocalPath(path),
    localPathMenu: (path, x, y) => openMenu([
      { id: "open", label: "打开", act: () => void openLocalPath(path) },
      { id: "reveal", label: "在文件夹中显示", act: () => void showLocalPath(path) },
      { id: "copy", label: "复制路径", act: () => navigator.clipboard.writeText(path).catch((e) => toast(String(e))) },
    ], x, y),
  });
  bindUi();
  // 只检查当前可见的路径；节点重建时重新检查，失败时保留普通样式。
  const observedPaths = new WeakMap();
  const pathChecks = new Map();
  const pathObserver = new MutationObserver(() => {
    if (state.settings?.local_path_missing === false) return;
    for (const el of document.querySelectorAll("#editor [data-local-path]")) {
      if (observedPaths.has(el)) continue;
      observedPaths.set(el, true);
      const path = el.dataset.localPath;
      if (path.startsWith("\\\\")) continue; // 网络共享离线时不阻塞存在性检查。
      const cached = pathChecks.get(path);
      const check = cached && cached.until > Date.now() ? cached.check
        : api.invoke("local_path_exists", { path });
      if (!cached || cached.until <= Date.now()) {
        pathChecks.set(path, { check, until: Date.now() + 60_000 });
      }
      Promise.resolve(check)
        .then((exists) => { if (el.isConnected) markLocalPathMissing(path, !exists); })
        .catch(() => { pathChecks.delete(path); });
    }
  });
  pathObserver.observe($("#editor"), { subtree: true, childList: true });
  // 小窗:只放一页,别的(托盘退出、贴边隐藏、备份提示……)都归主窗口
  if (isMiniWindow) { bindWebdav(); return initMini(); }
  await reload();
  bindWebdav();
  void upgradeColorLibrary().catch(() => {});
  api.listen("flush", () => { void flushAll().catch(() => {}); });
  api.listen("before-quit", (e) => { void handleQuit(e.payload); });
  api.listen("shown", () => {
    focusEditor();
    showPendingNotice();
    syncFromDisk();
  });
  api.listen("window-focus", () => {
    resetActivity();
    showPendingNotice();
    syncFromDisk();
  });
  // 贴边隐藏时,在露出来的那一条上显示标识
  api.listen("edge-hidden", () => {
    if (state.settings?.webdav_enabled && state.settings?.webdav_on_hide !== false) void webdavRun();
  });
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
  // 今天的备份里有读不了的文件(比如被别的程序独占打开)没装进去
  api.listen("backup-skipped", (e) => toast(skippedText(e.payload), 9000));
  // 在小窗里改的设置(比如 Ctrl+加号 调字号)
  api.listen("settings-changed", (e) => {
    state.settings = e.payload;
    applySettings();
  });
  bindMiniMain();
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
        // 小窗里的页面:让每个小窗自己存好(后端最多等 8 秒)
        const miniErrors = await api.invoke("mini_flush_all");
        if (miniErrors?.length) return { ok: false, error: miniErrors.join("；"), mini: true };
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
      : result.mini
        ? `小窗里的页面没保存成功（${detail}），仍要退出吗？`
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

// 后端再次检查路径是否存在，并阻止未确认的可执行文件运行。
async function openLocalPath(path) {
  try {
    const trusted = state.settings?.local_path_trusted || [];
    const danger = /\.(exe|bat|cmd|ps1|vbs|js|msi|lnk|scr)$/i.test(path);
    let confirmed = false;
    if (danger && state.settings?.local_path_confirm !== false && !trusted.includes(path)) {
      const allowed = await ask("将要运行以下文件，是否继续？\\n" + path, "运行", true);
      if (!allowed) return;
      confirmed = true;
      if (await ask("这个文件以后不再询问？", "记住此文件")) {
        await saveSettings({ ...state.settings, local_path_trusted: [...trusted, path] });
      }
    }
    await api.invoke("open_path", { path, reveal: false, confirmed });
  } catch (e) { toast(String(e)); }
}
async function showLocalPath(path) {
  try {
    await api.invoke("open_path", { path, reveal: true, confirmed: false });
  } catch (e) { toast(String(e)); }
}

// 有没有开着的弹层、菜单或对话框
function anyOverlay() {
  return dialogOpen() || ["#search", "#quick", "#settings", "#import", "#trash", "#books", "#book-manager", "#ctx"].some((sel) => !$(sel).hidden);
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
  bindUpdate();
  bindSidebar({ switchBook, goTo, createBook, openBooks: () => openBooks() });
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
  // 贴边隐藏的开关:关掉就一直显示(正贴边藏着时马上放出来),再点一下恢复
  $("#btn-edge").addEventListener("click", async () => {
    try {
      await saveSettings({ ...state.settings, edge_hide: !state.settings.edge_hide });
      toast(state.settings.edge_hide ? "已打开贴边隐藏" : "一直显示,靠边也不隐藏");
    } catch (e) {
      toast(String(e));
    }
  });
  $("#btn-pin").addEventListener("click", async () => {
    try {
      await saveSettings({ ...state.settings, always_on_top: !state.settings.always_on_top });
    } catch (e) {
      toast(String(e));
    }
  });

  // Alt + 鼠标左键可以从窗口任意非弹层位置拖动，不占用编辑区普通点击和选中。
  document.addEventListener("mousedown", (e) => {
    if (!e.altKey || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.target.closest(".overlay, #ctx, #books, #pages-menu")) return;
    e.preventDefault();
    api.invoke("start_window_drag").catch((err) => toast("拖动窗口失败：" + err));
  }, true);

  bindBooks();
  bindSearch();
  bindFind();
  bindSettings();
  bindImport();
  bindTrash();
  bindQuick();
  bindOutline();
  bindTabBar();
  bindGroups();
  // 保存时发现这一页在别处也改过:那边的版本已经另存成冲突副本,放到这一页后面
  document.addEventListener("conflict-copy", (e) => addConflictCopy(e.detail));
  // 格式栏上的查找按钮
  document.addEventListener("open-find", () => openFind());

  $("#dialog-ok").addEventListener("click", () => closeDialog(true));
  $("#dialog-cancel").addEventListener("click", () => closeDialog(false));

  document.querySelectorAll(".overlay").forEach((o) =>
    o.addEventListener("mousedown", (e) => {
      if (e.target !== o) return;
      // 点对话框外面只取消对话框,底下的笔记本列表留着;导入窗口也只关它自己,底下的设置留着
      if (o.id === "dialog") closeDialog(false);
      else if (o.id === "import") closeImport();
      else if (o.id === "trash") closeTrash();
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
    // F3 / Shift+F3:在当前页面里找下一个 / 上一个(查找栏没开时先打开)
    if (e.key === "F3") {
      e.preventDefault();
      if (!ctrl && !e.altKey && !anyOverlay() && current()) findAgain(e.shiftKey ? -1 : 1);
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
      // 一次关一层:先关右键菜单,再关弹层,然后是查找栏,都没有才隐藏窗口
      if (!$("#ctx").hidden) closeMenu();
      else if (!closeImport() && !closeTrash() && !closeOverlays() && !closeFind() && !isMiniWindow) hideWindow();
      return;
    }
    // 编辑器自己处理过的快捷键(Ctrl+Z、Ctrl+B 加粗……)不再算窗口的
    if (!ctrl || e.defaultPrevented) return;
    // 小窗里只有这一页:换页、新建、删除、笔记本列表、搜索全部页面都不用
    if (isMiniWindow) {
      if (k === "f" || k === "h") (e.preventDefault(), openFind({ replace: k === "h" }));
      else if (k === "s") (e.preventDefault(), void flushAll().catch(() => {}));
      else if (k === "=" || k === "+" || k === "-") {
        e.preventDefault();
        const fs = Math.min(28, Math.max(10, (state.settings.font_size || 14) + (k === "-" ? -1 : 1)));
        saveSettings({ ...state.settings, font_size: fs }).catch(() => {});
      } else if (["b", "t", "n", "w", "tab", "1", "2", "3", "4", "5", "6", "7", "8", "9"].includes(k)) e.preventDefault();
      return;
    }
    if (k === "b") (e.preventDefault(), toggleBooks());
    else if (k === "t" || k === "n") (e.preventDefault(), newNote());
    else if (k === "f") {
      // Ctrl+F 在当前页面里查找还是搜索全部页面,设置里选;Ctrl+Shift+F 是另一个
      e.preventDefault();
      if ((state.settings?.ctrl_f !== "all") !== e.shiftKey) openFind();
      else openSearch();
    } else if (k === "h") (e.preventDefault(), openFind({ replace: true }));
    else if (k === "s") (e.preventDefault(), void flushAll().catch(() => {}));
    else if (k === "w") (e.preventDefault(), deleteNote(current()));
    else if (e.key === "Tab") {
      e.preventDefault();
      const b = book();
      const len = b.notes.length;
      // 跳过在小窗里编辑的页面
      let i = b.active;
      for (let step = 0; step < len; step++) {
        i = (i + (e.shiftKey ? -1 : 1) + len) % len;
        if (!b.notes[i].mini) break;
      }
      switchTo(i);
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
    // 马上把还没保存的页面和元信息存掉(不等防抖)
    flush: () => Promise.allSettled([flushAll(), saveMeta()]),
  };
}

init();
