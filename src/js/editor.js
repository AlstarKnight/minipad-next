// ---------- 编辑区:CodeMirror 6 ----------
// 每个页面有自己的编辑状态(内容、光标、撤销记录):换页时存进页面对象(n.state),换回来再放回编辑器,
// 所以换过页以后 Ctrl+Z 还能撤销之前打的字。编辑器里显示的页面的最新状态在 view.state 里,不在 n.state 里。
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  Decoration,
  EditorView,
  ViewPlugin,
  drawSelection,
  keymap,
  lineNumbers,
  placeholder,
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
  isolateHistory,
  redo,
  HighlightStyle,
  indentUnit,
  syntaxHighlighting,
  syntaxTree,
  markdown,
  markdownLanguage,
  tags as t,
} from "../vendor/codemirror.js";
import { $ } from "./dom.js";

let view = null;
// 编辑器里现在放着的页面,阅读模式时是 null
let shown = null;
// 用户改了内容时调用,参数是被改的页面
let onChange = () => {};

// 从磁盘读来的新内容:不算用户的修改,不触发保存。撤销记录里单独算一步,不和前后打的字连在一起
const external = Annotation.define();
const fromDisk = [external.of(true), isolateHistory.of("full")];

// 行号可以在设置里开关。每个页面的状态是分开存的,换页时再按现在的设置调整
const gutter = new Compartment();
const withLineNumbers = lineNumbers();
const noLineNumbers = [];
let gutterNow = noLineNumbers;

// ---------- Markdown 上色 ----------
// 只给 class,颜色和字号写在 style.css 里,跟着浅色 / 深色主题变
const mdStyle = HighlightStyle.define([
  { tag: t.heading1, class: "md-h1" },
  { tag: t.heading2, class: "md-h2" },
  { tag: t.heading3, class: "md-h3" },
  { tag: t.heading4, class: "md-h4" },
  { tag: t.heading5, class: "md-h5" },
  { tag: t.heading6, class: "md-h6" },
  { tag: t.strong, class: "md-strong" },
  { tag: t.emphasis, class: "md-em" },
  { tag: t.strikethrough, class: "md-strike" },
  { tag: t.monospace, class: "md-code" },
  { tag: t.link, class: "md-link" },
  { tag: t.url, class: "md-url" },
  { tag: t.quote, class: "md-quote" },
  // # ** - > ``` 这些标记,和代码块后面的语言名
  { tag: [t.processingInstruction, t.contentSeparator, t.labelName], class: "md-mark" },
  // 任务列表的 [ ] / [x]
  { tag: t.atom, class: "md-task" },
  { tag: t.comment, class: "md-comment" },
]);

// 代码块整行加背景:第一行和最后一行另外加 class,用来画圆角
const codeLine = {
  mid: Decoration.line({ class: "cm-codeblock" }),
  first: Decoration.line({ class: "cm-codeblock cm-codeblock-first" }),
  last: Decoration.line({ class: "cm-codeblock cm-codeblock-last" }),
  only: Decoration.line({ class: "cm-codeblock cm-codeblock-first cm-codeblock-last" }),
};

function codeBlockLines(v) {
  const { doc } = v.state;
  const tree = syntaxTree(v.state);
  const lines = new Map();
  for (const { from, to } of v.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        if (node.name !== "FencedCode" && node.name !== "CodeBlock") return;
        const first = doc.lineAt(node.from).number;
        const last = doc.lineAt(node.to).number;
        const start = Math.max(first, doc.lineAt(from).number);
        const end = Math.min(last, doc.lineAt(to).number);
        for (let i = start; i <= end; i++) {
          const kind = first === last ? "only" : i === first ? "first" : i === last ? "last" : "mid";
          lines.set(doc.line(i).from, codeLine[kind]);
        }
        return false;
      },
    });
  }
  return Decoration.set([...lines].map(([pos, deco]) => deco.range(pos)), true);
}

const codeBlocks = ViewPlugin.fromClass(
  class {
    constructor(v) {
      this.decorations = codeBlockLines(v);
    }
    update(u) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = codeBlockLines(u.view);
      }
    }
  },
  { decorations: (p) => p.decorations },
);

// ---------- 列表和任务 ----------
// 列表项:前面的缩进、- * + 或 1. 1)、空格,后面可能跟着 [ ] / [x]
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\](?:\s|$))?/;

// 光标所在的行(选中多行时是每一行),每行只算一次;选区刚好停在某行行首时不算那一行
function selectedLines(state) {
  const lines = [];
  let last = -1;
  for (const r of state.selection.ranges) {
    for (let pos = r.from; pos <= r.to; ) {
      const line = state.doc.lineAt(pos);
      if (line.number > last && (r.empty || r.to > line.from)) {
        lines.push(line);
        last = line.number;
      }
      pos = line.to + 1;
    }
  }
  return lines;
}

// Tab:选中了多行,或者在列表项里,就整行缩进;否则和以前一样在光标处插入一个制表符
function tab(v) {
  const lines = selectedLines(v.state);
  if (lines.length > 1 || lines.every((l) => LIST_ITEM.test(l.text))) indentMore(v);
  else v.dispatch(v.state.replaceSelection("\t"), { scrollIntoView: true, userEvent: "input" });
  // 总是返回 true,不让 Tab 把焦点移出编辑区
  return true;
}

function untab(v) {
  indentLess(v);
  return true;
}

// Ctrl+Enter:勾选 / 取消勾选任务;列表项前面加上 [ ],普通的行变成任务
export function toggleTask(v) {
  const { state } = v;
  const changes = [];
  for (const line of selectedLines(state)) {
    const m = LIST_ITEM.exec(line.text);
    if (m && m[4]) {
      // [ ] 和 [x] 中间那个字符
      const at = line.from + m[1].length + m[2].length + m[3].length + 1;
      changes.push({ from: at, to: at + 1, insert: m[4][1] === " " ? "x" : " " });
    } else if (m) {
      changes.push({ from: line.from + m[0].length, insert: "[ ] " });
    } else {
      changes.push({ from: line.from + /^\s*/.exec(line.text)[0].length, insert: "- [ ] " });
    }
  }
  const set = state.changes(changes);
  // 光标正好在插入的位置时放到插入的文字后面
  v.dispatch({ changes: set, selection: state.selection.map(set, 1), scrollIntoView: true, userEvent: "input" });
  return true;
}

const editingKeys = Prec.high(
  keymap.of([
    { key: "Tab", run: tab, shift: untab },
    { key: "Mod-Enter", run: toggleTask },
    // 重做:Ctrl+Y(CodeMirror 自带)和 Ctrl+Shift+Z 都可以,和原来的文本框一样
    { key: "Shift-Mod-z", run: redo, preventDefault: true },
  ]),
);

// Esc 留给窗口(隐藏窗口、关弹层),不用来收起选区;
// Ctrl+M 不切换"Tab 移动焦点"的模式,免得误按以后 Tab 不能缩进
const baseKeys = defaultKeymap.filter((k) => k.key !== "Escape" && k.key !== "Ctrl-m");

// ---------- 编辑器 ----------
const extensions = [
  history(),
  drawSelection(),
  EditorView.lineWrapping,
  EditorState.tabSize.of(4),
  indentUnit.of("\t"),
  placeholder("写点什么……"),
  EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off", "aria-label": "页面内容" }),
  // 回车续上列表、退格删掉列表标记由 markdown() 自带的按键处理
  markdown({ base: markdownLanguage, completeHTMLTags: false }),
  syntaxHighlighting(mdStyle),
  codeBlocks,
  editingKeys,
  keymap.of([...baseKeys, ...historyKeymap]),
  EditorView.updateListener.of((u) => {
    if (!u.docChanged || !shown) return;
    shown.content = u.state.doc.toString();
    if (u.transactions.some((tr) => tr.docChanged && !tr.annotation(external))) onChange(shown);
  }),
];

function makeState(text) {
  return EditorState.create({ doc: text, extensions: [extensions, gutter.of(gutterNow)] });
}

// 把 a 改成 b 的最小改动:只换掉中间不一样的部分,光标和滚动位置不会乱跳
function diff(a, b) {
  const min = Math.min(a.length, b.length);
  let s = 0;
  while (s < min && a.charCodeAt(s) === b.charCodeAt(s)) s++;
  let e = 0;
  while (e < min - s && a.charCodeAt(a.length - 1 - e) === b.charCodeAt(b.length - 1 - e)) e++;
  return { from: s, to: a.length - e, insert: b.slice(s, b.length - e) };
}

export function createEditor(opts) {
  onChange = opts.onChange;
  view = new EditorView({ state: makeState(""), parent: $("#editor") });
}

export function editorView() {
  return view;
}

// 把编辑器里的页面的状态和滚动位置存回页面对象
function keep() {
  if (!shown) return;
  shown.state = view.state;
  shown.snap = view.scrollSnapshot();
}

// 换页、换到编辑模式时调用:放上 n 的状态,内容在别处变过就先换成新内容
export function showInEditor(n) {
  if (shown === n) {
    setEditorText(n);
    return;
  }
  keep();
  shown = n;
  let st = n.state || makeState(n.content);
  let snap = n.snap;
  const text = st.doc.toString();
  if (text !== n.content) {
    st = st.update({ changes: diff(text, n.content), annotations: fromDisk }).state;
    // 内容变了,存下的滚动位置不一定还对得上
    snap = null;
  }
  view.setState(st);
  if (gutter.get(st) !== gutterNow) view.dispatch({ effects: gutter.reconfigure(gutterNow) });
  view.dispatch({ effects: snap || EditorView.scrollIntoView(st.selection.main.head) });
}

// 换到阅读模式、或者要记下当前位置时调用
export function leaveEditor(hide = false) {
  keep();
  if (hide) shown = null;
}

// 编辑器里的页面的内容在别处变了(n.content 已经是新内容):换上新内容,可以撤销回去
export function setEditorText(n) {
  if (n !== shown) return;
  const text = view.state.doc.toString();
  if (text !== n.content) view.dispatch({ changes: diff(text, n.content), annotations: fromDisk });
}

export function focusEditorView() {
  view.focus();
}

export function editorSelectionText() {
  const { from, to } = view.state.selection.main;
  return view.state.sliceDoc(from, to);
}

// 选中 from 到 to,并滚到窗口中间
export function selectInEditor(from, to) {
  const len = view.state.doc.length;
  view.dispatch({
    selection: EditorSelection.single(Math.min(from, len), Math.min(to, len)),
    effects: EditorView.scrollIntoView(Math.min(from, len), { y: "center" }),
  });
  view.focus();
}

// 在光标处插入文字(替换选中的部分)
export function insertText(text) {
  view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true, userEvent: "input" });
  view.focus();
}

export function applyEditorSettings(s) {
  gutterNow = s.line_numbers ? withLineNumbers : [];
  if (view && gutter.get(view.state) !== gutterNow) view.dispatch({ effects: gutter.reconfigure(gutterNow) });
  // 字号改了以后让编辑器重新量一下行高
  view?.requestMeasure();
}
