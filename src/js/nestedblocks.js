// ---------- 嵌套 Markdown 块的定位与跨层级移动 ----------
// 支持引用/折叠块内的子块、列表项、顶层块之间移动，所有变动仍由 ProseMirror 验证 schema。
import { TextSelection, closeHistory, sinkListItem, liftListItem } from "../vendor/milkdown.js";

const LISTS = ["bullet_list", "ordered_list"];
const BLOCK = "p,h1,h2,h3,h4,h5,h6,blockquote,ul,ol,li,.codeblock,hr,table";

export function blockLocation(view, target) {
  if (!(target instanceof Element)) target = target?.parentElement;
  if (!target || !view.dom.contains(target)) return null;
  let el = target.closest(".fold-heading")?.closest("blockquote.fold-block");
  // 列表项优先于里面的段落，拖动时连同其子列表一起移动。
  el ||= target.closest("li");
  // 表格由整体手柄移动；单元格通过独立行列菜单处理。
  el ||= target.closest("table");
  el ||= target.closest(BLOCK);
  if (!el || !view.dom.contains(el)) return null;
  let boundary;
  try { boundary = view.posAtDOM(el, 0); } catch (_) { return null; }
  const doc = view.state.doc;
  const $point = doc.resolve(Math.max(0, Math.min(boundary, doc.content.size)));
  let pos = -1;
  // Textblock 容器内部是 pos+1，叶子块边界可能就是 pos。
  for (let depth = $point.depth; depth > 0; depth--) {
    const candidate = $point.before(depth);
    if (view.nodeDOM(candidate) === el) { pos = candidate; break; }
  }
  if (pos < 0) {
    for (const guess of [boundary, boundary - 1]) {
      if (guess >= 0 && doc.nodeAt(guess) && view.nodeDOM(guess) === el) {
        pos = guess;
        break;
      }
    }
  }
  if (pos < 0) return null;
  const $at = doc.resolve(pos);
  const node = doc.nodeAt(pos);
  if (!node) return null;
  return { el, node, pos, parent: $at.parent, parentPos: $at.depth ? $at.before() : null,
    index: $at.index() };
}

function safeSelection(doc, pos) {
  return TextSelection.near(doc.resolve(Math.max(0, Math.min(pos, doc.content.size))));
}

export function changeNested(view, loc, action, kind, makeBlock) {
  const state = view.state;
  const node = state.doc.nodeAt(loc.pos);
  if (!view.editable || !node) return false;
  const $at = state.doc.resolve(loc.pos);
  const parent = $at.parent;
  const pos = loc.pos;
  const end = pos + node.nodeSize;
  let at = pos;
  const tr = closeHistory(state.tr);
  try {
    if (action === "insert-before" || action === "insert-after") {
      let added = parent.type.name === "bullet_list" || parent.type.name === "ordered_list"
        ? state.schema.nodes.list_item.create(null, state.schema.nodes.paragraph.create())
        : makeBlock(state.schema, kind);
      if (!added) return false;
      at = action === "insert-before" ? pos : end;
      const $to = state.doc.resolve(at);
      if (!$to.parent.canReplaceWith($to.index(), $to.index(), added.type)) return false;
      tr.insert(at, added);
    } else if (action === "convert") {
      const replacement = makeBlock(state.schema, kind, node);
      if (!replacement || !parent.canReplaceWith($at.index(), $at.index() + 1, replacement.type)) return false;
      tr.replaceWith(pos, end, replacement);
    } else if (action === "duplicate") {
      at = end;
      tr.insert(at, node);
    } else if (action === "delete") {
      if (parent.childCount === 1 && LISTS.includes(parent.type.name) && loc.parentPos != null) {
        at = loc.parentPos;
        tr.delete(at, at + parent.nodeSize);
      } else if (parent.childCount === 1 && parent.type.name !== "doc") {
        tr.replaceWith(pos, end, state.schema.nodes.paragraph.create());
      } else {
        tr.delete(pos, end);
      }
    } else return false;
    if (!tr.docChanged) return false;
    view.dispatch(tr.setSelection(safeSelection(tr.doc, at + 1)).scrollIntoView());
    view.focus();
    return true;
  } catch (_) { return false; }
}

// 在现有父节点内交换顺序，或在引用/折叠块/列表/正文之间跨层级移动。
export function moveNested(view, source, target, after = true, inside = false) {
  const { state } = view;
  if (!view.editable || !source || !target) return false;
  const node = state.doc.nodeAt(source.pos);
  const targetNode = state.doc.nodeAt(target.pos);
  if (!node || !targetNode) return false;
  if (source.pos === target.pos && !inside) return false;
  const dstParent = inside ? targetNode : target.parent;
  if (inside && !["blockquote", "list_item", "table_cell", "table_header"].includes(dstParent.type.name)) return false;
  let destination = inside ? target.pos + targetNode.nodeSize - 1
    : target.pos + (after ? targetNode.nodeSize : 0);
  if (destination >= source.pos && destination <= source.pos + node.nodeSize) return false;
  if (source.parent === dstParent && !inside &&
    (destination === source.pos || destination === source.pos + node.nodeSize)) return false;

  let moved = node;
  const oldList = LISTS.includes(source.parent.type.name);
  const newList = LISTS.includes(dstParent.type.name);
  if (newList && node.type.name !== "list_item") {
    if (LISTS.includes(node.type.name) || node.type.name === "table") return false;
    moved = state.schema.nodes.list_item.create(null, node.type.name === "paragraph"
      ? [node] : [state.schema.nodes.paragraph.create(), node]);
  } else if (!newList && node.type.name === "list_item") {
    moved = source.parent.type.create(source.parent.attrs, node);
  }

  const tr = closeHistory(state.tr);
  try {
    if (oldList && source.parent.childCount === 1 && source.parentPos != null) {
      tr.delete(source.parentPos, source.parentPos + source.parent.nodeSize);
    } else if (source.parent.childCount === 1 && source.parent.type.name !== "doc") {
      tr.replaceWith(source.pos, source.pos + node.nodeSize, state.schema.nodes.paragraph.create());
    } else {
      tr.delete(source.pos, source.pos + node.nodeSize);
    }
    destination = tr.mapping.map(destination, -1);
    const $dest = tr.doc.resolve(destination);
    if (!$dest.parent.canReplaceWith($dest.index(), $dest.index(), moved.type)) return false;
    tr.insert(destination, moved);
    view.dispatch(tr.setSelection(safeSelection(tr.doc, destination + 1)).scrollIntoView());
    view.focus();
    return true;
  } catch (_) { return false; }
}

// 列表项的缩进与提升直接复用 schema-list 命令，以保护嵌套列表及任务属性。
export function listLevel(view, loc, outward) {
  if (!LISTS.includes(loc.parent.type.name) || !view.editable) return false;
  const { state } = view;
  const selection = safeSelection(state.doc, loc.pos + 2);
  const next = state.apply(state.tr.setSelection(selection));
  const command = outward ? liftListItem(next.schema.nodes.list_item) : sinkListItem(next.schema.nodes.list_item);
  let changed = null;
  if (!command(next, (tr) => { changed = tr; })) return false;
  if (changed) view.dispatch(changed);
  view.focus();
  return true;
}
