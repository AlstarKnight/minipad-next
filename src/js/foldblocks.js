// ---------- Markdown 折叠块 ----------
// 使用普通引用块保存：> [!fold]- 标题（收起），> [!fold]+ 标题（展开）。
// 只有首段匹配标记的引用块才显示折叠 UI；其他 Markdown 阅读器仍能看到全部内容。
import { $prose, Plugin, PluginKey, Decoration, DecorationSet, NodeSelection, TextSelection } from "../vendor/milkdown.js";
import { askText } from "./ui.js";

const RE = /^\[!fold\]([+-])(?: (.*))?$/;

export function foldInfo(node) {
  if (node?.type.name !== "blockquote" || node.firstChild?.type.name !== "paragraph") return null;
  const match = RE.exec(node.firstChild.textContent);
  return match ? { closed: match[1] === "-", title: match[2] || "折叠块" } : null;
}

export function newFold(schema, source = null) {
  const heading = schema.nodes.paragraph.create(null, schema.text("[!fold]+ 折叠块"));
  if (source && foldInfo(source)) return null; // 已经是折叠块，不能再嵌套一层
  if (!source) return schema.nodes.blockquote.create(null, [heading, schema.nodes.paragraph.create()]);
  // 引用转折叠保留全部子节点；普通块整体放入折叠块，不扁平化列表/表格。
  const content = source.type.name === "blockquote" && !foldInfo(source)
    ? Array.from({ length: source.childCount }, (_, i) => source.child(i)) : [source];
  return schema.nodes.blockquote.create(null, [heading, ...content]);
}

export function unfoldQuote(schema, node) {
  const children = Array.from({ length: node.childCount - 1 }, (_, i) => node.child(i + 1));
  return schema.nodes.blockquote.create(null, children.length ? children : [schema.nodes.paragraph.create()]);
}

const key = new PluginKey("minipad-fold-blocks");
let activeView = null;
let persistFolds = true;
export function setFoldPersistence(enabled) { persistFolds = enabled; }

// 临时展开仅改变插件 decoration；只读页面和查找跳转都不会修改文件。
function isClosed(state, pos, info = foldInfo(state.doc.nodeAt(pos))) {
  return key.getState(state)?.overrides.get(pos) ?? info?.closed ?? false;
}
export function foldIsClosed(view, pos) { return isClosed(view.state, pos); }

function override(view, positions) {
  if (!positions.length) return;
  view.dispatch(view.state.tr.setMeta(key, { open: positions }));
}

// 查找和目录跳转时，先把包住目标位置的折叠块展开，避免选区进入 display:none。
export function revealFolds(view, pos) {
  const $pos = view.state.doc.resolve(Math.max(0, Math.min(pos, view.state.doc.content.size)));
  const hidden = [];
  for (let depth = 1; depth <= $pos.depth; depth++) {
    const node = $pos.node(depth);
    if (node.type.name !== "blockquote") continue;
    const at = $pos.before(depth);
    if (foldInfo(node) && isClosed(view.state, at)) hidden.push(at);
  }
  override(view, hidden);
}

export function setFold(view, pos, options = {}) {
  const { state } = view;
  const node = state.doc.nodeAt(pos);
  const info = foldInfo(node);
  if (!info) return false;
  const closed = options.closed ?? isClosed(state, pos, info);
  // 查找临时展开的折叠块再次收起时，文件里本来就是收起状态，无须改文档。
  if (options.title == null && closed === info.closed) {
    view.dispatch(state.tr.setMeta(key, { toggles: [[pos, closed]] }));
    return true;
  }
  if (!view.editable || (!persistFolds && options.title == null)) {
    if (options.title != null) return false;
    view.dispatch(state.tr.setMeta(key, { toggles: [[pos, closed]] }));
    return true;
  }
  const title = (options.title ?? info.title).replace(/[\r\n]/g, " ").trim() || "折叠块";
  const first = node.firstChild;
  const from = pos + 2;
  const tr = state.tr.insertText("[!fold]" + (closed ? "-" : "+") + " " + title,
    from, from + first.content.size);
  if (closed) tr.setSelection(NodeSelection.create(tr.doc, pos));
  view.dispatch(tr);
  return true;
}

// 文档末尾的收起块之后必须有可编辑的光标位置。
// Ctrl+End、点击末尾空白和其他选区操作共享同一套修正。
export function selectionAfterFold(state, pos, tr = state.tr) {
  const at = Math.max(0, Math.min(pos, tr.doc.content.size));
  const $at = tr.doc.resolve(at);
  if ($at.parent.type.name === "doc" && !$at.nodeAfter?.isTextblock) {
    tr.insert(at, state.schema.nodes.paragraph.create());
  }
  const target = tr.doc.resolve(Math.min(at + 1, tr.doc.content.size));
  return tr.setSelection(TextSelection.near(target, 1)).scrollIntoView();
}

function hiddenSelection(state) {
  const $from = state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name !== "blockquote") continue;
    const pos = $from.before(depth);
    if (foldInfo(node) && isClosed(state, pos)) return { pos, after: pos + node.nodeSize };
  }
  return null;
}


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
    if (!activeView?.editable) return;
    const renamed = await askText("折叠块标题", info.title);
    if (renamed != null && activeView) setFold(activeView, pos, { title: renamed });
  });
  bar.append(arrow, title);
  return bar;
}

function decorate(doc, overrides = new Map()) {
  const parts = [];
  doc.descendants((node, pos) => {
    const info = foldInfo(node);
    if (!info) return true;
    const closed = overrides.get(pos) ?? info.closed;
    parts.push(Decoration.node(pos, pos + node.nodeSize, {
      class: "fold-block" + (closed ? " fold-closed" : ""),
    }));
    parts.push(Decoration.widget(pos + 1, () => header(pos, { ...info, closed }), {
      side: -1, key: "fold-" + pos + "-" + closed + "-" + info.title,
    }));
    return true;
  });
  return DecorationSet.create(doc, parts);
}

export const foldBlocks = $prose(() => new Plugin({
  key,
  state: {
    init: (_, state) => ({ overrides: new Map(), deco: decorate(state.doc) }),
    apply(tr, prev, _old, state) {
      const data = tr.getMeta(key);
      if (!tr.docChanged && !data) return prev;
      const overrides = new Map();
      for (const [pos, closed] of prev.overrides) {
        const mapped = tr.docChanged ? tr.mapping.map(pos, 1) : pos;
        if (foldInfo(state.doc.nodeAt(mapped))) overrides.set(mapped, closed);
      }
      for (const pos of data?.open ?? []) overrides.set(pos, false);
      for (const [pos, closed] of data?.toggles ?? []) overrides.set(pos, closed);
      return { overrides, deco: decorate(state.doc, overrides) };
    },
  },
  appendTransaction(trs, _old, state) {
    if (!trs.some((tr) => tr.docChanged || tr.selectionSet)) return null;
    if (state.selection instanceof NodeSelection) return null;
    const hidden = hiddenSelection(state);
    if (!hidden) return null;
    if (!activeView?.editable) return state.tr.setSelection(NodeSelection.create(state.doc, hidden.pos));
    return selectionAfterFold(state, hidden.after);
  },
  props: {
    decorations: (state) => key.getState(state)?.deco ?? null,
    handleDOMEvents: {
      mousedown(view, event) {
        if (event.button !== 0 || !view.editable || event.target !== view.dom) return false;
        const last = view.state.doc.lastChild;
        if (!foldInfo(last) || !isClosed(view.state, view.state.doc.content.size - last.nodeSize)) return false;
        const bounds = view.dom.lastElementChild?.getBoundingClientRect();
        if (!bounds || event.clientY < bounds.bottom) return false;
        event.preventDefault();
        const tr = selectionAfterFold(view.state, view.state.doc.content.size);
        view.dispatch(tr);
        view.focus();
        return true;
      },
    },
  },
  view: (view) => {
    activeView = view;
    // ProseMirror 之外的编辑区留白由滚动容器接收鼠标事件。
    const scroller = view.dom.closest("#editor");
    const below = (event) => {
      if (event.defaultPrevented || event.button !== 0 || !view.editable ||
        (event.target !== scroller && event.target !== view.dom)) return;
      const last = view.state.doc.lastChild;
      if (!foldInfo(last) || !isClosed(view.state, view.state.doc.content.size - last.nodeSize)) return;
      const bounds = view.dom.lastElementChild?.getBoundingClientRect();
      if (!bounds || event.clientY < bounds.bottom) return;
      event.preventDefault();
      view.dispatch(selectionAfterFold(view.state, view.state.doc.content.size));
      view.focus();
    };
    scroller?.addEventListener("mousedown", below);
    return {
      update(next) { activeView = next; },
      destroy() {
        scroller?.removeEventListener("mousedown", below);
        if (activeView === view) activeView = null;
      },
    };
  },
}));
