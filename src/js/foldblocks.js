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

// 折叠标记段永远隐藏；收起块内的所有文本块也不能承载浏览器光标。
function invisible(state, pos) {
  const $pos = state.doc.resolve(Math.min(pos, state.doc.content.size));
  for (let depth = 1; depth <= $pos.depth; depth++) {
    const node = $pos.node(depth);
    if (node.type.name !== "blockquote" || !foldInfo(node)) continue;
    if (isClosed(state, $pos.before(depth)) || (depth < $pos.depth &&
      $pos.index(depth) === 0)) return true;
  }
  return false;
}

function visibleText(state, boundary, forward, excluded = null) {
  let result = null;
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock || invisible(state, pos + 1) ||
      (excluded && pos >= excluded[0] && pos < excluded[1])) return true;
    const start = pos + 1;
    if (forward && start >= boundary && (result == null || start < result)) result = start;
    if (!forward && pos + node.nodeSize <= boundary) result = pos + node.nodeSize - 1;
    return true;
  });
  return result;
}

// 统一的可见光标出口：优先向后找文本块；文末无可见文本时仅记录“待输入”。
// 此函数不会改变文档，因此 Ctrl+End/单击空白不会触发保存。
export function selectionAfterFold(view, boundary, tr = view.state.tr, excluded = null) {
  const state = view.state;
  const next = visibleText(state, boundary, true, excluded);
  if (next != null) return tr.setSelection(TextSelection.create(tr.doc, next)).scrollIntoView()
    .setMeta(key, { ...tr.getMeta(key), pending: false });
  const previous = visibleText(state, boundary, false, excluded);
  if (previous != null) tr.setSelection(TextSelection.create(tr.doc, previous));
  return tr.setMeta(key, { ...tr.getMeta(key), pending: true }).scrollIntoView();
}

export function safeDocumentEnd(view) {
  const state = view.state;
  const end = state.doc.content.size;
  const selection = TextSelection.near(state.doc.resolve(end), -1);
  return invisible(state, selection.from) ? selectionAfterFold(view, end)
    : state.tr.setSelection(selection).setMeta(key, { pending: false }).scrollIntoView();
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
    const title = (options.title ?? info.title).replace(/[\r\n]/g, " ").trim() || "折叠块";
    tr = tr.insertText("[!fold]" + (writtenClosed ? "-" : "+") + " " + title,
      pos + 2, pos + 2 + node.firstChild.content.size);
    // 折叠状态单独写入 Markdown，但不污染正文的 Ctrl+Z 历史。
    if (changingVisibility) tr.setMeta("addToHistory", false);
  }
  if (changingVisibility) tr.setMeta(key, { toggles: [[pos, closed]] });
  if (moved) tr = selectionAfterFold(view, pos + tr.doc.nodeAt(pos).nodeSize, tr,
    [pos, pos + node.nodeSize]);
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

function insertPending(view, value = "") {
  const { state } = view;
  const pos = state.doc.content.size;
  const content = value ? state.schema.text(value) : null;
  const tr = state.tr.insert(pos, state.schema.nodes.paragraph.create(null, content));
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + 1 + value.length))
    .setMeta(key, { pending: false }).scrollIntoView());
  return true;
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
  const blockDepth = $from.depth;
  const container = $from.node(blockDepth - 1);
  const index = $from.index(blockDepth - 1);
  const adjacent = container.maybeChild(index + (backward ? -1 : 1));
  // 第一段可见内容之前是折叠标记，禁止 joinBackward 吞掉标记。
  const quote = $from.node(blockDepth - 1);
  if (backward && foldInfo(quote) && $from.index(blockDepth - 1) === 1) return true;
  // 禁止浏览器的原生删除/ProseMirror join 命令跨过折叠块边界。
  return !!foldInfo(adjacent);
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
    init: (_, state) => ({ overrides: new Map(), deco: decorate(state.doc), pending: false }),
    apply(tr, prev, _old, state) {
      const data = tr.getMeta(key);
      if (!tr.docChanged && !data && !tr.selectionSet) return prev;
      const overrides = new Map();
      for (const [pos, closed] of prev.overrides) {
        const mapped = tr.docChanged ? tr.mapping.map(pos, 1) : pos;
        if (foldInfo(state.doc.nodeAt(mapped))) overrides.set(mapped, closed);
      }
      for (const pos of data?.open ?? []) overrides.set(pos, false);
      for (const [pos, closed] of data?.toggles ?? []) overrides.set(pos, closed);
      return { overrides, deco: decorate(state.doc, overrides),
        pending: data?.pending ?? (prev.pending && !tr.docChanged) };
    },
  },
  appendTransaction(trs, _old, state) {
    if (!trs.some((tr) => tr.docChanged || tr.selectionSet)) return null;
    if (state.selection instanceof NodeSelection || key.getState(state)?.pending) return null;
    const hidden = hiddenSelection(state);
    if (!hidden) return null;
    if (!activeView?.editable) return state.tr.setSelection(NodeSelection.create(state.doc, hidden.pos));
    return selectionAfterFold(activeView, hidden.after);
  },
  props: {
    decorations: (state) => key.getState(state)?.deco ?? null,
    handleTextInput(view, _from, _to, text) {
      return key.getState(view.state)?.pending ? insertPending(view, text) : false;
    },
    handleKeyDown(view, event) {
      const pending = key.getState(view.state)?.pending;
      if (pending && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (event.key === "Backspace" || event.key === "Delete") return true;
        if (event.key === "Enter") return insertPending(view);
        if (event.key.length === 1 && !event.isComposing) return insertPending(view, event.key);
      }
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
        const tr = selectionAfterFold(view, view.state.doc.content.size);
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
      view.dispatch(selectionAfterFold(view, view.state.doc.content.size));
      view.focus();
    };
    scroller?.addEventListener("mousedown", below);
    const resetPending = (event) => {
      if (event.target === scroller || event.target === view.dom ||
        view.dom.contains(event.target)) {
        if (key.getState(view.state)?.pending) view.dispatch(view.state.tr.setMeta(key, { pending: false }));
      }
    };
    view.dom.addEventListener("mousedown", resetPending, true);
    const guard = (e) => {
      if (key.getState(view.state)?.pending &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" ||
          e.key === "ArrowDown" || e.key === "Home" || e.key === "Escape")) {
        view.dispatch(view.state.tr.setMeta(key, { pending: false }));
      }
      if (e.isComposing || !view.editable || (e.key !== "Backspace" && e.key !== "Delete")) return;
      if (protectedBoundary(view, e)) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    view.dom.addEventListener("keydown", guard, true);
    return {
      update(next) { activeView = next; },
      destroy() {
        scroller?.removeEventListener("mousedown", below);
        view.dom.removeEventListener("mousedown", resetPending, true);
        view.dom.removeEventListener("keydown", guard, true);
        if (activeView === view) activeView = null;
      },
    };
  },
}));
