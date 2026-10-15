// ---------- Markdown 折叠块 ----------
// 使用普通引用块保存：> [!fold]- 标题（收起），> [!fold]+ 标题（展开）。
// 只有首段匹配标记的引用块才显示折叠 UI；其他 Markdown 阅读器仍能看到全部内容。
import { $prose, Plugin, PluginKey, Decoration, DecorationSet, NodeSelection } from "../vendor/milkdown.js";
import { askText } from "./ui.js";

const RE = /^\[!fold\]([+-])(?: (.*))?$/;

export function foldInfo(node) {
  if (node?.type.name !== "blockquote" || node.firstChild?.type.name !== "paragraph") return null;
  const match = RE.exec(node.firstChild.textContent);
  return match ? { closed: match[1] === "-", title: match[2] || "折叠块" } : null;
}

export function newFold(schema, source = null) {
  const heading = schema.nodes.paragraph.create(null, schema.text("[!fold]+ 折叠块"));
  if (!source) return schema.nodes.blockquote.create(null, [heading, schema.nodes.paragraph.create()]);
  // 引用转折叠保留全部子节点；普通块整体放入折叠块，不扁平化列表/表格。
  const content = source.type.name === "blockquote" && !foldInfo(source)
    ? [...source.content] : [source];
  return schema.nodes.blockquote.create(null, [heading, ...content]);
}

export function unfoldQuote(schema, node) {
  return schema.nodes.blockquote.create(null, [...node.content].slice(1).length
    ? [...node.content].slice(1) : [schema.nodes.paragraph.create()]);
}

export function setFold(view, pos, options = {}) {
  const { state } = view;
  const node = state.doc.nodeAt(pos);
  const info = foldInfo(node);
  if (!info || !view.editable) return false;
  const title = (options.title ?? info.title).replace(/[\r\n]/g, " ").trim() || "折叠块";
  const closed = options.closed ?? info.closed;
  const first = node.firstChild;
  const from = pos + 2;
  const tr = state.tr.insertText("[!fold]" + (closed ? "-" : "+") + " " + title,
    from, from + first.content.size);
  // 收起时把光标留在外层节点上，避免落在被 CSS 隐藏的正文里。
  if (closed) tr.setSelection(NodeSelection.create(tr.doc, pos));
  view.dispatch(tr);
  return true;
}

const key = new PluginKey("minipad-fold-blocks");
let activeView = null;

function header(pos, info) {
  const bar = document.createElement("div");
  bar.className = "fold-heading";
  bar.contentEditable = "false";
  const arrow = document.createElement("button");
  arrow.type = "button";
  arrow.className = "fold-toggle";
  arrow.title = info.closed ? "展开折叠块" : "收起折叠块";
  arrow.setAttribute("aria-expanded", String(!info.closed));
  arrow.textContent = info.closed ? "▸" : "▾";
  const title = document.createElement("button");
  title.type = "button";
  title.className = "fold-title";
  title.title = "编辑折叠块标题";
  title.textContent = info.title;
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  for (const btn of [arrow, title]) btn.addEventListener("mousedown", stop);
  arrow.addEventListener("click", (e) => {
    e.stopPropagation();
    if (activeView) setFold(activeView, pos, { closed: !info.closed });
  });
  title.addEventListener("click", async (e) => {
    e.stopPropagation();
    const renamed = await askText("折叠块标题", info.title);
    if (renamed != null && activeView) setFold(activeView, pos, { title: renamed });
  });
  bar.append(arrow, title);
  return bar;
}

function decorate(doc) {
  const parts = [];
  doc.descendants((node, pos) => {
    const info = foldInfo(node);
    if (!info) return true;
    parts.push(Decoration.node(pos, pos + node.nodeSize, {
      class: "fold-block" + (info.closed ? " fold-closed" : ""),
    }));
    parts.push(Decoration.widget(pos + 1, () => header(pos, info), {
      side: -1, key: "fold-" + pos + "-" + info.closed + "-" + info.title,
    }));
    return true;
  });
  return DecorationSet.create(doc, parts);
}

export const foldBlocks = $prose(() => new Plugin({
  key,
  state: {
    init: (_, state) => decorate(state.doc),
    apply: (tr, old) => tr.docChanged ? decorate(tr.doc) : old,
  },
  props: { decorations: (state) => key.getState(state) },
  view: (view) => {
    activeView = view;
    return {
      update(next) { activeView = next; },
      destroy() { if (activeView === view) activeView = null; },
    };
  },
}));
