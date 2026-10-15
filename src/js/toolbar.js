// ---------- 格式按钮 ----------
// 粗体、斜体、删除线、行内代码、链接、标题、列表、任务、引用、代码块这些按钮的做法,
// 格式栏和选中文字时的悬浮工具栏都用(见 formatbar.js)
import {
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
  TextSelection,
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

// 将代码块的实际换行转换成段内软换行，避免往返保存时丢失空行。
export function codeLines(schema, text) {
  const parts = [];
  text.replace(/\n+$/, "").split("\n").forEach((line, i) => {
    if (i) parts.push(schema.nodes.hardbreak.create({ isInline: true }));
    if (line) parts.push(schema.text(line));
  });
  return parts;
}

export function codeToText(state, dispatch) {
  const { $from } = state.selection;
  if (!$from.parent.type.spec.code) return false;
  if (dispatch) {
    const start = $from.before();
    const paragraph = state.schema.nodes.paragraph.create(null, codeLines(state.schema, $from.parent.textContent));
    const tr = state.tr.replaceWith(start, start + $from.parent.nodeSize, paragraph);
    const at = start + 1 + Math.min($from.parentOffset, paragraph.content.size);
    dispatch(tr.setSelection(TextSelection.create(tr.doc, at)).scrollIntoView());
  }
  return true;
}

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
  { id: "codeblock", label: "{ }", title: "代码块", run: (c, v) => codeToText(v.state, v.dispatch) || c.call(createCodeBlockCommand.key) },
];
