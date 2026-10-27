// ---------- 小窗:把一页放进单独的小窗口(0.4.0) ----------
// 主窗口这边:哪些页面在小窗里(标签变淡、只读)、打开 / 切到 / 放回小窗;
// 小窗这边:只读这一页、标题栏的置顶 / 透明度 / 放回 / 关闭、关之前先存好。
import { api } from "./api.js";
import { $ } from "./dom.js";
import { state, book, current, inMini, bookFromDisk } from "./state.js";
import { toast, ask } from "./ui.js";
import { flushAll } from "./save.js";
import { mutate, syncFromDisk, readNotes } from "./sync.js";
import { rememberView, showNote, refreshCurrent } from "./page.js";
import { renderTabs, switchTo, goTo } from "./tabs.js";
import { applySettings } from "./settings.js";
import { refreshSharedColors } from "./sharedcolors.js";
import { addEntry, dropEmptyEntry } from "./capture.js";

// ---- 主窗口 ----

export function miniAllowed() {
  return state.settings?.mini_enabled !== false;
}

// 放进小窗:先把这一页存好,小窗从磁盘读;at 是拖出标签时松手的屏幕位置
export async function openInMini(b, n, at = null) {
  if (!b || !n) return;
  if (n.mini) return focusMini(b, n);
  if (!miniAllowed()) return toast("小窗已经关掉了,可以在 设置 → 窗口 里打开", 4000);
  if (n.unreadable) return toast(`「${n.name}」读取失败,不能放进小窗`, 4000);
  try {
    if (n === current()) rememberView();
    await flushAll();
    await api.invoke("mini_open", { book: b.name, name: n.name, x: at?.x ?? null, y: at?.y ?? null });
  } catch (e) {
    toast("没能打开小窗:" + e, 4000);
  }
}

export function focusMini(b, n) {
  api
    .invoke("mini_focus", { book: b.name, name: n.name })
    .then((ok) => ok || toast("找不到这一页的小窗"))
    .catch((e) => toast(String(e)));
}

// 右键「放回主窗口」:小窗存好以后自己关掉,主窗口切到这一页
export function recallMini(b, n) {
  api.invoke("mini_recall", { book: b.name, name: n.name }).catch((e) => toast(String(e)));
}

// 改名、移动、删除前检查:页面(或笔记本里有页面)正在小窗里编辑就不做
export function refuseInMini(target, action) {
  const notes = target?.notes || [target];
  const n = notes.find((x) => x?.mini);
  if (!n) return false;
  toast(`「${n.name}」正在小窗里编辑,先把它放回主窗口再${action}`, 4000);
  return true;
}

// 后端告诉的小窗列表:标出这些页面;当前页面去了小窗就换到旁边那页
async function setMinis(list) {
  state.minis = Array.isArray(list) ? list : [];
  const freed = [];
  for (const b of state.books) {
    for (const n of b.notes) {
      const mini = inMini(b.name, n.name);
      if (n.mini && !mini) freed.push([b, n]);
      n.mini = mini;
    }
  }
  const b = book();
  if (current()?.mini) {
    const free = nearestFree(b);
    if (free >= 0) switchTo(free);
  }
  renderTabs();
  showNote();
  if (freed.length) await reread(freed);
}

// 当前页面旁边第一个不在小窗里的页面
function nearestFree(b) {
  for (let d = 1; d < b.notes.length; d++) {
    for (const i of [b.active + d, b.active - d]) {
      const n = b.notes[i];
      if (n && !n.mini) return i;
    }
  }
  return -1;
}

// 从小窗回来的页面:读一下磁盘上的最新内容(小窗刚存过)
async function reread(pairs) {
  try {
    const disk = await readNotes();
    let changed = false;
    for (const [b, n] of pairs) {
      const d = disk.find((x) => x.name === b.name)?.notes.find((x) => x.name === n.name);
      // same:小窗没改过这一页,磁盘上还是上次读到的
      if (!d || d.same || d.unreadable || n.dirty || n.content !== n.disk) continue;
      n.content = d.content;
      n.disk = d.content;
      n.stamp = d.stamp || "";
      if (n === current()) changed = true;
    }
    if (changed) refreshCurrent();
  } catch {
    void syncFromDisk(true);
  }
}

function returned({ book: bookName, name, back }) {
  if (!back) return;
  const b = state.books.find((x) => x.name === bookName);
  const n = b?.notes.find((x) => x.name === name);
  if (n) goTo(b, n);
}

export function bindMiniMain() {
  api.listen("mini-changed", (e) => void setMinis(e.payload));
  api.listen("mini-returned", (e) => returned(e.payload || {}));
  // 读完笔记以后:先问现在开着哪些(网页重新载入时),再恢复上次退出时开着的
  api
    .invoke("mini_list")
    .then(setMinis)
    .then(() => api.invoke("mini_restore"))
    .catch(() => {});
  // 点主窗口里「这一页正在小窗里编辑」的提示
  document.addEventListener("focus-mini", () => current()?.mini && focusMini(book(), current()));
}

// ---- 小窗 ----

let self = null;

// 这是快速记录的小窗(0.5.1):Esc 收起
export const capturing = () => !!self?.capture;

export async function initMini() {
  const root = document.documentElement;
  root.dataset.mini = "";
  try {
    self = await api.invoke("mini_self");
    if (!self) return void api.invoke("mini_close", { back: false });
    await mutate(async () => {
      // 小窗只读自己这一页
      const st = await api.invoke("load_state", { only: { book: self.book, name: self.name } });
      state.settings = st.settings;
      state.notesDir = st.notes_dir;
      state.version = st.version || "";
      state.debug = !!st.debug;
      const d = st.books.find((x) => x.name === self.book);
      const nd = d?.notes.find((x) => x.name === self.name);
      if (!nd) throw `找不到页面「${self.name}」`;
      state.books = [bookFromDisk({ ...d, notes: [nd], active: nd.name })];
      state.book = 0;
      applySettings();
      showNote();
      if (self.capture) addEntry(state.settings);
    });
  } catch (e) {
    toast("小窗读取页面失败:" + e, 6000);
  }
  document.title = self?.name || "小窗";
  $("#mini-title").textContent = self?.name || "";
  $("#mini-title").title = self ? `${self.name}(拖动这里移动小窗)` : "";
  paintTop(self?.top !== false);
  paintOpacity(self?.opacity ?? 100);
  bindMiniBar();
  api.listen("flush", () => void flushAll().catch(() => {}));
  api.listen("window-focus", () => void syncFromDisk());
  api.listen("settings-changed", (e) => {
    state.settings = e.payload;
    applySettings();
    // 颜色库可能是从手机同步来的
    refreshSharedColors();
  });
  // 退出程序前:存好以后告诉后端
  api.listen("mini-flush", async () => {
    let error = null;
    try {
      rememberView();
      await flushAll();
    } catch (e) {
      error = String(e);
    }
    api.invoke("mini_flushed", { error }).catch(() => {});
  });
  api.listen("mini-close-request", () => void closeMini(false));
  api.listen("mini-recall", () => void closeMini(true));
  // 页面已经开在这个小窗里时又按了快速记录:加一条新的
  api.listen("mini-capture", () => {
    if (self) self.capture = true;
    addEntry(state.settings);
  });
}

// 关小窗 / 放回主窗口:先存好,存不了就问一下
export async function closeMini(back) {
  dropEmptyEntry();
  rememberView();
  try {
    await flushAll();
  } catch (e) {
    if (!(await ask(`这一页没保存成功(${e}),仍要关闭小窗吗?`, "仍要关闭", true))) return;
  }
  await api.invoke("mini_close", { back }).catch((e) => toast(String(e)));
}

function paintTop(on) {
  if (self) self.top = on;
  const btn = $("#btn-mini-top");
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-pressed", String(on));
  btn.title = on ? "取消置顶" : "置顶";
}

function paintOpacity(v) {
  const value = Math.min(100, Math.max(40, Number(v) || 100));
  if (self) self.opacity = value;
  document.documentElement.style.setProperty("--mini-opacity", String(value / 100));
  $("#mini-opacity").value = value;
  $("#mini-opacity-val").textContent = value + "%";
  $("#btn-mini-opacity").title = `透明度:${value}%(鼠标移上来时不透明)`;
}

function bindMiniBar() {
  $("#btn-mini-top").addEventListener("click", () => {
    const top = !self?.top;
    paintTop(top);
    api.invoke("mini_set", { top, opacity: null }).catch((e) => toast(String(e)));
  });
  const pop = $("#mini-opacity-pop");
  $("#btn-mini-opacity").addEventListener("click", () => {
    pop.hidden = !pop.hidden;
  });
  const slider = $("#mini-opacity");
  // 拖动滑块时先不变回不透明,好看到效果
  slider.addEventListener("input", () => {
    document.documentElement.dataset.miniPreview = "";
    paintOpacity(slider.value);
  });
  slider.addEventListener("change", () => {
    delete document.documentElement.dataset.miniPreview;
    api.invoke("mini_set", { top: null, opacity: Number(slider.value) }).catch((e) => toast(String(e)));
  });
  document.addEventListener("mousedown", (e) => {
    if (!pop.hidden && !e.target.closest("#mini-opacity-pop, #btn-mini-opacity")) pop.hidden = true;
  });
  $("#btn-mini-back").addEventListener("click", () => void closeMini(true));
  $("#btn-mini-close").addEventListener("click", () => void closeMini(false));
}
