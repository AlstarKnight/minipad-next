// ---------- 标签下面的格式栏 ----------
// 一排常用的格式按钮(像语雀的工具栏),跟着光标显示当前的格式;顶栏的格式栏按钮可以把它收起来。
// 右边的"自定义"可以选保留哪些按钮、拖动调整顺序,记在设置的 format_bar_hidden 和 format_bar_order 里
import { $prose, Plugin, commandsCtx, undo, redo, liftListItem, TextSelection, wrapInOrderedListCommand, wrapInBulletListCommand, turnIntoTextCommand, wrapInHeadingCommand } from "../vendor/milkdown.js";
import { BUTTONS, headingLevel } from "./toolbar.js";
import { openMenu, closeMenu } from "./ui.js";
import { TEXT_COLORS, TEXT_GRADIENTS, BG_COLORS, setColor, colorAt } from "./colors.js";
import { parseAccent } from "./accent.js";
import { makeSharedColorTools } from "./sharedcolors.js";

const ICON = {
  undo: '<svg viewBox="0 0 16 16"><path d="M5.5 3.5 2.5 6.5l3 3"/><path d="M2.5 6.5h7a4 4 0 0 1 0 8H7"/></svg>',
  redo: '<svg viewBox="0 0 16 16"><path d="m10.5 3.5 3 3-3 3"/><path d="M13.5 6.5h-7a4 4 0 0 0 0 8H9"/></svg>',
  ol: '<svg viewBox="0 0 16 16"><path d="M6.5 4h7M6.5 8h7M6.5 12h7"/><path d="M2.3 2.8 3.3 2.3v3.2M2.2 9.3c.2-.6 1.9-.7 1.9.2 0 .8-1.9 1.5-1.9 2.2h2"/></svg>',
  table: '<svg viewBox="0 0 16 16"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 6.2h12M2 9.8h12M6.2 6.2v7.3M9.8 6.2v7.3"/></svg>',
  hr: '<svg viewBox="0 0 16 16"><path d="M2 8h12"/><path d="M5 4.5h6M5 11.5h6" opacity=".45"/></svg>',
  find: '<svg viewBox="0 0 16 16"><path d="M2.5 3.5h9M2.5 6.5h5.5M2.5 9.5h3"/><circle cx="10.6" cy="10.4" r="2.7"/><path d="m12.6 12.4 1.9 1.9"/></svg>',
  hide: '<svg viewBox="0 0 16 16"><path d="M4.5 9.5 8 6l3.5 3.5"/></svg>',
  more: '<svg viewBox="0 0 16 16"><path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6"/><circle cx="10" cy="4.5" r="1.5"/><circle cx="6" cy="11.5" r="1.5"/></svg>',
  color: '<svg viewBox="0 0 16 16" class="fb-color"><path d="M4.5 11 8 2.5 11.5 11M5.7 8h4.6"/><rect class="swatch" x="2.5" y="12.6" width="11" height="2.2" rx=".6"/></svg>',
  bg: '<svg viewBox="0 0 16 16" class="fb-color"><path d="m9.6 2.8 3.1 3.1-5 5H4.6V7.8z"/><path d="M8.2 4.2l3.1 3.1"/><rect class="swatch" x="2.5" y="12.6" width="11" height="2.2" rx=".6"/></svg>',
};

const BLOCKS = [
  { level: 0, label: "正文" },
  { level: 1, label: "标题 1" },
  { level: 2, label: "标题 2" },
  { level: 3, label: "标题 3" },
  { level: 4, label: "标题 4" },
];

// 光标所在的列表:{ node, pos },没有就是 null
function listAt(state) {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.name === "bullet_list" || node.type.name === "ordered_list") return { node, pos: $from.before(d), item: $from.node(d + 1) };
  }
  return null;
}
const inCode = (state) => !!state.selection.$from.parent.type.spec.code;

// 列表按钮:不在列表里就变成列表;已经是这种列表就取消;是另一种列表就换过来
function toggleList(name, wrap) {
  return (c, view) => {
    const { state, dispatch } = view;
    const list = listAt(state);
    if (!list) return c.call(wrap.key);
    if (list.node.type.name === name) return liftListItem(state.schema.nodes.list_item)(state, dispatch);
    const type = state.schema.nodes[name];
    dispatch(state.tr.setNodeMarkup(list.pos, type, { ...type.defaultAttrs, spread: list.node.attrs.spread }));
    return true;
  };
}
const listActive = (name) => (s) => {
  const list = listAt(s);
  return !!list && list.node.type.name === name && list.item?.attrs.checked == null;
};

// 表格、分隔线放在光标所在的那一段后面(这一段是空的就换掉它),后面再跟一个空段落接着写。
// 光标放进表格的第一格,或者分隔线下面的段落
function insertBlock(view, kind) {
  const { state } = view;
  const { schema } = state;
  const $from = state.selection.$from;
  // 找到最外层可以放块的位置:列表、引用里面也放在那一项的后面
  let depth = $from.depth;
  while (depth > 1 && !$from.node(depth - 1).type.contentMatch.matchType(schema.nodes.paragraph)) depth--;
  const block = $from.node(depth);
  let node;
  if (kind === "hr") node = schema.nodes.hr.create();
  else {
    const cell = (type) => schema.nodes[type].create(null, schema.nodes.paragraph.create());
    const row = (type) => schema.nodes[type === "table_header" ? "table_header_row" : "table_row"].create(null, [0, 1, 2].map(() => cell(type)));
    node = schema.nodes.table.create(null, [row("table_header"), row("table_cell"), row("table_cell")]);
  }
  const empty = block.type.name === "paragraph" && block.content.size === 0;
  const from = empty ? $from.before(depth) : $from.after(depth);
  const to = empty ? $from.after(depth) : from;
  const tr = state.tr.replaceWith(from, to, [node, schema.nodes.paragraph.create()]);
  const target = kind === "hr" ? from + node.nodeSize + 1 : from + 4;
  tr.setSelection(TextSelection.near(tr.doc.resolve(target)));
  view.dispatch(tr.scrollIntoView());
  return true;
}

const byId = Object.fromEntries(BUTTONS.filter((b) => b.id).map((b) => [b.id, b]));

const ITEMS = [
  { id: "undo", label: ICON.undo, title: "撤销 (Ctrl+Z)", enabled: (s) => undo(s), run: (c, v) => undo(v.state, v.dispatch) },
  { id: "redo", label: ICON.redo, title: "重做 (Ctrl+Y)", enabled: (s) => redo(s), run: (c, v) => redo(v.state, v.dispatch) },
  { sep: true, id: "sep1", title: "竖线分隔" },
  { id: "block", block: true, title: "正文和标题" },
  { sep: true, id: "sep2", title: "竖线分隔" },
  { ...byId.strong, inline: true },
  { ...byId.em, inline: true },
  { ...byId.strike, inline: true },
  { ...byId.code, inline: true },
  { ...byId.link, inline: true },
  { id: "color", label: ICON.color, title: "字体颜色", inline: true, palette: { mark: "text_color", colors: TEXT_COLORS, gradients: TEXT_GRADIENTS, none: "默认颜色" } },
  { id: "bg", label: ICON.bg, title: "背景颜色", inline: true, palette: { mark: "text_bg", colors: BG_COLORS, none: "无背景" } },
  { sep: true, id: "sep3", title: "竖线分隔" },
  { ...byId.list, title: "列表", active: listActive("bullet_list"), run: toggleList("bullet_list", wrapInBulletListCommand) },
  { id: "ol", label: ICON.ol, title: "编号列表", active: listActive("ordered_list"), run: toggleList("ordered_list", wrapInOrderedListCommand) },
  { ...byId.task, active: (s) => listAt(s)?.item?.attrs.checked != null },
  { sep: true, id: "sep4", title: "竖线分隔" },
  { ...byId.quote, active: (s) => { const $f = s.selection.$from; for (let d = $f.depth; d > 0; d--) if ($f.node(d).type.name === "blockquote") return true; return false; } },
  { ...byId.codeblock, active: inCode },
  { id: "table", label: ICON.table, title: "表格", run: (c, v) => insertBlock(v, "table") },
  { id: "hr", label: ICON.hr, title: "分隔线", run: (c, v) => insertBlock(v, "hr") },
  { sep: true, id: "sep5", title: "竖线分隔" },
  // 打开查找栏(main.js 接着处理),焦点交给查找框
  { id: "find", label: ICON.find, title: "查找和替换(这一页)", keepFocus: true, run: (c, v) => v.dom.dispatchEvent(new CustomEvent("open-find", { bubbles: true })) },
];

// 默认的顺序
const DEFAULT_ORDER = ITEMS.map((it) => it.id);

// 按设置里记着的顺序排:不认识的去掉,新加的按钮(设置里还没有)按默认位置插回去
function orderedItems(saved) {
  const known = new Map(ITEMS.map((it) => [it.id, it]));
  const ids = (Array.isArray(saved) ? saved : []).filter((id, i, a) => known.has(id) && a.indexOf(id) === i);
  for (const [i, id] of DEFAULT_ORDER.entries()) {
    if (ids.includes(id)) continue;
    const before = DEFAULT_ORDER.slice(0, i).reverse().find((d) => ids.includes(d));
    ids.splice(before ? ids.indexOf(before) + 1 : 0, 0, id);
  }
  return ids.map((id) => known.get(id));
}

// 选中文字时的悬浮工具栏默认有的按钮(设置的"编辑 → 悬浮工具栏"里可以改)
export const DEFAULT_SEL_ITEMS = ["block", "strong", "em", "strike", "code", "link", "sep3", "color", "bg"];

// 勾选要显示的按钮、拖动调整顺序的列表(格式栏的"自定义"和设置里的悬浮工具栏共用)。
// 改了就调用 onSave(全部按钮按现在的顺序, 不显示的按钮)
export function itemChecklist(order, hidden, onSave) {
  const list = document.createElement("div");
  list.className = "fb-checks";
  let dragging = null;
  const save = () => {
    const ids = [...list.children].map((row) => row.dataset.id);
    const off = [...list.querySelectorAll("input")].filter((b) => !b.checked).map((b) => b.value);
    onSave(ids, off);
  };
  for (const it of orderedItems(order)) {
    const row = document.createElement("label");
    row.className = "fb-check" + (it.sep ? " fb-check-sep" : "");
    row.dataset.id = it.id;
    row.draggable = true;
    const grip = document.createElement("span");
    grip.className = "fb-grip";
    grip.innerHTML = '<svg viewBox="0 0 16 16"><path d="M6 3.5h.01M10 3.5h.01M6 8h.01M10 8h.01M6 12.5h.01M10 12.5h.01"/></svg>';
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = it.id;
    box.checked = !hidden.includes(it.id);
    box.addEventListener("change", save);
    const icon = document.createElement("span");
    icon.className = "fb-check-icon";
    icon.innerHTML = it.sep ? '<span class="sep"></span>' : it.block ? "H" : it.label;
    const name = document.createElement("span");
    name.textContent = it.title.replace(/\s*\(.*\)$/, "");
    row.append(grip, box, icon, name);
    // 拖到别的行上:落在那一行的上半部分就放在它前面,下半部分放在后面
    row.addEventListener("dragstart", (e) => {
      dragging = row;
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", it.id);
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      for (const r of list.children) r.classList.remove("drop-before", "drop-after");
      dragging = null;
    });
    row.addEventListener("dragover", (e) => {
      if (!dragging || dragging === row) return;
      e.preventDefault();
      const r = row.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      row.classList.toggle("drop-after", after);
      row.classList.toggle("drop-before", !after);
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after"));
    row.addEventListener("drop", (e) => {
      const moved = dragging;
      if (!moved || moved === row) return;
      e.preventDefault();
      const after = row.classList.contains("drop-after");
      row.classList.remove("drop-before", "drop-after");
      row.after(moved);
      if (!after) row.before(moved);
      save();
    });
    list.appendChild(row);
  }
  return list;
}

// 格式栏和悬浮工具栏共用:做按钮、颜色和标题的弹出菜单、跟着光标亮起按钮
class Bar {
  constructor(view, ctx) {
    this.view = view;
    this.ctx = ctx;
    this.buttons = [];
    this.els = new Map();
    for (const it of ITEMS) this.els.set(it.id, this.makeItem(it));
    // 弹出菜单第一次用到时才放进页面
    this.pop = document.createElement("div");
    this.pop.className = "menu fb-pop";
    this.pop.hidden = true;
    // 输入框和自定义面板里可以拖动的行除外
    this.pop.addEventListener("mousedown", (e) => e.target.tagName !== "INPUT" && !e.target.closest(".fb-check") && e.preventDefault());
    this.onDown = (e) => !this.pop.hidden && !this.pop.contains(e.target) && e.target.closest?.("button") !== this.popFor && this.closePop();
    this.onKey = (e) => {
      if (e.key !== "Escape" || this.pop.hidden) return;
      e.preventDefault();
      e.stopPropagation();
      this.closePop();
      this.view.focus();
    };
    document.addEventListener("mousedown", this.onDown, true);
    document.addEventListener("keydown", this.onKey, true);
  }

  makeItem(it) {
    if (it.sep) {
      const s = document.createElement("span");
      s.className = "sep";
      s.dataset.cmd = it.id;
      return s;
    }
    const btn = document.createElement("button");
    btn.dataset.cmd = it.id;
    btn.title = it.title;
    if (it.block) {
      btn.className = "fb-block";
      btn.innerHTML = '<span>正文</span><svg viewBox="0 0 16 16"><path d="M4.5 6.5 8 10l3.5-3.5"/></svg>';
      btn.addEventListener("click", () => this.blockMenu(btn));
    } else if (it.palette) {
      btn.innerHTML = it.label;
      btn.addEventListener("click", () => this.paletteMenu(btn, it.palette));
    } else {
      btn.innerHTML = it.label;
      btn.addEventListener("click", async () => {
        const v = this.view;
        await it.run(this.ctx.get(commandsCtx), v);
        if (it.keepFocus) return;
        v.focus();
        this.update(v);
      });
    }
    // 按下鼠标时不让编辑器失去焦点,选区留着
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    this.buttons.push([btn, it]);
    return btn;
  }

  destroy() {
    document.removeEventListener("mousedown", this.onDown, true);
    document.removeEventListener("keydown", this.onKey, true);
    this.pop.remove();
  }

  openPop(btn, children) {
    closeMenu();
    // 同一个按钮再点一下就关上
    if (!this.pop.hidden && this.popFor === btn) return this.closePop();
    this.popFor = btn;
    if (!this.pop.isConnected) document.body.appendChild(this.pop);
    this.pop.replaceChildren(...children);
    this.pop.hidden = false;
    const r = btn.getBoundingClientRect();
    this.pop.style.left = Math.max(4, Math.min(r.left, window.innerWidth - this.pop.offsetWidth - 4)) + "px";
    const below = r.bottom + 2;
    this.pop.style.top = (below + this.pop.offsetHeight > window.innerHeight - 4 ? Math.max(4, r.top - this.pop.offsetHeight - 2) : below) + "px";
  }

  closePop() {
    this.pop.hidden = true;
    this.popFor = null;
  }

  paletteMenu(btn, { mark, colors, gradients, none }) {
    const now = colorAt(this.view.state, mark);
    const pick = (value) => {
      this.closePop();
      setColor(this.view, mark, value);
      if (value) btn.dataset.last = value;
    };
    const clear = document.createElement("button");
    clear.className = "fb-none";
    clear.textContent = none;
    clear.addEventListener("click", () => pick(""));
    const grid = (list, cls) => {
      const g = document.createElement("div");
      g.className = "fb-swatches " + cls;
      for (const c of list) {
        const b = document.createElement("button");
        b.className = "fb-swatch" + (c.value === now ? " on" : "");
        b.dataset.color = c.value;
        b.title = c.name;
        b.style.setProperty(mark === "text_color" ? "--fg" : "--sw", c.value);
        b.textContent = mark === "text_color" ? "A" : "";
        b.addEventListener("click", () => pick(c.value));
        g.appendChild(b);
      }
      return g;
    };
    const parts = [clear, grid(colors, "")];
    if (gradients) {
      const title = document.createElement("div");
      title.className = "menu-title";
      title.textContent = "渐变色";
      parts.push(title, grid(gradients, "fb-gradients"));
    }
    const shared = makeSharedColorTools({
      getValue: () => colorAt(this.view.state, mark) || btn.dataset.last || "#d9822b",
      onApply: (value) => pick(value),
    });
    parts.push(shared.root);
    this.openPop(btn, parts);
  }

  blockMenu(btn) {
    const v = this.view;
    const c = this.ctx.get(commandsCtx);
    const r = btn.getBoundingClientRect();
    const now = headingLevel(v.state);
    openMenu(
      BLOCKS.map((b) => ({
        id: `h${b.level}`,
        label: (b.level === now ? "✓ " : " ") + b.label,
        disabled: inCode(v.state),
        act: () => {
          c.call(b.level ? wrapInHeadingCommand.key : turnIntoTextCommand.key, b.level || undefined);
          v.focus();
        },
      })),
      r.left,
      r.bottom + 2
    );
  }

  // 悬浮工具栏:只放要的按钮;分隔线两边都没有按钮时也不放
  arrange(row, items) {
    const els = [];
    for (const it of items) {
      const el = this.els.get(it.id);
      if (it.sep && (!els.length || els.at(-1).classList.contains("sep"))) continue;
      els.push(el);
    }
    while (els.length && els.at(-1).classList.contains("sep")) els.pop();
    row.replaceChildren(...els);
  }

  update(view) {
    this.view = view;
    const { state } = view;
    const code = inCode(state);
    for (const [btn, it] of this.buttons) {
      if (it.block) {
        const level = headingLevel(state);
        btn.firstChild.textContent = code ? "代码" : BLOCKS.find((b) => b.level === level)?.label || `标题 ${level}`;
        btn.disabled = code;
        continue;
      }
      if (it.palette) {
        const c = colorAt(state, it.palette.mark);
        const shown = c || btn.dataset.last || "";
        btn.querySelector(".swatch").style.fill = parseAccent(shown)?.from || shown;
        btn.classList.toggle("on", !!c);
      } else btn.classList.toggle("on", !!it.active?.(state));
      btn.disabled = (it.inline && code) || (it.enabled ? !it.enabled(state) : false);
    }
  }
}

class FormatBar extends Bar {
  constructor(view, ctx) {
    super(view, ctx);
    this.el = document.getElementById("format-bar");
    const row = document.createElement("div");
    row.className = "fb-items";
    const hide = document.createElement("button");
    hide.className = "fb-hide";
    hide.title = "收起格式栏(顶栏的格式栏按钮可以再打开)";
    hide.innerHTML = ICON.hide;
    hide.addEventListener("mousedown", (e) => e.preventDefault());
    hide.addEventListener("click", () => this.el.dispatchEvent(new CustomEvent("hide-format-bar", { bubbles: true })));
    const more = document.createElement("button");
    more.className = "fb-more";
    more.title = "自定义格式栏:选择显示哪些按钮,拖动调整顺序";
    more.innerHTML = ICON.more;
    more.addEventListener("mousedown", (e) => e.preventDefault());
    more.addEventListener("click", () => this.customize(more));
    this.row = row;
    this.el.replaceChildren(row, more, hide);
    this.layout();
    current = this;
    this.update(view);
  }

  destroy() {
    super.destroy();
    if (current === this) current = null;
  }

  customize(btn) {
    const title = document.createElement("div");
    title.className = "menu-title";
    title.textContent = "勾选要显示的按钮,拖动调整顺序";
    const save = (order, hidden) => {
      setFormatBarItems(hidden, order);
      this.el.dispatchEvent(new CustomEvent("format-bar-items", { bubbles: true, detail: { format_bar_hidden: hidden, format_bar_order: order } }));
    };
    const box = document.createElement("div");
    box.appendChild(itemChecklist(itemOrder, hiddenItems, save));
    const reset = document.createElement("button");
    reset.className = "fb-reset";
    reset.textContent = "恢复默认";
    reset.addEventListener("click", () => {
      save(DEFAULT_ORDER, []);
      box.replaceChildren(itemChecklist(DEFAULT_ORDER, [], save));
    });
    this.openPop(btn, [title, box, reset]);
  }

  // 按顺序摆好全部按钮,再藏起不要的;分隔线两边都没有按钮时也藏起来
  layout() {
    this.row.replaceChildren(...orderedItems(itemOrder).map((it) => this.els.get(it.id)));
    for (const [btn, it] of this.buttons) btn.hidden = hiddenItems.includes(it.id);
    let seen = false;
    let lastSep = null;
    for (const el of this.row.children) {
      if (el.classList.contains("sep")) {
        el.hidden = !seen || hiddenItems.includes(el.dataset.cmd);
        if (el.hidden) continue;
        if (seen) lastSep = el;
        seen = false;
      } else if (!el.hidden) seen = true;
    }
    if (!seen && lastSep) lastSep.hidden = true;
  }
}

// ---- 选中文字时的悬浮工具栏 ----
// 选中一段文字,上方(或下方,设置里选)出现一排常用的格式按钮,按钮和顺序在设置里挑。
// 什么时候出现也在设置里选:总是 / 只在格式栏收起时 / 不出现
class SelectionBar extends Bar {
  constructor(view, ctx) {
    super(view, ctx);
    this.el = document.createElement("div");
    this.el.id = "toolbar";
    this.el.hidden = true;
    this.el.setAttribute("role", "toolbar");
    this.el.setAttribute("aria-label", "常用格式");
    document.body.appendChild(this.el);
    this.layout();
    // 颜色菜单开着时编辑器没有焦点也留着
    this.onBlur = () => setTimeout(() => !this.view.hasFocus() && this.pop.hidden && (this.el.hidden = true), 0);
    view.dom.addEventListener("blur", this.onBlur);
    selBar = this;
    this.update(view);
  }

  destroy() {
    super.destroy();
    this.view.dom.removeEventListener("blur", this.onBlur);
    this.el.remove();
    if (selBar === this) selBar = null;
  }

  layout() {
    const items = selItems.map((id) => ITEMS.find((it) => it.id === id)).filter(Boolean);
    this.arrange(this.el, items);
  }

  closePop() {
    super.closePop();
    if (this.view && !this.view.hasFocus()) this.el.hidden = true;
  }

  update(view) {
    this.view = view;
    const { state } = view;
    const sel = state.selection;
    const wanted = selMode === "always" || (selMode === "nobar" && document.getElementById("format-bar")?.hidden !== false);
    const show =
      wanted && this.el.childElementCount > 0 && !sel.empty && sel.$from.parent.inlineContent && !sel.$from.parent.type.spec.code && (view.hasFocus() || !this.pop.hidden) && view.editable;
    if (!show) {
      this.el.hidden = true;
      if (!this.pop.hidden && sel.empty) this.closePop();
      return;
    }
    super.update(view);
    this.el.hidden = false;
    const start = view.coordsAtPos(sel.from);
    const end = view.coordsAtPos(sel.to);
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const left = Math.max(6, Math.min(window.innerWidth - w - 6, (start.left + end.left) / 2 - w / 2));
    // 默认放在选区上面,上面放不下(会挡住顶栏和格式栏)就放下面;设置成下面时反过来
    const top0 = view.dom.parentElement.getBoundingClientRect().top + 4;
    const above = start.top - h - 8;
    const below = end.bottom + 8;
    let top = selPos === "below" ? below : above;
    if (selPos === "below" ? top + h > window.innerHeight - 4 : top < top0) top = selPos === "below" ? above : below;
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }
}

// 设置里记着的"不显示的按钮"和按钮的顺序
let hiddenItems = [];
let itemOrder = [];
let current = null;
export function setFormatBarItems(hidden, order) {
  hiddenItems = Array.isArray(hidden) ? hidden : [];
  itemOrder = Array.isArray(order) ? order : [];
  current?.layout();
}

// 悬浮工具栏:什么时候出现(always / nobar 只在格式栏收起时 / off)、按钮、在选区上面还是下面
let selMode = "always";
let selItems = DEFAULT_SEL_ITEMS;
let selPos = "above";
let selBar = null;
export function setSelectionBar(s) {
  selMode = ["always", "nobar", "off"].includes(s.sel_bar) ? s.sel_bar : "always";
  selItems = Array.isArray(s.sel_bar_items) ? s.sel_bar_items : DEFAULT_SEL_ITEMS;
  selPos = s.sel_bar_pos === "below" ? "below" : "above";
  if (selBar) {
    selBar.layout();
    selBar.update(selBar.view);
  }
}

// 设置里列出全部按钮用
export const ALL_ITEMS = ITEMS;
export { orderedItems };

export const formatBar = $prose((ctx) => new Plugin({ view: (view) => new FormatBar(view, ctx) }));
export const selectionBar = $prose((ctx) => new Plugin({ view: (view) => new SelectionBar(view, ctx) }));
