"use strict";

// ---------- 后端接口(在浏览器里打开时用 localStorage 模拟,方便预览界面) ----------
const TAURI = window.__TAURI__;
const api = TAURI
  ? {
      invoke: (cmd, args) => TAURI.core.invoke(cmd, args),
      listen: (ev, cb) => TAURI.event.listen(ev, cb),
    }
  : mockApi();

const $ = (sel) => document.querySelector(sel);
const editor = $("#editor");
const preview = $("#preview");
const tabsEl = $("#tabs");

const state = {
  notes: [], // { name, content, mode, dirty, scroll, sel }
  active: 0,
  settings: null,
  notesDir: "",
};

// ---------- 启动 ----------
async function init() {
  setupMarkdown();
  bindUi();
  await reload();
  api.listen("flush", () => flushAll());
  api.listen("before-quit", async () => {
    await flushAll();
    await saveMeta();
    api.invoke("quit_app");
  });
  api.listen("shown", () => {
    if (current().mode === "edit") editor.focus();
  });
  api.listen("hotkey-error", (e) => toast("热键注册失败(" + e.payload + "),请在设置里换一个"));
}

async function reload() {
  try {
    const st = await api.invoke("load_state");
    state.settings = st.settings;
    state.notesDir = st.notes_dir;
    state.notes = st.notes.map((n) => ({ ...n, dirty: false, scroll: 0, sel: [0, 0] }));
    state.active = Math.max(0, state.notes.findIndex((n) => n.name === st.active));
    applySettings();
    renderTabs();
    showNote();
  } catch (e) {
    toast("读取笔记失败:" + e);
  }
}

function current() {
  return state.notes[state.active];
}

// ---------- 保存 ----------
let saveTimer = null;
let metaTimer = null;

function markDirty() {
  const n = current();
  n.content = editor.value;
  n.dirty = true;
  setSaveStatus("dirty");
  updateCount();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushAll, 500);
}

async function flushAll() {
  clearTimeout(saveTimer);
  const dirty = state.notes.filter((n) => n.dirty);
  if (!dirty.length) return;
  try {
    for (const n of dirty) {
      n.dirty = false;
      await api.invoke("save_note", { name: n.name, content: n.content });
    }
    setSaveStatus("saved");
  } catch (e) {
    dirty.forEach((n) => (n.dirty = true));
    setSaveStatus("err", String(e));
  }
}

function scheduleMeta() {
  clearTimeout(metaTimer);
  metaTimer = setTimeout(saveMeta, 300);
}

async function saveMeta() {
  clearTimeout(metaTimer);
  const modes = {};
  state.notes.forEach((n) => (modes[n.name] = n.mode));
  try {
    await api.invoke("save_meta", {
      order: state.notes.map((n) => n.name),
      active: current()?.name ?? "",
      modes,
    });
  } catch (e) {
    console.error(e);
  }
}

function setSaveStatus(kind, msg) {
  const el = $("#st-save");
  el.className = kind === "dirty" ? "dirty" : kind === "err" ? "err" : "";
  el.textContent = kind === "dirty" ? "保存中…" : kind === "err" ? "保存失败:" + msg : "已保存";
}

// ---------- 标签 ----------
function renderTabs() {
  tabsEl.innerHTML = "";
  state.notes.forEach((n, i) => {
    const t = document.createElement("div");
    t.className = "tab" + (i === state.active ? " active" : "");
    t.draggable = true;
    t.dataset.index = i;
    t.title = n.name;
    const s = document.createElement("span");
    s.textContent = n.name;
    t.appendChild(s);
    t.addEventListener("mousedown", (e) => {
      if (e.button === 0 && !t.querySelector("input")) switchTo(i);
    });
    t.addEventListener("dblclick", () => startRename(i));
    t.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openCtx(i, e.clientX, e.clientY);
    });
    t.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/x-tab", String(i));
      e.dataTransfer.effectAllowed = "move";
    });
    t.addEventListener("dragover", (e) => {
      e.preventDefault();
      const after = e.offsetX > t.offsetWidth / 2;
      t.classList.toggle("drop-after", after);
      t.classList.toggle("drop-before", !after);
    });
    t.addEventListener("dragleave", () => t.classList.remove("drop-after", "drop-before"));
    t.addEventListener("drop", (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer.getData("text/x-tab"));
      const after = t.classList.contains("drop-after");
      t.classList.remove("drop-after", "drop-before");
      moveTab(from, i + (after ? 1 : 0));
    });
    tabsEl.appendChild(t);
  });
  const act = tabsEl.children[state.active];
  act?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function moveTab(from, to) {
  if (Number.isNaN(from) || from === to || from + 1 === to) return;
  const activeNote = current();
  const [n] = state.notes.splice(from, 1);
  state.notes.splice(from < to ? to - 1 : to, 0, n);
  state.active = state.notes.indexOf(activeNote);
  renderTabs();
  scheduleMeta();
}

function rememberView() {
  const n = current();
  if (!n) return;
  if (n.mode === "edit") {
    n.scroll = editor.scrollTop;
    n.sel = [editor.selectionStart, editor.selectionEnd];
  } else {
    n.scroll = preview.scrollTop;
  }
}

function switchTo(i) {
  if (i < 0 || i >= state.notes.length || i === state.active) return;
  rememberView();
  state.active = i;
  renderTabs();
  showNote();
  scheduleMeta();
}

function showNote() {
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

function updateCount() {
  const n = current();
  $("#st-count").textContent = n ? `${[...n.content].length} 字` : "";
}

async function newNote() {
  await flushAll();
  try {
    const name = await api.invoke("create_note", { name: "新页面" });
    rememberView();
    state.notes.splice(state.active + 1, 0, { name, content: "", mode: "edit", dirty: false, scroll: 0, sel: [0, 0] });
    state.active += 1;
    renderTabs();
    showNote();
    scheduleMeta();
    startRename(state.active);
  } catch (e) {
    toast("新建失败:" + e);
  }
}

function startRename(i) {
  const t = tabsEl.children[i];
  if (!t || t.querySelector("input")) return;
  const n = state.notes[i];
  const input = document.createElement("input");
  input.value = n.name;
  t.draggable = false;
  t.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const val = input.value.trim();
    if (commit && val && val !== n.name) {
      try {
        await flushAll();
        const newName = await api.invoke("rename_note", { old: n.name, new: val });
        n.name = newName;
        scheduleMeta();
      } catch (e) {
        toast("重命名失败:" + e);
      }
    }
    renderTabs();
    if (current().mode === "edit") editor.focus();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      finish(e.key === "Enter");
    }
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("mousedown", (e) => e.stopPropagation());
}

async function deleteNote(i) {
  const n = state.notes[i];
  const msg = n.content.trim()
    ? `删除页面「${n.name}」?\n(文件会移到笔记文件夹的 .trash 里,可以找回)`
    : `删除空白页面「${n.name}」?`;
  if (!confirm(msg)) return;
  try {
    await flushAll();
    await api.invoke("delete_note", { name: n.name });
    state.notes.splice(i, 1);
    if (!state.notes.length) {
      const name = await api.invoke("create_note", { name: "新页面" });
      state.notes.push({ name, content: "", mode: "edit", dirty: false, scroll: 0, sel: [0, 0] });
    }
    if (state.active >= state.notes.length || i < state.active) state.active = Math.max(0, state.active - 1);
    renderTabs();
    showNote();
    scheduleMeta();
  } catch (e) {
    toast("删除失败:" + e);
  }
}

// ---------- 右键菜单 ----------
let ctxIndex = -1;
function openCtx(i, x, y) {
  ctxIndex = i;
  const m = $("#ctx");
  m.hidden = false;
  m.style.left = Math.min(x, window.innerWidth - m.offsetWidth - 4) + "px";
  m.style.top = Math.min(y, window.innerHeight - m.offsetHeight - 4) + "px";
}
function closeCtx() {
  $("#ctx").hidden = true;
}

// ---------- 编辑 / 阅读 ----------
function toggleMode() {
  const n = current();
  rememberView();
  n.mode = n.mode === "edit" ? "view" : "edit";
  n.scroll = 0;
  showNote();
  scheduleMeta();
}

function setupMarkdown() {
  marked.setOptions({ gfm: true, breaks: true });
}

function renderPreview(md) {
  const html = DOMPurify.sanitize(marked.parse(md || ""), { ADD_ATTR: ["target"] });
  preview.innerHTML = html || '<p style="color:var(--muted)">(空白页面,按 Ctrl+E 开始编辑)</p>';
  preview.querySelectorAll("pre > code").forEach((code) => {
    const pre = code.parentElement;
    const wrap = document.createElement("div");
    wrap.className = "codeblock";
    pre.replaceWith(wrap);
    wrap.appendChild(pre);
    const raw = code.textContent;
    const langClass = [...code.classList].find((c) => c.startsWith("language-"));
    const lang = langClass ? langClass.slice(9) : "";
    try {
      if (lang && hljs.getLanguage(lang)) hljs.highlightElement(code);
      else if (raw.length < 20000) {
        const r = hljs.highlightAuto(raw);
        code.innerHTML = r.value;
        code.classList.add("hljs");
      }
    } catch (_) {}
    if (lang) {
      const tag = document.createElement("span");
      tag.className = "lang";
      tag.textContent = lang;
      wrap.appendChild(tag);
    }
    const btn = document.createElement("button");
    btn.className = "copy";
    btn.textContent = "复制";
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ok = await copyText(raw.replace(/\n$/, ""));
      btn.textContent = ok ? "已复制" : "复制失败";
      btn.classList.toggle("done", ok);
      setTimeout(() => {
        btn.textContent = "复制";
        btn.classList.remove("done");
      }, 1400);
    });
    wrap.appendChild(btn);
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (_) {}
    ta.remove();
    return ok;
  }
}

// ---------- 搜索 ----------
let results = [];
let resultSel = 0;

function openSearch() {
  closeOverlays();
  $("#search").hidden = false;
  const input = $("#search-input");
  const sel = editor.hidden ? "" : editor.value.slice(editor.selectionStart, editor.selectionEnd);
  if (sel && !sel.includes("\n")) input.value = sel;
  input.focus();
  input.select();
  runSearch();
}

function runSearch() {
  const q = $("#search-input").value;
  const box = $("#search-results");
  results = [];
  resultSel = 0;
  box.innerHTML = "";
  box.dataset.empty = q ? "没有找到" : "输入关键字,搜索所有页面的内容和标题";
  if (!q) return;
  const ql = q.toLowerCase();
  for (const [ni, n] of state.notes.entries()) {
    if (n.name.toLowerCase().includes(ql)) results.push({ ni, pos: -1 });
    const text = n.content.toLowerCase();
    let pos = text.indexOf(ql);
    while (pos !== -1 && results.length < 300) {
      results.push({ ni, pos });
      pos = text.indexOf(ql, pos + ql.length);
    }
  }
  results.slice(0, 300).forEach((r, idx) => {
    const n = state.notes[r.ni];
    const b = document.createElement("button");
    b.className = "result" + (idx === 0 ? " sel" : "");
    if (r.pos === -1) {
      b.innerHTML = `<div class="where">页面标题</div><div class="snip">${mark(n.name, ql)}</div>`;
    } else {
      const lineNo = n.content.slice(0, r.pos).split("\n").length;
      const ls = n.content.lastIndexOf("\n", r.pos - 1) + 1;
      let le = n.content.indexOf("\n", r.pos);
      if (le === -1) le = n.content.length;
      const start = Math.max(ls, r.pos - 30);
      const line = (start > ls ? "…" : "") + n.content.slice(start, le);
      b.innerHTML = `<div class="where">${esc(n.name)} · 第 ${lineNo} 行</div><div class="snip">${mark(line, ql)}</div>`;
    }
    b.addEventListener("click", () => openResult(idx));
    box.appendChild(b);
  });
}

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function mark(s, ql) {
  const out = [];
  const low = s.toLowerCase();
  let i = 0;
  let p;
  while ((p = low.indexOf(ql, i)) !== -1) {
    out.push(esc(s.slice(i, p)), "<mark>", esc(s.slice(p, p + ql.length)), "</mark>");
    i = p + ql.length;
  }
  out.push(esc(s.slice(i)));
  return out.join("");
}

function moveResult(d) {
  const items = $("#search-results").children;
  if (!items.length) return;
  items[resultSel]?.classList.remove("sel");
  resultSel = (resultSel + d + items.length) % items.length;
  items[resultSel].classList.add("sel");
  items[resultSel].scrollIntoView({ block: "nearest" });
}

function openResult(idx) {
  const r = results[idx];
  if (!r) return;
  const qlen = $("#search-input").value.length;
  closeOverlays();
  rememberView();
  state.active = r.ni;
  const n = current();
  n.mode = "edit";
  if (r.pos >= 0) n.sel = [r.pos, r.pos + qlen];
  renderTabs();
  showNote();
  scheduleMeta();
  if (r.pos >= 0) scrollEditorTo(r.pos);
}

// 用一个隐藏的镜像元素量出光标所在高度,把匹配位置滚到窗口中间
function scrollEditorTo(pos) {
  const cs = getComputedStyle(editor);
  const m = document.createElement("div");
  for (const p of ["fontFamily", "fontSize", "lineHeight", "paddingLeft", "paddingRight", "paddingTop", "tabSize", "letterSpacing"]) m.style[p] = cs[p];
  m.style.position = "absolute";
  m.style.visibility = "hidden";
  m.style.whiteSpace = "pre-wrap";
  m.style.wordWrap = "break-word";
  m.style.width = editor.clientWidth + "px";
  m.textContent = editor.value.slice(0, pos);
  document.body.appendChild(m);
  const y = m.scrollHeight;
  m.remove();
  editor.scrollTop = Math.max(0, y - editor.clientHeight / 2);
}

// ---------- 设置 ----------
function applySettings() {
  const s = state.settings;
  const theme =
    s.theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : s.theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.setProperty("--font-size", (s.font_size || 14) + "px");
  $("#btn-pin").classList.toggle("on", s.always_on_top);
  $("#btn-pin").title = s.always_on_top ? "取消置顶" : "窗口置顶";
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => state.settings && applySettings());

function openSettings() {
  closeOverlays();
  const s = state.settings;
  $("#set-hotkey").value = s.hotkey;
  $("#set-top").checked = s.always_on_top;
  $("#set-edge").checked = s.edge_hide;
  $("#set-taskbar").checked = s.show_in_taskbar;
  $("#set-autostart").checked = s.autostart;
  $("#set-theme").value = s.theme;
  $("#set-font").value = s.font_size;
  $("#set-dir").value = s.notes_dir;
  $("#set-dir").placeholder = state.notesDir;
  $("#set-error").hidden = true;
  $("#settings").hidden = false;
}

async function saveSettings(next) {
  const dirChanged = next.notes_dir.trim() !== (state.settings.notes_dir || "").trim();
  if (dirChanged) {
    await flushAll();
    await saveMeta();
  }
  state.settings = await api.invoke("save_settings", { settings: next });
  applySettings();
  if (dirChanged) await reload();
}

async function submitSettings() {
  const next = {
    ...state.settings,
    hotkey: $("#set-hotkey").value || state.settings.hotkey,
    always_on_top: $("#set-top").checked,
    edge_hide: $("#set-edge").checked,
    show_in_taskbar: $("#set-taskbar").checked,
    autostart: $("#set-autostart").checked,
    theme: $("#set-theme").value,
    font_size: Math.min(28, Math.max(10, Number($("#set-font").value) || 14)),
    notes_dir: $("#set-dir").value.trim(),
  };
  try {
    await saveSettings(next);
    closeOverlays();
    toast("设置已保存");
  } catch (e) {
    const err = $("#set-error");
    err.textContent = String(e);
    err.hidden = false;
  }
}

function hotkeyFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  const c = e.code;
  if (/^(Control|Alt|Shift|Meta|OS)/.test(c)) return null;
  let key;
  if (/^Key[A-Z]$/.test(c)) key = c.slice(3);
  else if (/^Digit\d$/.test(c)) key = c.slice(5);
  else if (/^F\d{1,2}$/.test(c)) key = c;
  else key = c;
  if (!mods.length && !/^F\d{1,2}$/.test(key)) return null;
  return [...mods, key].join("+");
}

// ---------- 通用 ----------
function closeOverlays() {
  const wasOpen = !$("#search").hidden || !$("#settings").hidden;
  $("#search").hidden = true;
  $("#settings").hidden = true;
  $("#set-hotkey").classList.remove("recording");
  closeCtx();
  if (wasOpen && current()?.mode === "edit") editor.focus();
  return wasOpen;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

async function hideWindow() {
  rememberView();
  await flushAll();
  await saveMeta();
  api.invoke("hide_window");
}

function bindUi() {
  editor.addEventListener("input", markDirty);
  editor.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      document.execCommand("insertText", false, "\t");
    }
  });

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

  $("#search-input").addEventListener("input", runSearch);
  $("#search-input").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") (e.preventDefault(), moveResult(1));
    else if (e.key === "ArrowUp") (e.preventDefault(), moveResult(-1));
    else if (e.key === "Enter") (e.preventDefault(), openResult(resultSel));
  });

  const hk = $("#set-hotkey");
  hk.addEventListener("focus", () => hk.classList.add("recording"));
  hk.addEventListener("blur", () => hk.classList.remove("recording"));
  hk.addEventListener("keydown", (e) => {
    if (e.key === "Tab") return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return hk.blur();
    const combo = hotkeyFromEvent(e);
    if (combo) hk.value = combo;
  });
  $("#set-save").addEventListener("click", submitSettings);
  $("#set-cancel").addEventListener("click", closeOverlays);
  $("#set-open-dir").addEventListener("click", () => api.invoke("open_notes_dir").catch((e) => toast(String(e))));

  document.querySelectorAll(".overlay").forEach((o) =>
    o.addEventListener("mousedown", (e) => {
      if (e.target === o) closeOverlays();
    })
  );

  $("#ctx").addEventListener("click", (e) => {
    const act = e.target.closest("button")?.dataset.act;
    const i = ctxIndex;
    closeCtx();
    if (act === "rename") startRename(i);
    if (act === "delete") deleteNote(i);
  });
  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest("#ctx")) closeCtx();
  });
  // 只在输入框和阅读区保留系统右键菜单
  document.addEventListener("contextmenu", (e) => {
    if (!e.target.closest("textarea, input, #preview")) e.preventDefault();
  });
  // 标签栏上滚轮横向滚动
  tabsEl.addEventListener("wheel", (e) => {
    if (e.deltaY) {
      e.preventDefault();
      tabsEl.scrollLeft += e.deltaY;
    }
  });

  document.addEventListener("keydown", (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") {
      e.preventDefault();
      if (!closeOverlays()) hideWindow();
      return;
    }
    if (!ctrl) return;
    const k = e.key.toLowerCase();
    if (k === "t" || k === "n") (e.preventDefault(), newNote());
    else if (k === "e") (e.preventDefault(), toggleMode());
    else if (k === "f") (e.preventDefault(), openSearch());
    else if (k === "s") (e.preventDefault(), flushAll());
    else if (k === "w") (e.preventDefault(), deleteNote(state.active));
    else if (e.key === "Tab") {
      e.preventDefault();
      const len = state.notes.length;
      switchTo((state.active + (e.shiftKey ? -1 : 1) + len) % len);
    } else if (/^[1-9]$/.test(e.key)) {
      e.preventDefault();
      const i = Number(e.key) - 1;
      switchTo(e.key === "9" ? state.notes.length - 1 : i);
    } else if (k === "=" || k === "+" || k === "-") {
      e.preventDefault();
      const fs = Math.min(28, Math.max(10, (state.settings.font_size || 14) + (k === "-" ? -1 : 1)));
      saveSettings({ ...state.settings, font_size: fs }).catch(() => {});
    }
  });

  window.addEventListener("blur", () => {
    rememberView();
    flushAll();
  });
}

// ---------- 浏览器预览用的模拟后端 ----------
function mockApi() {
  const KEY = "minipad-next-demo";
  const load = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || null;
    } catch (_) {
      return null;
    }
  };
  let db = load() || {
    settings: { hotkey: "Ctrl+M", always_on_top: true, edge_hide: true, show_in_taskbar: false, autostart: false, theme: "system", font_size: 14, notes_dir: "" },
    files: {
      欢迎: "# 欢迎使用 Minipad Next\n\n这是浏览器里的界面预览,真正的程序在 Windows 上运行。\n\n```js\nconsole.log('点右上角的复制按钮试试');\n```\n",
    },
    meta: { order: ["欢迎"], active: "欢迎", modes: { 欢迎: "view" } },
  };
  const persist = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(db));
    } catch (_) {}
  };
  const uniq = (base, except) => {
    base = base.replace(/[<>:"/\\|?*]/g, "_").trim() || "新页面";
    const taken = (n) => n !== except && Object.keys(db.files).some((k) => k.toLowerCase() === n.toLowerCase());
    if (!taken(base)) return base;
    for (let i = 2; ; i++) if (!taken(`${base} (${i})`)) return `${base} (${i})`;
  };
  const cmds = {
    load_state: () => {
      const names = Object.keys(db.files);
      const order = db.meta.order.filter((n) => names.includes(n)).concat(names.filter((n) => !db.meta.order.includes(n)));
      return {
        settings: db.settings,
        notes_dir: "(浏览器预览)",
        notes: order.map((n) => ({ name: n, content: db.files[n], mode: db.meta.modes[n] || "edit" })),
        active: order.includes(db.meta.active) ? db.meta.active : order[0],
      };
    },
    save_note: ({ name, content }) => void (db.files[name] = content),
    create_note: ({ name }) => {
      const n = uniq(name);
      db.files[n] = "";
      return n;
    },
    rename_note: ({ old, new: nw }) => {
      const n = uniq(nw, old);
      const c = db.files[old];
      delete db.files[old];
      db.files[n] = c;
      return n;
    },
    delete_note: ({ name }) => void delete db.files[name],
    save_meta: (m) => void (db.meta = m),
    save_settings: ({ settings }) => (db.settings = settings),
    hide_window: () => toast("(预览)窗口会隐藏到托盘,按 Ctrl+M 再呼出"),
    open_notes_dir: () => toast("(预览)会在资源管理器里打开笔记文件夹"),
    open_link: ({ url }) => void window.open(url, "_blank", "noopener"),
    quit_app: () => {},
  };
  return {
    invoke: async (cmd, args = {}) => {
      const r = cmds[cmd](args);
      persist();
      return r;
    },
    listen: async () => () => {},
  };
}

init();
