// ---------- 顶层 Markdown 块的菜单与拖放 ----------
// 直接操作 ProseMirror 节点；笔记仍用原有 Markdown 读写，不另存块结构。
import { $prose, Plugin, TextSelection, closeHistory } from "../vendor/milkdown.js";
import { openMenu, toast } from "./ui.js";
import { foldInfo, foldIsClosed, newFold, unfoldQuote, setFold } from "./foldblocks.js";
import { blockLocation, moveNested, changeNested, listLevel } from "./nestedblocks.js";
import { tableItems } from "./tableblocks.js";
import { codeLines, plainText, COPY_CODE_ORIGIN } from "./toolbar.js";


let blockEnabled = true;
let contextMode = "system";
export function applyBlockSettings(settings) {
  blockEnabled = settings.block_enabled !== false;
  contextMode = settings.block_context_menu === "block" ? "block" : "system";
  document.querySelector("#main")?.setAttribute("data-blocks", blockEnabled ? "on" : "off");
  if (!blockEnabled) document.querySelector(".block-handle")?.setAttribute("hidden", "");
}

const TYPES = [
  ["paragraph", "正文"], ["heading1", "标题 1"], ["heading2", "标题 2"],
  ["heading3", "标题 3"], ["heading4", "标题 4"], ["blockquote", "引用"],
  ["bullet_list", "无序列表"], ["ordered_list", "编号列表"],
  ["code_block", "代码块"], ["copytext", "复制文本"], ["hr", "分隔线"], ["table", "表格"], ["fold", "折叠块"],
];

function blockAt(doc, index) {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos;
}

function makeBlock(schema, kind, source = null) {
  // 块菜单与格式栏遵循相同的无损转换规则，保留段内换行与无语言代码块来源。
  if (kind === "copytext" && source &&
    (!["paragraph", "code_block"].includes(source.type.name) || !plainText(source) ||
      (source.type.name === "code_block" && source.attrs.language))) return null;
  if (kind === "hr" && source && source.type.name !== "hr" &&
    (source.type.name !== "paragraph" || source.content.size)) return null;
  // 同类型转换不重建代码块，保留语言、标题和全部原文。
  // 复制文本块转代码块：去掉 copy 语言和来源标记，变成普通代码块
  if (kind === "code_block" && source?.type.name === "code_block")
    return source.attrs.language === "copy" ? source.type.create({ ...source.attrs, language: "", title: "" }, source.content) : source;
  if (kind === "fold") return newFold(schema, source);
  if (foldInfo(source)) {
    if (kind === "blockquote") return unfoldQuote(schema, source);
    const children = Array.from({ length: source.childCount }, (_, i) => source.child(i)).slice(1);
    if (children.length !== 1) return null; // 多个子块不能压扁成一段文字
    source = children[0];
  }
  if (source?.type.name === "table" && kind !== "table") return null;
  if (source?.type.name === "blockquote") {
    if (kind === "blockquote") return source;
    if (source.childCount !== 1) return null;
    source = source.firstChild;
  }
  if (kind === "table") {
    if (source) return null; // 防止转换时丢失原文
    const row = (type) => schema.nodes[type === "table_header" ? "table_header_row" : "table_row"].create(null,
      [0, 1, 2].map(() => schema.nodes[type].create(null, schema.nodes.paragraph.create())));
    return schema.nodes.table.create(null, [row("table_header"), row("table_cell"), row("table_cell")]);
  }
  if (source?.type.name === "bullet_list" || source?.type.name === "ordered_list") {
    if (kind === "bullet_list" || kind === "ordered_list") return schema.nodes[kind].create(null, source.content);
    if (source.childCount !== 1 || source.firstChild.childCount !== 1) return null;
    source = source.firstChild.firstChild;
  }
  if (kind === "blockquote" && source) return schema.nodes.blockquote.create(null, [source]);
  // 复制文本末尾空行无法在正文 Markdown 中稳定保存；块菜单也必须拒绝这种转换。
  // 放在拆开引用、折叠块之后，外层只包着一个复制文本块时也拦得住。
  if (source?.type.name === "code_block" && source.attrs.language === "copy" &&
    source.textContent.endsWith("\n") && kind !== "code_block") return null;
  // 代码块无法存储富文本标记。拒绝会丢链接、颜色、标题等格式的转换。
  if (kind === "code_block" && source &&
    (source.type.name !== "paragraph" ||
      (source.content.size && !plainText(source)))) return null;
  const text = source ? source.textBetween(0, source.content.size, "\n", "\n") : "";
  const content = source && ["paragraph", "heading"].includes(source.type.name)
    ? source.content : source?.type.spec.code
      ? codeLines(schema, text) : text ? [schema.text(text)] : null;
  const paragraph = () => schema.nodes.paragraph.create(null, content);
  if (kind.startsWith("heading")) return schema.nodes.heading.create({ level: Number(kind.slice(-1)) }, content);
  if (kind === "paragraph") return paragraph();
  if (kind === "code_block" || kind === "copytext") {
    const sourceCode = source?.type.name === "code_block";
    const attrs = kind === "copytext" ? { language: "copy", title: sourceCode ? COPY_CODE_ORIGIN : "" } : null;
    // 和格式栏一样：段落末尾的换行存不进 Markdown，转成复制文本时去掉
    const body = kind === "copytext" && !sourceCode ? text.replace(/\n+$/, "") : text;
    return schema.nodes.code_block.create(attrs, body ? schema.text(body) : null);
  }
  if (kind === "blockquote") return schema.nodes.blockquote.create(null, paragraph());
  if (kind === "bullet_list" || kind === "ordered_list") {
    return schema.nodes[kind].create(null, schema.nodes.list_item.create(null, paragraph()));
  }
  if (kind === "hr") return schema.nodes.hr.create();
  return null;
}

class BlockHandles {
  constructor(view) {
    this.view = view;
    this.host = document.getElementById("main");
    this.scroller = document.getElementById("editor");
    this.index = -1;
    this.dragging = -1;
    this.pointerDown = false;
    this.dropIndex = -1;
    this.activeLoc = null;
    this.cellLoc = null;
    this.draggingLoc = null;
    this.dropLoc = null;
    this.handle = document.createElement("button");
    this.handle.type = "button";
    this.handle.className = "block-handle";
    this.handle.textContent = "⠿";
    this.handle.title = "拖动块；点击或右键管理块";
    this.handle.setAttribute("aria-label", "管理当前块");
    this.handle.draggable = true;
    this.handle.hidden = true;
    this.marker = document.createElement("div");
    this.marker.className = "block-drop-line";
    this.marker.hidden = true;
    this.host.append(this.handle, this.marker);

    this.onMove = (e) => {
      if (!blockEnabled || this.dragging !== -1 || this.pointerDown) return;
      const index = this.indexOf(e.target);
      const loc = blockLocation(this.view, e.target);
      const cell = e.target.closest?.("td,th");
      if (cell) this.cellLoc = this.cellPosition(cell);
      else if (loc?.node.type.name !== "table") this.cellLoc = null;
      this.show(index, loc);
    };
    this.onLeave = (e) => {
      if (this.dragging === -1 && !this.pointerDown && e.relatedTarget !== this.handle) this.show(-1);
    };
    // 按住手柄到 dragstart 之间保留 DOM，否则浏览器会取消拖动。
    this.onPress = (e) => { if (e.button === 0) this.pointerDown = true; };
    this.onRelease = () => { this.pointerDown = false; };
    this.onContext = (e) => {
      if (!blockEnabled || contextMode !== "block" || e.shiftKey || e.target.closest?.("input, textarea")) return;
      if (!this.view.state.selection.empty) return; // 有文字选区时保留系统剪切/复制菜单
      const index = this.indexOf(e.target);
      const loc = blockLocation(this.view, e.target);
      if (!loc || !this.view.editable) return;
      e.preventDefault();
      this.show(index, loc);
      const cell = e.target.closest?.("td,th");
      const { row, col } = cell ? this.cellPosition(cell) : { row: null, col: null };
      if (loc.parent.type.name === "doc") this.menu(index, e.clientX, e.clientY, row, col);
      else this.menuNested(loc, e.clientX, e.clientY, row, col);
    };
    this.onScroll = () => this.position();
    this.onStart = (e) => {
      if (!blockEnabled || this.index < 0 || !this.view.editable) return;
      this.pointerDown = false;
      this.dragging = this.index >= 0 && this.activeLoc?.parent.type.name === "doc" ? this.index : -2;
      this.draggingLoc = this.activeLoc;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", "minipad-block");
    };
    this.onOver = (e) => {
      if (!blockEnabled || this.dragging === -1) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      e.dataTransfer.dropEffect = "move";
      const index = this.indexOf(e.target);
      const loc = blockLocation(this.view, e.target);
      const inside = !!e.target.closest?.(".fold-heading");
      if (loc && (inside || loc.parent.type.name !== "doc" || this.draggingLoc?.parent.type.name !== "doc")) {
        const rect = loc.el.getBoundingClientRect();
        this.dropLoc = { loc, after: e.clientY >= rect.top + rect.height / 2, inside };
        this.dropIndex = -1;
      } else {
        this.dropLoc = null;
        if (index < 0) this.dropIndex = this.view.state.doc.childCount;
        else {
          const rect = this.view.dom.children[index].getBoundingClientRect();
          this.dropIndex = index + (e.clientY >= rect.top + rect.height / 2 ? 1 : 0);
        }
      }
      this.marker.hidden = false;
      this.positionMarker();
    };
    this.onDrop = (e) => {
      if (this.dragging === -1) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const from = this.dragging;
      const to = this.dropIndex;
      const source = this.draggingLoc;
      const nested = this.dropLoc;
      this.finishDrag();
      if (nested) {
        if (!moveNested(this.view, source, nested.loc, nested.after, nested.inside)) toast("不能把这个块移动到该位置");
      } else if (from >= 0) this.move(from, to);
    };
    this.onEnd = () => this.finishDrag();
    this.handle.addEventListener("click", () => {
      if (!blockEnabled || !this.activeLoc) return;
      const rect = this.handle.getBoundingClientRect();
      const cell = this.activeLoc.node.type.name === "table" ? this.cellLoc : null;
      if (this.activeLoc.parent.type.name === "doc") this.menu(this.index, rect.right, rect.bottom, cell?.row, cell?.col);
      else this.menuNested(this.activeLoc, rect.right, rect.bottom, cell?.row, cell?.col);
    });
    this.handle.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.handle.click();
    });
    this.handle.addEventListener("mousedown", this.onPress);
    document.addEventListener("mouseup", this.onRelease);
    this.handle.addEventListener("dragstart", this.onStart);
    this.handle.addEventListener("dragend", this.onEnd);
    this.view.dom.addEventListener("mousemove", this.onMove);
    this.view.dom.addEventListener("mouseleave", this.onLeave);
    this.view.dom.addEventListener("contextmenu", this.onContext);
    // 捕获自有手柄的 drop，阻止 ProseMirror 将拖放携带的文本粘贴进文档。
    this.view.dom.addEventListener("dragover", this.onOver, true);
    this.view.dom.addEventListener("drop", this.onDrop, true);
    this.scroller.addEventListener("scroll", this.onScroll);
    this.handle.addEventListener("mouseleave", this.onLeave);
  }

  cellPosition(cell) {
    const table = cell.closest("table");
    return {
      row: Array.prototype.indexOf.call(table.querySelectorAll("tr"), cell.closest("tr")),
      col: Array.prototype.indexOf.call(cell.parentElement.children, cell),
    };
  }

  indexOf(target) {
    let el = target instanceof Element ? target : target?.parentElement;
    while (el && el.parentElement !== this.view.dom) el = el.parentElement;
    if (!el || el.parentElement !== this.view.dom) return -1;
    const index = Array.prototype.indexOf.call(this.view.dom.children, el);
    return index < this.view.state.doc.childCount ? index : -1;
  }

  show(index, loc = null) {
    this.index = index;
    this.activeLoc = loc;
    this.position();
  }

  position() {
    if (!blockEnabled || !this.activeLoc || !this.view.editable) {
      this.handle.hidden = true;
      return;
    }
    const el = this.activeLoc.el;
    if (!el) { this.handle.hidden = true; return; }
    const rect = el.getBoundingClientRect();
    const host = this.host.getBoundingClientRect();
    if (rect.bottom <= host.top || rect.top >= host.bottom) { this.handle.hidden = true; return; }
    this.handle.style.top = Math.max(0, rect.top - host.top + 2) + "px";
    // 列表项的勾选框位于左侧约 20px；拖动柄再向左挪，避免挡住任务方框。
    const side = this.host.dataset.olSide === "left" ? 12 : 0;
    this.handle.style.left = Math.max(2, rect.left - host.left - (this.activeLoc.node.type.name === "list_item" ? 54 : 27) + side) + "px";
    this.handle.hidden = false;
  }

  positionMarker() {
    if (this.dropLoc) {
      const { loc, after, inside } = this.dropLoc;
      const rect = loc.el.getBoundingClientRect();
      const host = this.host.getBoundingClientRect();
      const y = inside ? rect.bottom - 8 : after ? rect.bottom : rect.top;
      this.marker.style.top = y - host.top + "px";
      this.marker.style.left = Math.max(4, rect.left - host.left + (inside ? 18 : 0)) + "px";
      this.marker.style.width = Math.max(20, Math.min(rect.width - (inside ? 18 : 0), host.width - 45)) + "px";
      return;
    }
    const index = this.dropIndex;
    if (index < 0) return;
    const el = this.view.dom.children[Math.min(index, this.view.state.doc.childCount - 1)];
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const host = this.host.getBoundingClientRect();
    const y = index === this.view.state.doc.childCount ? rect.bottom : rect.top;
    this.marker.style.top = y - host.top + "px";
    this.marker.style.left = Math.max(4, rect.left - host.left) + "px";
    this.marker.style.width = Math.max(20, Math.min(rect.width, host.width - 45)) + "px";
  }

  finishDrag() {
    this.dragging = -1;
    this.draggingLoc = null;
    this.dropLoc = null;
    this.dropIndex = -1;
    this.marker.hidden = true;
  }

  // to 为原文档的块边界索引；移走来源后修正落点。
  move(from, to) {
    const { state } = this.view;
    if (!this.view.editable || from < 0 || to < 0 || from >= state.doc.childCount ||
      to > state.doc.childCount || to === from || to === from + 1) return;
    const node = state.doc.child(from);
    const start = blockAt(state.doc, from);
    const boundary = blockAt(state.doc, to);
    const tr = closeHistory(state.tr).delete(start, start + node.nodeSize);
    const at = boundary - (to > from ? node.nodeSize : 0);
    tr.insert(at, node);
    this.view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1))).scrollIntoView());
    this.view.focus();
    this.show(-1);
  }

  change(index, action, kind) {
    const { state } = this.view;
    if (!this.view.editable || index < 0 || index >= state.doc.childCount) return;
    const node = state.doc.child(index);
    const start = blockAt(state.doc, index);
    const end = start + node.nodeSize;
    let tr = closeHistory(state.tr);
    let at = start;
    if (action === "insert-before" || action === "insert-after") {
      const added = makeBlock(state.schema, kind);
      if (!added) return;
      at = action === "insert-before" ? start : end;
      tr = tr.insert(at, added);
    } else if (action === "convert") {
      const replacement = makeBlock(state.schema, kind, node);
      if (!replacement) return;
      tr = tr.replaceWith(start, end, replacement);
    } else if (action === "duplicate") {
      at = end;
      tr = tr.insert(at, node);
    } else if (action === "delete") {
      if (state.doc.childCount === 1) tr = tr.replaceWith(start, end, state.schema.nodes.paragraph.create());
      else tr = tr.delete(start, end);
      at = Math.min(start, tr.doc.content.size);
    }
    if (!tr.docChanged) return;
    this.view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(at + 1, tr.doc.content.size)))).scrollIntoView());
    this.view.focus();
    this.show(-1);
  }

  menu(index, x, y, row = null, col = null) {
    if (!blockEnabled) return;
    x = Math.max(4, Math.min(x, window.innerWidth - 190));
    y = Math.max(4, Math.min(y, window.innerHeight - 340));
    const node = this.view.state.doc.child(index);
    if (!node || !this.view.editable) return;
    const types = (action) => openMenu(TYPES.map(([kind, name]) => ({
      id: "block-type-" + kind, label: name,
      disabled: action === "convert" && !makeBlock(this.view.state.schema, kind, node),
      act: () => this.change(index, action, kind),
    })), x, y);
    openMenu([
      { id: "block-insert-before", label: "在上方插入块 ›", act: () => types("insert-before") },
      { id: "block-insert-after", label: "在下方插入块 ›", act: () => types("insert-after") },
      { id: "block-convert", label: "转换块类型 ›", act: () => types("convert") },
      ...(foldInfo(node) ? [{ id: "block-fold-toggle", label: foldIsClosed(this.view, blockAt(this.view.state.doc, index)) ? "展开折叠块" : "收起折叠块", act: () => setFold(this.view, blockAt(this.view.state.doc, index), { closed: !foldIsClosed(this.view, blockAt(this.view.state.doc, index)) }) }] : []),
      { id: "block-up", label: "上移一块", disabled: index === 0, act: () => this.move(index, index - 1) },
      { id: "block-down", label: "下移一块", disabled: index === this.view.state.doc.childCount - 1, act: () => this.move(index, index + 2) },
      { id: "block-duplicate", label: "创建副本", act: () => this.change(index, "duplicate") },
      { id: "block-delete", label: "删除块", danger: true, act: () => this.change(index, "delete") },
      ...tableItems(this.view, blockAt(this.view.state.doc, index), row, col),
    ], x, y);
  }


  menuNested(loc, x, y, row = null, col = null) {
    if (!blockEnabled) return;
    const { state } = this.view;
    const node = state.doc.nodeAt(loc.pos);
    if (!node || !this.view.editable) return;
    const listItem = node.type.name === "list_item";
    const siblings = loc.parent;
    // 只有一个列表项时，转换的是整个列表；不能丢掉这项的正文。
    const singleItemList = listItem && siblings.childCount === 1;
    const convert = (action) => {
      const wholeList = singleItemList && action === "convert";
      const source = wholeList ? parentLoc?.node : node;
      const choices = listItem && !wholeList ? [["list_item", "列表项"]] : TYPES;
      openMenu(choices.map(([kind, name]) => ({
        id: "block-type-" + kind, label: name,
        disabled: action === "convert" && (!source || !makeBlock(this.view.state.schema, kind, source)),
        act: () => {
          const done = wholeList
            ? parentLoc.parent.type.name === "doc"
              ? (this.change(parentLoc.index, "convert", kind), true)
              : changeNested(this.view, parentLoc, "convert", kind, makeBlock)
            : changeNested(this.view, loc, action, kind, makeBlock);
          if (!done) toast("此位置不能执行该块操作");
          this.show(-1);
        },
      })), x, y);
    };
    const siblingLoc = (index) => {
      if (index < 0 || index >= siblings.childCount) return null;
      let pos = loc.pos;
      if (index < loc.index) for (let k = index; k < loc.index; k++) pos -= siblings.child(k).nodeSize;
      else for (let k = loc.index; k < index; k++) pos += siblings.child(k).nodeSize;
      const $at = state.doc.resolve(pos);
      return { pos, node: state.doc.nodeAt(pos), parent: $at.parent, parentPos: $at.depth ? $at.before() : null,
        index, el: this.view.nodeDOM(pos) };
    };
    const parentLoc = loc.parentPos == null ? null : (() => {
      const pos = loc.parentPos;
      const $at = state.doc.resolve(pos);
      return { pos, node: state.doc.nodeAt(pos), parent: $at.parent, parentPos: $at.depth ? $at.before() : null,
        index: $at.index(), el: this.view.nodeDOM(pos) };
    })();
    const prev = siblingLoc(loc.index - 1);
    const $loc = state.doc.resolve(loc.pos);
    let outerQuote = null;
    for (let depth = $loc.depth; depth > 0; depth--) {
      if ($loc.node(depth).type.name !== "blockquote") continue;
      const pos = $loc.before(depth);
      const $outer = state.doc.resolve(pos);
      outerQuote = { pos, node: state.doc.nodeAt(pos), parent: $outer.parent,
        parentPos: $outer.depth ? $outer.before() : null, index: $outer.index(), el: this.view.nodeDOM(pos) };
      break;
    }
    const lift = () => {
      const okay = listItem ? listLevel(this.view, loc, true)
        : parentLoc && moveNested(this.view, loc, parentLoc, true);
      if (!okay) toast("不能将此块提升一层");
    };
    const indent = () => {
      const okay = listItem ? listLevel(this.view, loc, false)
        : prev?.node.type.name === "blockquote" && moveNested(this.view, loc, prev, true, true);
      if (!okay) toast("上一个块不是可嵌套的引用或折叠块");
    };
    openMenu([
      { id: "block-insert-before", label: "在上方插入块 ›", act: () => convert("insert-before") },
      { id: "block-insert-after", label: "在下方插入块 ›", act: () => convert("insert-after") },
      { id: "block-convert", label: "转换块类型 ›", disabled: listItem && !singleItemList, act: () => convert("convert") },
      ...(outerQuote ? [{ id: "block-outer", label: "管理外层引用／折叠块 ›", act: () => {
        if (outerQuote.parent.type.name === "doc") this.menu(outerQuote.index, x, y);
        else this.menuNested(outerQuote, x, y);
      } }] : []),
      { id: "block-up", label: "在当前层级上移", disabled: loc.index === 0, act: () => {
        if (!moveNested(this.view, loc, siblingLoc(loc.index - 1), false)) toast("不能上移此块");
      } },
      { id: "block-down", label: "在当前层级下移", disabled: loc.index === siblings.childCount - 1, act: () => {
        if (!moveNested(this.view, loc, siblingLoc(loc.index + 1), true)) toast("不能下移此块");
      } },
      { id: "block-indent", label: "缩进／移入上一块", disabled: !listItem && prev?.node.type.name !== "blockquote", act: indent },
      { id: "block-outdent", label: "减少缩进／提升一层", disabled: !parentLoc, act: lift },
      { id: "block-duplicate", label: "创建副本", act: () => {
        if (!changeNested(this.view, loc, "duplicate", null, makeBlock)) toast("不能复制此块");
      } },
      { id: "block-delete", label: "删除块", danger: true, act: () => {
        if (!changeNested(this.view, loc, "delete", null, makeBlock)) toast("不能删除此块");
      } },
      ...tableItems(this.view, loc.pos, row, col),
    ], Math.max(4, Math.min(x, window.innerWidth - 205)),
      Math.max(4, Math.min(y, window.innerHeight - 340)));
  }

  update(view, previous) {
    this.view = view;
    if (previous.doc !== view.state.doc) this.show(-1);
    else this.position();
  }

  destroy() {
    this.finishDrag();
    this.handle.removeEventListener("mousedown", this.onPress);
    document.removeEventListener("mouseup", this.onRelease);
    this.view.dom.removeEventListener("mousemove", this.onMove);
    this.view.dom.removeEventListener("mouseleave", this.onLeave);
    this.view.dom.removeEventListener("contextmenu", this.onContext);
    this.view.dom.removeEventListener("dragover", this.onOver, true);
    this.view.dom.removeEventListener("drop", this.onDrop, true);
    this.scroller.removeEventListener("scroll", this.onScroll);
    this.handle.remove();
    this.marker.remove();
  }
}

export const blockManager = $prose(() => new Plugin({ view: (view) => new BlockHandles(view) }));
