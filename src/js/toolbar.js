// ---------- 选中文字时的小工具栏 ----------
// 选中一段文字,上方出现一排按钮:粗体、斜体、删除线、行内代码、链接、标题、列表、任务、引用、代码块。
// 只在格式栏收起来的时候出现
import {
  $prose,
  Plugin,
  commandsCtx,
  toggleStrongCommand,
  toggleEmphasisCommand,
  toggleStrikethroughCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  wrapInHeadingCommand,
  turnIntoTextCommand,
  wrapInBulletListCommand,
  wrapInBlockquoteCommand,
  createCodeBlockCommand,
} from "../vendor/milkdown.js";

// 点"链接"时问链接地址;由 main.js 设置(用程序自己的输入框)
let askLink = async () => null;
export function setLinkPrompt(fn) {
  askLink = fn;
}
let toggleTask = () => false;
export function setTaskCommand(fn) {
  toggleTask = fn;
}

export const markActive = (state, name) => {
  const type = state.schema.marks[name];
  const { from, to } = state.selection;
  return !!type && state.doc.rangeHasMark(from, to, type);
};
export const headingLevel = (state) => {
  const p = state.selection.$from.parent;
  return p.type.name === "heading" ? p.attrs.level : 0;
};

export const BUTTONS = [
  { id: "strong", label: "<b>B</b>", title: "粗体 (Ctrl+B)", active: (s) => markActive(s, "strong"), run: (c) => c.call(toggleStrongCommand.key) },
  { id: "em", label: "<i>I</i>", title: "斜体 (Ctrl+I)", active: (s) => markActive(s, "emphasis"), run: (c) => c.call(toggleEmphasisCommand.key) },
  { id: "strike", label: "<s>S</s>", title: "删除线", active: (s) => markActive(s, "strike_through"), run: (c) => c.call(toggleStrikethroughCommand.key) },
  { id: "code", label: "&lt;/&gt;", title: "行内代码 (Ctrl+E)", active: (s) => markActive(s, "inlineCode"), run: (c) => c.call(toggleInlineCodeCommand.key) },
  {
    id: "link",
    label: '<svg viewBox="0 0 16 16"><path d="M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.8.8"/><path d="M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.8-.8"/></svg>',
    title: "链接",
    active: (s) => markActive(s, "link"),
    run: async (c, view) => {
      if (markActive(view.state, "link")) return c.call(toggleLinkCommand.key);
      const href = await askLink();
      view.focus();
      if (href) c.call(toggleLinkCommand.key, { href });
    },
  },
  { sep: true },
  { id: "h1", label: "H1", title: "大标题", active: (s) => headingLevel(s) === 1, run: (c, v) => c.call(headingLevel(v.state) === 1 ? turnIntoTextCommand.key : wrapInHeadingCommand.key, 1) },
  { id: "h2", label: "H2", title: "小标题", active: (s) => headingLevel(s) === 2, run: (c, v) => c.call(headingLevel(v.state) === 2 ? turnIntoTextCommand.key : wrapInHeadingCommand.key, 2) },
  { sep: true },
  {
    id: "list",
    label: '<svg viewBox="0 0 16 16"><path d="M6 4h7.5M6 8h7.5M6 12h7.5"/><circle cx="3" cy="4" r=".6"/><circle cx="3" cy="8" r=".6"/><circle cx="3" cy="12" r=".6"/></svg>',
    title: "列表",
    run: (c) => c.call(wrapInBulletListCommand.key),
  },
  {
    id: "task",
    label: '<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5 8.2 7 10.2 11 6"/></svg>',
    title: "任务 (Ctrl+Enter)",
    run: (c, v) => toggleTask(v.state, v.dispatch),
  },
  {
    id: "quote",
    label: '<svg viewBox="0 0 16 16"><path d="M3 4v8M6.5 5.5h7M6.5 8h7M6.5 10.5h5"/></svg>',
    title: "引用",
    run: (c) => c.call(wrapInBlockquoteCommand.key),
  },
  { id: "codeblock", label: "{ }", title: "代码块", run: (c) => c.call(createCodeBlockCommand.key) },
];

class Toolbar {
  constructor(view, ctx) {
    this.view = view;
    this.ctx = ctx;
    this.el = document.createElement("div");
    this.el.id = "toolbar";
    this.el.hidden = true;
    this.el.setAttribute("role", "toolbar");
    this.buttons = [];
    for (const b of BUTTONS) {
      if (b.sep) {
        const s = document.createElement("span");
        s.className = "sep";
        this.el.appendChild(s);
        continue;
      }
      const btn = document.createElement("button");
      btn.dataset.cmd = b.id;
      btn.title = b.title;
      btn.innerHTML = b.label;
      // 按下鼠标时不让编辑器失去焦点,选区留着
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", async () => {
        await b.run(this.ctx.get(commandsCtx), this.view);
        this.update(this.view);
      });
      this.el.appendChild(btn);
      this.buttons.push([btn, b]);
    }
    document.body.appendChild(this.el);
    this.onBlur = () => setTimeout(() => !this.view.hasFocus() && (this.el.hidden = true), 0);
    view.dom.addEventListener("blur", this.onBlur);
  }

  update(view) {
    this.view = view;
    const { state } = view;
    const sel = state.selection;
    // 格式栏开着时用不着它
    const show = document.getElementById("format-bar")?.hidden !== false &&
      !sel.empty && sel.$from.parent.inlineContent && !sel.$from.parent.type.spec.code && view.hasFocus() && view.editable;
    if (!show) {
      this.el.hidden = true;
      return;
    }
    for (const [btn, b] of this.buttons) btn.classList.toggle("on", !!b.active?.(state));
    this.el.hidden = false;
    const start = view.coordsAtPos(sel.from);
    const end = view.coordsAtPos(sel.to);
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const left = Math.max(6, Math.min(window.innerWidth - w - 6, (start.left + end.left) / 2 - w / 2));
    // 放在选区上面,上面放不下(会挡住顶栏和格式栏)就放下面
    let top = start.top - h - 8;
    if (top < view.dom.parentElement.getBoundingClientRect().top + 4) top = end.bottom + 8;
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }

  destroy() {
    this.view.dom.removeEventListener("blur", this.onBlur);
    this.el.remove();
  }
}

export const toolbar = $prose((ctx) => new Plugin({ view: (view) => new Toolbar(view, ctx) }));
