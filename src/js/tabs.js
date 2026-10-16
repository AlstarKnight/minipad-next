// ---------- 标签(当前笔记本的页面) ----------
import { api } from "./api.js";
import { tabsEl } from "./dom.js";
import { state, book, current, makeNote } from "./state.js";
import { toast, ask, openMenu, focusEditor } from "./ui.js";
import { flushAll, holdSaves, scheduleMeta, scheduleBooks } from "./save.js";
import { syncContent } from "./editor.js";
import { mutate } from "./sync.js";
import { rememberView, showNote } from "./page.js";
import { openBooks, renderBook } from "./notebooks.js";
import { groupsOn, groupOf, tidyGroups, groupChip, groupMenuItems, joinNeighbour, revealNote, groupVars } from "./groups.js";
import { refreshTabBar, afterSwitch, tabsVertical, revealActive } from "./tabbar.js";
import { openInMini, focusMini, recallMini, refuseInMini, miniAllowed } from "./mini.js";

// 正在拖动的标签对应的页面
let dragged = null;

// 第 i 页的标签(打开分组时标签前面还夹着分组的名字,不能按位置找)
export function tabAt(i) {
  return tabsEl.querySelector(`.tab[data-index="${i}"]`);
}

// 固定的页面排在最前面(按固定的先后),不在分组里;当前页面跟着对象走
export function tidyPinned(b) {
  const active = b.notes[b.active];
  for (const n of b.notes) if (n.pinned) n.group = "";
  const sorted = [...b.notes.filter((n) => n.pinned), ...b.notes.filter((n) => !n.pinned)];
  if (sorted.every((n, i) => n === b.notes[i])) return;
  b.notes.splice(0, b.notes.length, ...sorted);
  b.active = Math.max(0, sorted.indexOf(active));
}

// 固定 / 取消固定:固定的放到固定区的最后,取消的放到固定区后面第一个
export function togglePin(n) {
  const b = book();
  if (!b.notes.includes(n)) return;
  const active = current();
  b.notes.splice(b.notes.indexOf(n), 1);
  n.pinned = !n.pinned;
  b.notes.splice(b.notes.filter((x) => x.pinned).length, 0, n);
  b.active = Math.max(0, b.notes.indexOf(active));
  renderTabs();
  scheduleMeta(b);
}

export function renderTabs() {
  const b = book();
  tabsEl.innerHTML = "";
  if (!b) return refreshTabBar();
  const grouped = groupsOn();
  if (grouped) tidyGroups(b);
  tidyPinned(b);
  b.notes.forEach((n, i) => {
    const g = grouped ? groupOf(b, n) : null;
    if (g && groupOf(b, b.notes[i - 1]) !== g) {
      tabsEl.appendChild(groupChip(b, g, b.notes.filter((x) => x.group === g.id).length));
    }
    const t = document.createElement("div");
    t.className = "tab" + (i === b.active ? " active" : "") + (n.unreadable ? " unreadable" : "") + (n.pinned ? " pinned" : "") + (n.mini ? " in-mini" : "");
    if (n.pinned && !b.notes[i + 1]?.pinned) t.classList.add("pin-end");
    if (g) {
      t.classList.add("in-group");
      groupVars(t, g.color);
      if (groupOf(b, b.notes[i + 1]) !== g) t.classList.add("group-end");
      // 折叠起来的分组只留当前页面的标签
      if (g.collapsed && i !== b.active) t.classList.add("folded");
    }
    t.draggable = true;
    t.dataset.index = i;
    t.title = n.unreadable ? `${n.name}:读取失败:${n.reason || "未知错误"}` : n.name;
    if (n.pinned) {
      const mark = document.createElement("i");
      mark.className = "pin-mark";
      mark.innerHTML = '<svg viewBox="0 0 16 16"><path d="M6 1.5h4M7 1.5v4L4.5 8.5h7L9 5.5v-4M8 8.5v6"/></svg>';
      t.appendChild(mark);
      t.title += "(已固定)";
    }
    const s = document.createElement("span");
    s.textContent = n.name;
    t.appendChild(s);
    // 在小窗里编辑的页面:标签变淡,后面标上「小窗」,点了切到那个小窗
    if (n.mini) {
      const badge = document.createElement("em");
      badge.className = "mini-badge";
      badge.textContent = "小窗";
      t.appendChild(badge);
      t.title += "(正在小窗里编辑,点一下切到小窗)";
    } else if (miniAllowed() && state.settings?.mini_tab_button !== false && !n.unreadable) {
      // 鼠标移上来时出现的 ↗:放进小窗(在名字右边的空白里,不挡名字)
      const pop = document.createElement("button");
      pop.className = "tab-mini";
      pop.type = "button";
      pop.title = "在小窗中打开";
      pop.setAttribute("aria-label", `在小窗中打开「${n.name}」`);
      pop.innerHTML = '<svg viewBox="0 0 16 16"><path d="M9 3h4v4M13 3 7.5 8.5M11.5 10v2.5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1H6"/></svg>';
      pop.addEventListener("mousedown", (e) => (e.stopPropagation(), e.preventDefault()));
      pop.addEventListener("click", (e) => {
        e.stopPropagation();
        openInMini(book(), n);
      });
      t.appendChild(pop);
    }
    // 事件里用页面对象而不是位置,中途同步过也不会点错页面
    t.addEventListener("mousedown", (e) => {
      if (e.button === 0 && !t.querySelector("input")) switchTo(book().notes.indexOf(n));
    });
    // 按下鼠标时浏览器会把焦点从编辑区拿走,松开时再放回去,点完标签就能接着打字。
    // 换页时标签重画过,松开时鼠标下面已经是新画的标签,所以不用 click
    t.addEventListener("mouseup", (e) => {
      if (e.button === 0 && !t.querySelector("input")) focusEditor();
    });
    t.addEventListener("dblclick", () => startRename(n));
    t.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const groupItems = n.pinned ? [] : groupMenuItems(n);
      const b = book();
      const miniItems = n.mini
        ? [
            { id: "mini-focus", label: "切到小窗", act: () => focusMini(b, n) },
            { id: "mini-back", label: "放回主窗口", act: () => recallMini(b, n) },
          ]
        : [];
      const openItem = !n.mini && miniAllowed() && !n.unreadable
        ? [{ id: "mini-open", label: "在小窗中打开", act: () => openInMini(b, n) }]
        : [];
      // 在小窗里编辑时不能改名、移动、删除(先放回主窗口)
      const away = n.mini ? "(先放回主窗口)" : "";
      openMenu(
        [
          ...miniItems,
          { id: "rename", label: "重命名" + away, act: () => startRename(n), disabled: n.mini },
          { id: "pin", label: n.pinned ? "取消固定" : "固定标签", act: () => togglePin(n) },
          { id: "move", label: "移到笔记本…" + away, act: () => openBooks(n), disabled: n.mini },
          ...groupItems,
          ...openItem,
          { id: "delete", label: n.pinned ? "删除页面(先取消固定)" : "删除页面" + away, act: () => deleteNote(n), danger: true, disabled: n.pinned || n.mini },
        ],
        e.clientX,
        e.clientY
      );
    });
    t.addEventListener("dragstart", (e) => {
      dragged = n;
      e.dataTransfer.setData("text/x-tab", String(i));
      e.dataTransfer.effectAllowed = "move";
    });
    // 把标签拖到窗口外面松手:这一页放进小窗,小窗出现在松手的地方
    t.addEventListener("dragend", (e) => {
      dragged = null;
      if (e.dataTransfer.dropEffect !== "none" || n.mini || !miniAllowed()) return;
      const outside =
        e.screenX < window.screenX || e.screenX > window.screenX + window.outerWidth ||
        e.screenY < window.screenY || e.screenY > window.screenY + window.outerHeight;
      if (outside) openInMini(book(), n, { x: e.screenX, y: e.screenY });
    });
    // 横着排时看鼠标在标签的左半还是右半,竖着排(侧拉的页面列表)时看上半还是下半
    // 按标签自己的位置算(鼠标在名字或 ↗ 上时 offsetX 是相对它们的)
    const after = (e) => {
      const r = t.getBoundingClientRect();
      return tabsVertical() ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
    };
    t.addEventListener("dragover", (e) => {
      e.preventDefault();
      const a = after(e);
      t.classList.toggle("drop-after", a);
      t.classList.toggle("drop-before", !a);
    });
    t.addEventListener("dragleave", () => t.classList.remove("drop-after", "drop-before"));
    t.addEventListener("drop", (e) => {
      e.preventDefault();
      const a = t.classList.contains("drop-after");
      t.classList.remove("drop-after", "drop-before");
      const notes = book().notes;
      if (!notes.includes(n) || !dragged) return;
      moveTab(notes.indexOf(dragged), notes.indexOf(n) + (a ? 1 : 0), n);
    });
    tabsEl.appendChild(t);
  });
  revealActive();
  refreshTabBar();
}

// 拖动标签:放到 target 旁边(打开分组时也就进了 target 所在的分组)
export function moveTab(from, to, target = null) {
  const b = book();
  if (from < 0) return;
  const n = b.notes[from];
  const joins = target && groupsOn() && (n.group || "") !== (groupOf(b, target) ? target.group : "");
  if ((from === to || from + 1 === to) && !joins) return;
  const activeNote = current();
  b.notes.splice(from, 1);
  b.notes.splice(from < to ? to - 1 : to, 0, n);
  if (target && !n.pinned) joinNeighbour(b, n, target);
  b.active = b.notes.indexOf(activeNote);
  renderTabs();
  scheduleMeta(b);
}

export function switchTo(i) {
  const b = book();
  if (i < 0 || i >= b.notes.length || i === b.active) return;
  if (b.notes[i].mini) return focusMini(b, b.notes[i]);
  rememberView();
  b.active = i;
  revealNote(b, b.notes[i]);
  renderTabs();
  showNote();
  scheduleMeta(b);
  afterSwitch();
}

// 打开某个笔记本里的某一页(快速切换、回收站恢复以后用)
export function goTo(b, n) {
  if (!state.books.includes(b) || !b.notes.includes(n)) return;
  if (n.mini) return focusMini(b, n);
  rememberView();
  if (b !== book()) {
    state.book = state.books.indexOf(b);
    renderBook();
    scheduleBooks();
  }
  b.active = b.notes.indexOf(n);
  revealNote(b, n);
  renderTabs();
  showNote();
  scheduleMeta(b);
  afterSwitch();
}

// 新页面放在当前页面后面,和当前页面在同一个分组里;传了分组就放到那个分组的最后
export async function newNote(group = null) {
  await flushAll();
  try {
    await mutate(async () => {
      const b = book();
      const name = await api.invoke("create_note", { book: b.name, name: "新页面" });
      const g = groupsOn() ? (group?.id ? group : groupOf(b, current())) : null;
      const n = makeNote(name, "", "edit", false, null, g ? g.id : "");
      rememberView();
      let at = Math.min(b.active + 1, b.notes.length);
      if (group?.id) b.notes.forEach((x, i) => x.group === group.id && (at = i + 1));
      if (g) g.collapsed = false;
      b.notes.splice(at, 0, n);
      b.active = at;
      renderTabs();
      showNote();
      scheduleMeta(b);
      startRename(n);
    });
  } catch (e) {
    toast("新建失败:" + e);
  }
}

export function startRename(n) {
  if (refuseInMini(n, "改名")) return;
  const b = book();
  const t = tabAt(b.notes.indexOf(n));
  if (!t || t.querySelector("input")) return;
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
        await mutate(() => holdSaves(async () => {
          n.name = await api.invoke("rename_note", { book: b.name, old: n.name, new: val });
          scheduleMeta(b);
        }));
      } catch (e) {
        toast("重命名失败:" + e);
      }
    }
    renderTabs();
    focusEditor();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    // 输入法正在拼字时的回车、Esc 是给输入法的
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      finish(e.key === "Enter");
    }
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("mousedown", (e) => e.stopPropagation());
}

export async function deleteNote(n) {
  const b = state.books.find((x) => x.notes.includes(n));
  if (!b || refuseInMini(n, "删除")) return;
  // 固定的页面不会被 Ctrl+W 误删
  if (n.pinned) return toast(`「${n.name}」是固定的标签,先右键取消固定才能删除`, 4000);
  syncContent(n);
  const msg = n.content.trim()
    ? `删除页面「${n.name}」?\n页面会移到回收站,需要时可以恢复(笔记本列表 → 回收站)。`
    : `删除空白页面「${n.name}」?`;
  if (!(await ask(msg, "删除", true))) return;
  try {
    await mutate(() => holdSaves(async () => {
      await api.invoke("delete_note", { book: b.name, name: n.name });
      rememberView();
      removeNote(b, n);
      if (b === book()) {
        await ensurePage(b);
        renderTabs();
        showNote();
      }
      scheduleMeta(b);
    }));
  } catch (e) {
    toast("删除失败:" + e);
  }
}

// 从笔记本里拿掉一个页面;拿掉的是当前页面就换成旁边那个
export function removeNote(b, n) {
  const idx = b.notes.indexOf(n);
  if (idx < 0) return;
  b.notes.splice(idx, 1);
  if (b.active >= b.notes.length || idx < b.active) b.active = Math.max(0, b.active - 1);
}

// 当前笔记本至少要有一个页面:空的就建一个「新页面」
export async function ensurePage(b) {
  if (!b || b.notes.length) return;
  await mutate(async () => {
    const name = await api.invoke("create_note", { book: b.name, name: "新页面" });
    b.notes.push(makeNote(name, ""));
    b.active = b.notes.length - 1;
    scheduleMeta(b);
  });
}
