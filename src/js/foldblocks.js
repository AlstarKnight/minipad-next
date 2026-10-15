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

function invisible(state, doc, pos) {
  const $pos = doc.resolve(Math.min(pos, doc.content.size));
  for (let depth = 1; depth <= $pos.depth; depth++) {
    const node = $pos.node(depth);
    if (node.type.name !== "blockquote" || !foldInfo(node)) continue;
    if (isClosed(state, $pos.before(depth), foldInfo(node)) ||
      (depth < $pos.depth && $pos.index(depth) === 0)) return true;
  }
  return false;
}

function visibleText(state, doc, boundary, forward, excluded = null) {
  let result = null;
  doc.descendants((node, pos) => {
    if (!node.isTextblock || invisible(state, doc, pos + 1) ||
      (excluded && pos >= excluded[0] && pos < excluded[1])) return true;
    const start = pos + 1;
    if (forward && start >= boundary && (result == null || start < result)) result = start;
    if (!forward && pos + node.nodeSize <= boundary) result = pos + node.nodeSize - 1;
    return true;
  });
  return result;
}

// 所有退出隐藏内容的路径共用一个可见选区。没有可见正文时，插入临时空段落，
// 同时标记为外部更改：不触发自动保存，也不增加用户撤销历史。
export function selectionAfterFold(state, boundary, tr = state.tr, excluded = null, editable = true) {
  const doc = tr.doc;
  const next = visibleText(state, doc, boundary, true, excluded);
  if (next != null) return tr.setSelection(TextSelection.create(doc, next)).scrollIntoView();
  if (editable) {
    const at = doc.content.size;
    const navigationOnly = !tr.docChanged;
    tr.insert(at, state.schema.nodes.paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, at + 1)).scrollIntoView();
    // 收起操作自身仍需保存；纯导航生成的占位段落才标为外部更改。
    if (navigationOnly) tr.setMeta("addToHistory", false).setMeta("minipad-external", true);
    return tr;
  }
  const previous = visibleText(state, doc, boundary, false, excluded);
  if (previous != null) tr.setSelection(TextSelection.create(doc, previous));
  return tr.scrollIntoView();
}

export function safeDocumentEnd(view) {
  const state = view.state;
  const end = state.doc.content.size;
  const selection = TextSelection.near(state.doc.resolve(end), -1);
  return invisible(state, state.doc, selection.from)
    ? selectionAfterFold(state, end, state.tr, null, view.editable)
    : state.tr.setSelection(selection).scrollIntoView();
}

function selectionInside(state, pos, size) {
  return state.selection.from > pos && state.selection.from < pos + size;
}

export function setFold(view, pos, options = {}) {
  const { state } = view;
  const node = state.doc.nodeAt(pos);
  const info = foldInfo(node);
  if (!info) return false;
  const closed = options.closed ?? isClosed(state, pos, info);
  const changingVisibility = options.title == null;
  const moved = changingVisibility && closed && selectionInside(state, pos, node.nodeSize);
  let tr = state.tr;
  // 改标题不能把查找临时展开的状态写进文件。
  const writtenClosed = changingVisibility ? closed : info.closed;
  if (!view.editable || (changingVisibility && (!persistFolds || closed === info.closed))) {
    if (!changingVisibility && !view.editable) return false;
  } else {
    if (changingVisibility) {
      // 只改 +/−，手写的无标题折叠块不能凭空增加默认标题。
      tr = tr.insertText(closed ? "-" : "+", pos + 9, pos + 10);
    } else {
      const title = options.title.replace(/[\r\n]/g, " ").trim() || "折叠块";
      tr = tr.insertText("[!fold]" + (writtenClosed ? "-" : "+") + " " + title,
        pos + 2, pos + 2 + node.firstChild.content.size);
    }
    // 折叠状态单独写入 Markdown，但不污染正文的 Ctrl+Z 历史。
    if (changingVisibility) tr.setMeta("addToHistory", false);
  }
  if (changingVisibility) tr.setMeta(key, { toggles: [[pos, closed]] });
  if (moved) tr = selectionAfterFold(state, pos + tr.doc.nodeAt(pos).nodeSize, tr,
    [pos, pos + tr.doc.nodeAt(pos).nodeSize], view.editable);
  view.dispatch(tr);
  return true;
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


function protectedBoundary(view, event) {
  if (event.key !== "Backspace" && event.key !== "Delete") return false;
  try { view.domObserver?.flush(); } catch (_) {}
  const { state } = view;
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock) return false;
  const backward = event.key === "Backspace";
  if (backward && $from.parentOffset !== 0) return false;
  if (!backward && $from.parentOffset !== $from.parent.content.size) return false;
  for (let depth = $from.depth - 1; depth >= 0; depth--) {
    const parent = $from.node(depth);
    const index = $from.index(depth);
    // 折叠块第一段正文前是隐藏的标记，不能让 joinBackward 吞掉它。
    if (backward && foldInfo(parent) && index === 1) return true;
    const sibling = parent.maybeChild(index + (backward ? -1 : 1));
    if (sibling) return !!foldInfo(sibling);
  }
  return false;
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
    const tr = selectionAfterFold(state, hidden.after, state.tr, null, !!activeView?.editable);
    // 同批用户删除不可被追加的临时占位段落覆盖保存标记。
    if (trs.some((t) => t.docChanged && !t.getMeta("minipad-external"))) tr.setMeta("minipad-external", false);
    return tr;
  },
  props: {
    decorations: (state) => key.getState(state)?.deco ?? null,
    handleKeyDown(view, event) {
      return protectedBoundary(view, event);
    },
    handleDOMEvents: {
      mousedown(view, event) {
        if (event.button !== 0 || !view.editable || event.target !== view.dom) return false;
        const last = view.state.doc.lastChild;
        if (!foldInfo(last) || !isClosed(view.state, view.state.doc.content.size - last.nodeSize)) return false;
        const bounds = view.dom.lastElementChild?.getBoundingClientRect();
        if (!bounds || event.clientY < bounds.bottom) return false;
        event.preventDefault();
        const tr = selectionAfterFold(view.state, view.state.doc.content.size, view.state.tr, null, view.editable);
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
      view.dispatch(selectionAfterFold(view.state, view.state.doc.content.size, view.state.tr, null, view.editable));
      view.focus();
    };
    scroller?.addEventListener("mousedown", below);
    const guard = (e) => {
      if (e.isComposing || !view.editable || (e.key !== "Backspace" && e.key !== "Delete")) return;
      if (protectedBoundary(view, e)) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    view.dom.addEventListener("keydown", guard, true);
    return {
      update(next) { activeView = next; },
      destroy() {
        scroller?.removeEventListener("mousedown", below);
        view.dom.removeEventListener("keydown", guard, true);
        if (activeView === view) activeView = null;
      },
    };
  },
}));
