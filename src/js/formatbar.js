// ---------- 标签下面的格式栏 ----------
// 一排常用的格式按钮(像语雀的工具栏),跟着光标显示当前的格式;顶栏的 Aa 按钮可以把它收起来。
// 右边的"自定义"可以选保留哪些按钮,选择记在设置的 format_bar_hidden 里
import { $prose, Plugin, commandsCtx, undo, redo, liftListItem, TextSelection, wrapInOrderedListCommand, wrapInBulletListCommand, turnIntoTextCommand, wrapInHeadingCommand } from "../vendor/milkdown.js";
import { BUTTONS, headingLevel } from "./toolbar.js";
import { openMenu, closeMenu } from "./ui.js";
import { TEXT_COLORS, BG_COLORS, setColor, colorAt } from "./colors.js";

const ICON = {
  undo: '<svg viewBox="0 0 16 16"><path d="M5.5 3.5 2.5 6.5l3 3"/><path d="M2.5 6.5h7a4 4 0 0 1 0 8H7"/></svg>',
  redo: '<svg viewBox="0 0 16 16"><path d="m10.5 3.5 3 3-3 3"/><path d="M13.5 6.5h-7a4 4 0 0 0 0 8H9"/></svg>',
  ol: '<svg viewBox="0 0 16 16"><path d="M6.5 4h7M6.5 8h7M6.5 12h7"/><path d="M2.3 2.8 3.3 2.3v3.2M2.2 9.3c.2-.6 1.9-.7 1.9.2 0 .8-1.9 1.5-1.9 2.2h2"/></svg>',
  table: '<svg viewBox="0 0 16 16"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 6.2h12M2 9.8h12M6.2 6.2v7.3M9.8 6.2v7.3"/></svg>',
  hr: '<svg viewBox="0 0 16 16"><path d="M2 8h12"/><path d="M5 4.5h6M5 11.5h6" opacity=".45"/></svg>',
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
  { sep: true },
  { id: "block", block: true, title: "正文和标题" },
  { sep: true },
  { ...byId.strong, inline: true },
  { ...byId.em, inline: true },
  { ...byId.strike, inline: true },
  { ...byId.code, inline: true },
  { ...byId.link, inline: true },
  { id: "color", label: ICON.color, title: "字体颜色", inline: true, palette: { mark: "text_color", colors: TEXT_COLORS, none: "默认颜色" } },
  { id: "bg", label: ICON.bg, title: "背景颜色", inline: true, palette: { mark: "text_bg", colors: BG_COLORS, none: "无背景" } },
  { sep: true },
  { ...byId.list, title: "列表", active: listActive("bullet_list"), run: toggleList("bullet_list", wrapInBulletListCommand) },
  { id: "ol", label: ICON.ol, title: "编号列表", active: listActive("ordered_list"), run: toggleList("ordered_list", wrapInOrderedListCommand) },
  { ...byId.task, active: (s) => listAt(s)?.item?.attrs.checked != null },
  { sep: true },
  { ...byId.quote, active: (s) => { const $f = s.selection.$from; for (let d = $f.depth; d > 0; d--) if ($f.node(d).type.name === "blockquote") return true; return false; } },
  { ...byId.codeblock, active: inCode },
  { id: "table", label: ICON.table, title: "表格", run: (c, v) => insertBlock(v, "table") },
  { id: "hr", label: ICON.hr, title: "分隔线", run: (c, v) => insertBlock(v, "hr") },
];

class FormatBar {
  constructor(view, ctx) {
    this.view = view;
    this.ctx = ctx;
    this.el = document.getElementById("format-bar");
    this.buttons = [];
    const row = document.createElement("div");
    row.className = "fb-items";
    for (const it of ITEMS) {
      if (it.sep) {
        const s = document.createElement("span");
        s.className = "sep";
        row.appendChild(s);
        continue;
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
          v.focus();
          this.update(v);
        });
      }
      // 按下鼠标时不让编辑器失去焦点,选区留着
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      row.appendChild(btn);
      this.buttons.push([btn, it]);
    }
    const hide = document.createElement("button");
    hide.className = "fb-hide";
    hide.title = "收起格式栏(顶栏的 Aa 按钮可以再打开)";
    hide.innerHTML = ICON.hide;
    hide.addEventListener("mousedown", (e) => e.preventDefault());
    hide.addEventListener("click", () => this.el.dispatchEvent(new CustomEvent("hide-format-bar", { bubbles: true })));
    const more = document.createElement("button");
    more.className = "fb-more";
    more.title = "自定义格式栏:选择显示哪些按钮";
    more.innerHTML = ICON.more;
    more.addEventListener("mousedown", (e) => e.preventDefault());
    more.addEventListener("click", () => this.customize(more));
    this.row = row;
    this.el.replaceChildren(row, more, hide);
    this.pop = document.createElement("div");
    this.pop.className = "menu fb-pop";
    this.pop.hidden = true;
    this.pop.addEventListener("mousedown", (e) => e.target.tagName !== "INPUT" && e.preventDefault());
    document.body.appendChild(this.pop);
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
    this.setHidden(hiddenItems);
    current = this;
    this.update(view);
  }

  destroy() {
    document.removeEventListener("mousedown", this.onDown, true);
    document.removeEventListener("keydown", this.onKey, true);
    this.pop.remove();
    if (current === this) current = null;
  }

  openPop(btn, children) {
    closeMenu();
    // 同一个按钮再点一下就关上
    if (!this.pop.hidden && this.popFor === btn) return this.closePop();
    this.popFor = btn;
    this.pop.replaceChildren(...children);
    this.pop.hidden = false;
    const r = btn.getBoundingClientRect();
    this.pop.style.left = Math.max(4, Math.min(r.left, window.innerWidth - this.pop.offsetWidth - 4)) + "px";
    this.pop.style.top = r.bottom + 2 + "px";
  }

  closePop() {
    this.pop.hidden = true;
    this.popFor = null;
  }

  paletteMenu(btn, { mark, colors, none }) {
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
    const grid = document.createElement("div");
    grid.className = "fb-swatches";
    for (const c of colors) {
      const b = document.createElement("button");
      b.className = "fb-swatch" + (c.value === now ? " on" : "");
      b.dataset.color = c.value;
      b.title = c.name;
      b.style.setProperty(mark === "text_color" ? "--fg" : "--sw", c.value);
      b.textContent = mark === "text_color" ? "A" : "";
      b.addEventListener("click", () => pick(c.value));
      grid.appendChild(b);
    }
    this.openPop(btn, [clear, grid]);
  }

  customize(btn) {
    const title = document.createElement("div");
    title.className = "menu-title";
    title.textContent = "格式栏显示这些按钮";
    const list = document.createElement("div");
    list.className = "fb-checks";
    for (const [, it] of this.buttons) {
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = it.id;
      box.checked = !hiddenItems.includes(it.id);
      box.addEventListener("change", () => {
        const hidden = [...list.querySelectorAll("input")].filter((b) => !b.checked).map((b) => b.value);
        this.setHidden(hidden);
        this.el.dispatchEvent(new CustomEvent("format-bar-items", { bubbles: true, detail: hidden }));
      });
      label.append(box, document.createTextNode(" " + it.title.replace(/\s*\(.*\)$/, "")));
      list.appendChild(label);
    }
    this.openPop(btn, [title, list]);
  }

  // 藏起不要的按钮;分隔线两边都没有按钮时也藏起来
  setHidden(hidden) {
    for (const [btn, it] of this.buttons) btn.hidden = hidden.includes(it.id);
    let seen = false;
    let lastSep = null;
    for (const el of this.row.children) {
      if (el.classList.contains("sep")) {
        el.hidden = !seen;
        if (seen) lastSep = el;
        seen = false;
      } else if (!el.hidden) seen = true;
    }
    if (!seen && lastSep) lastSep.hidden = true;
  }

  blockMenu(btn) {
    const v = this.view;
    const c = this.ctx.get(commandsCtx);
    const r = btn.getBoundingClientRect();
    const now = headingLevel(v.state);
    openMenu(
      BLOCKS.map((b) => ({
        id: `h${b.level}`,
        label: (b.level === now ? "✓ " : " ") + b.label,
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
        btn.querySelector(".swatch").style.fill = c || btn.dataset.last || "";
        btn.classList.toggle("on", !!c);
      } else btn.classList.toggle("on", !!it.active?.(state));
      btn.disabled = (it.inline && code) || (it.enabled ? !it.enabled(state) : false);
    }
  }
}

// 设置里记着的"不显示的按钮"
let hiddenItems = [];
let current = null;
export function setFormatBarHidden(list) {
  hiddenItems = Array.isArray(list) ? list : [];
  current?.setHidden(hiddenItems);
}

export const formatBar = $prose((ctx) => new Plugin({ view: (view) => new FormatBar(view, ctx) }));
